import EventEmitter from 'events';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Logger } from 'homebridge';
import TuyaDevice from '../TuyaDevice';
import TuyaDeviceManager from '../TuyaDeviceManager';
import { isFastWarmThermostat } from '../profile/FastWarmThermostat';
import { collectFastWarmSchedule, FastWarmScheduleState } from './FastWarmSchedule';
import FastWarmScheduleManager, { FastWarmScheduleSnapshot } from './FastWarmScheduleManager';
import {
  createThermostatProfilesState, prepareThermostatProfileApply, reduceThermostatProfiles, restoreThermostatProfilesState,
  ThermostatProfileApplyPlan, ThermostatProfileId, ThermostatProfilesAction, ThermostatProfilesState, ThermostatWeeklyProgramme,
  validateThermostatWeeklyProgramme,
} from './ThermostatProfiles';
import ThermostatRuntimeServer from './ThermostatRuntimeServer';

type ScheduleTransport = Pick<FastWarmScheduleManager, 'read' | 'apply' | 'activateProgramme' | 'close'>;
type Job = { status: string; error?: string; requestedProfile?: ThermostatProfileId; completedAt?: number };
interface PreviewPlan {
  id: string;
  expiresAt: number;
  devices: { id: string; name: string; profile: ThermostatProfileId; changes: number;
    programme: ThermostatWeeklyProgramme; baselineFingerprint: string; }[];
}

function profileId(value: unknown): ThermostatProfileId {
  if (value !== 'home' && value !== 'away' && value !== 'holiday') {
    throw new Error('Choose the Home, Away or Holiday programme.');
  }
  return value;
}

function stateFor(programme: ThermostatWeeklyProgramme): FastWarmScheduleState {
  return collectFastWarmSchedule(programme.days.map(day => ({ packet: { dayMask: day.day, events: day.events } })));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** One long-lived owner of profiles, jobs and the existing authenticated Tuya session. */
export default class ThermostatRuntime extends EventEmitter {
  public state: ThermostatProfilesState = createThermostatProfilesState();
  private schedules: ScheduleTransport;
  private snapshots = new Map<string, FastWarmScheduleSnapshot>();
  private nativeSettings = new Map<string, { mode?: string; grouping?: number }>();
  private jobs = new Map<string, Job>();
  private running = new Map<string, Promise<void>>();
  private pending = new Map<string, ThermostatProfileId>();
  private previews = new Map<string, PreviewPlan>();
  private persistence: Promise<void> = Promise.resolve();
  private stateTransactions: Promise<void> = Promise.resolve();
  private server: ThermostatRuntimeServer;
  private closed = false;
  private file: string;

  constructor(
    public manager: TuyaDeviceManager,
    persistPath: string,
    public instanceId: string,
    private log: Pick<Logger, 'warn'>,
    transport?: ScheduleTransport,
  ) {
    super();
    this.schedules = transport ?? new FastWarmScheduleManager(manager.api, manager.mq, id => manager.getDevice(id));
    this.file = path.join(persistPath, `TuyaThermostatProfiles.${instanceId}.json`);
    this.server = new ThermostatRuntimeServer(persistPath, instanceId, this.handle);
  }

  static instanceId(configuration: unknown): string {
    return createHash('sha256').update(JSON.stringify(configuration)).digest('hex').slice(0, 16);
  }

  async start(publishServer = true): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1) {
        throw new Error('Unsupported thermostat profiles file version.');
      }
      this.state = restoreThermostatProfilesState(saved.profiles);
      for (const [id, device] of Object.entries(saved.profiles.devices) as [string, { inFlight?: unknown }][]) {
        if (device.inFlight) {
          this.jobs.set(id, { status: 'partial', error: 'A previous upload was interrupted. Read the thermostat before applying again.' });
        }
      }
      for (const snapshot of saved.snapshots ?? []) {
        if (typeof snapshot.deviceId === 'string' && snapshot.state?.days && Number.isFinite(snapshot.finishedAt)) {
          this.snapshots.set(snapshot.deviceId, snapshot);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    for (const device of this.devices()) {
      this.state = reduceThermostatProfiles(this.state, { type: 'register-device', deviceId: device.id });
    }
    if (publishServer) {
      await this.server.start();
    }
    // Restoring intent and cached programmes never triggers cloud commands.
    this.emit('change');
  }

  devices() {
    return this.manager.devices.filter(isFastWarmThermostat);
  }

  view() {
    return {
      instanceId: this.instanceId,
      thermostats: this.devices().map(device => {
        const profiles = this.state.devices[device.id];
        const snapshot = this.snapshots.get(device.id);
        const current = device.status.find(status => status.code === 'temp_current')?.value;
        const target = device.status.find(status => status.code === 'temp_set')?.value;
        return {
          id: device.id, name: device.name, online: device.online,
          currentTemperature: this.celsius(device) && typeof current === 'number' ? current / 10 : undefined,
          targetTemperature: this.celsius(device) && typeof target === 'number' ? target / 10 : undefined,
          mode: this.nativeSettings.get(device.id)?.mode,
          grouping: this.nativeSettings.get(device.id)?.grouping,
          lastUpdated: snapshot?.finishedAt,
          schedule: snapshot?.state,
          scheduleFingerprint: snapshot?.fingerprint ?? undefined,
          profiles: profiles?.programmes ?? {},
          enabled: this.state.enabledDeviceIds.includes(device.id),
          sync: {
            status: this.jobs.get(device.id)?.status === 'verified' && profiles?.status === 'pending'
              ? 'pending' : this.jobs.get(device.id)?.status ?? profiles?.status ?? 'idle',
            requestedProfile: profiles?.requestedProfile,
            confirmedProfile: profiles?.confirmedProfile,
            error: this.jobs.get(device.id)?.error ?? profiles?.error,
          },
        };
      }),
      presence: { home: this.state.anyoneHome },
      holiday: { active: this.state.holiday },
    };
  }

  async close() {
    this.closed = true;
    this.pending.clear();
    this.schedules.close();
    await Promise.allSettled([...this.running.values()]);
    await this.stateTransactions;
    await this.persistence;
    await this.server.close();
  }

  handle = async (route: string, body: Record<string, unknown>) => {
    if (this.closed) {
      throw new Error('The thermostat runtime is shutting down.');
    }
    switch (route) {
      case '/thermostats':
        return this.view();
      case '/schedules/read': {
        const ids = this.deviceIds(body.deviceIds);
        for (const id of ids) {
          if (this.running.has(id)) {
            throw new Error('A selected thermostat already has an operation in progress.');
          }
        }
        ids.forEach(id => this.launch(id, 'reading', async () => {
          const snapshot = await this.schedules.read(id);
          this.snapshots.set(id, snapshot);
          await this.readSettings(id);
          await this.updateState(state => {
            const stored = state.devices[id];
            if (snapshot.fingerprint && stored?.confirmedProgramme
              && JSON.stringify(stateFor(stored.confirmedProgramme).days) !== JSON.stringify(snapshot.state.days)) {
              return { ...state, devices: { ...state.devices, [id]: {
                ...stored, confirmedProfile: null, confirmedProgramme: null, confirmedAt: null,
                status: 'pending', error: 'The thermostat programme changed outside this editor.',
              } } };
            }
            return state;
          });
          this.jobs.set(id, { status: snapshot.fingerprint ? 'verified' : 'partial', error: snapshot.errors.join(' ') || undefined });
        }));
        return this.view();
      }
      case '/profiles/save': {
        const id = this.deviceId(body.deviceId);
        await this.updateState(state => {
          let next = reduceThermostatProfiles(state, {
            type: 'set-programme', deviceId: id, profileId: profileId(body.profile),
            programme: validateThermostatWeeklyProgramme(body.schedule),
          });
          if (body.enabled !== undefined) {
            if (typeof body.enabled !== 'boolean') {
              throw new Error('Profile automation must be enabled or disabled explicitly.');
            }
            if (body.enabled && ['home', 'away', 'holiday'].some(key => !next.devices[id].programmes[key])) {
              throw new Error('Save complete Home, Away and Holiday programmes before enabling automatic selection.');
            }
            next = reduceThermostatProfiles(next, { type: 'set-enabled', deviceId: id, enabled: body.enabled });
          }
          return next;
        });
        if (!this.running.has(id)) {
          this.jobs.delete(id);
        }
        this.emit('change');
        return this.view();
      }
      case '/schedules/apply':
      case '/profiles/select': {
        if (body.preview === true) {
          const selected = profileId(body.profile);
          const plan: PreviewPlan = {
            id: randomUUID(), expiresAt: Date.now() + 5 * 60 * 1000,
            devices: this.deviceIds(body.deviceIds).map(id => {
              this.requireAvailable(id);
              const saved = this.state.devices[id]?.programmes[selected];
              if (!saved) {
                throw new Error(`Save a complete ${selected} programme for every selected thermostat first.`);
              }
              const programme = validateThermostatWeeklyProgramme(saved);
              const baseline = this.snapshots.get(id);
              if (!baseline?.fingerprint || Date.now() - baseline.finishedAt > 5 * 60 * 1000) {
                throw new Error('Read a complete current programme before previewing changes.');
              }
              this.requireSevenDayMode(id);
              const desired = stateFor(programme);
              return {
                id, name: this.deviceIdToName(id), profile: selected, programme,
                changes: desired.days.reduce((count, day, index) => count + day.events.filter((event, eventIndex) =>
                  JSON.stringify(event) !== JSON.stringify(baseline.state.days[index].events[eventIndex])).length, 0),
                baselineFingerprint: baseline.fingerprint,
              };
            }),
          };
          this.previews.set(plan.id, plan);
          this.expirePreviews();
          return {
            ...this.view(),
            preview: { id: plan.id, expiresAt: plan.expiresAt, devices: plan.devices.map(item => ({
              id: item.id, name: item.name, profile: item.profile, changes: item.changes,
            })),
            warnings: ['Apply uploads temperature events and selects the thermostat’s scheduled programme mode.',
              'An interrupted upload can leave a partial programme. Each thermostat is verified separately.'] },
          };
        }
        const plan = typeof body.previewId === 'string' ? this.previews.get(body.previewId) : undefined;
        if (!plan || plan.expiresAt <= Date.now()) {
          throw new Error('Preview the programme again before applying it.');
        }
        for (const item of plan.devices) {
          this.requireAvailable(item.id);
          if (JSON.stringify(this.state.devices[item.id]?.programmes[item.profile]) !== JSON.stringify(item.programme)) {
            throw new Error('A saved programme changed after preview. Preview again before applying.');
          }
        }
        this.previews.delete(plan.id);
        for (const item of plan.devices) {
          this.launchApply(item.id, item.profile, item.baselineFingerprint, true, item.programme);
        }
        return this.view();
      }
      case '/presence':
        if (typeof body.home !== 'boolean') {
          throw new Error('Presence must indicate whether anyone is home.');
        }
        return this.setIntent({ type: 'occupancy', anyoneHome: body.home });
      case '/holiday':
        if (typeof body.active !== 'boolean') {
          throw new Error('Holiday must be on or off.');
        }
        return this.setIntent({ type: 'holiday', enabled: body.active });
      default:
        throw new Error('Unsupported thermostat operation.');
    }
  };

  private async setIntent(action: ThermostatProfilesAction) {
    let previous = this.state;
    await this.updateState(state => {
      if (action.type === 'holiday' && !action.enabled && state.holiday && state.anyoneHome === null
        && state.enabledDeviceIds.length) {
        throw new Error('Set whether anyone is home before ending Holiday, so the correct programme can be restored.');
      }
      previous = state;
      return reduceThermostatProfiles(state, action);
    });
    for (const id of this.state.enabledDeviceIds) {
      const selected = this.state.devices[id]?.requestedProfile;
      if (selected && previous.devices[id]?.requestedProfile !== selected) {
        if (this.running.has(id)) {
          this.pending.set(id, selected);
        } else {
          this.launchApply(id, selected, this.snapshots.get(id)?.fingerprint ?? '', false);
        }
      }
    }
    return this.view();
  }

  private launchApply(id: string, selected: ThermostatProfileId, expectedFingerprint: string, manual: boolean,
    expectedProgramme?: ThermostatWeeklyProgramme) {
    this.launch(id, 'applying', async () => {
      this.requireAvailable(id, true);
      await this.readSettings(id);
      this.requireSevenDayMode(id);
      if (!expectedFingerprint) {
        throw new Error('Read a complete thermostat programme before applying a saved profile.');
      }
      const operationId = randomUUID();
      let plan: ThermostatProfileApplyPlan | undefined;
      let mayHaveChangedDevice = false;
      let failureStatus = 'failed';
      try {
        await this.updateState(state => {
          plan = prepareThermostatProfileApply(state, id, manual ? selected : undefined);
          if (expectedProgramme && JSON.stringify(plan.programme) !== JSON.stringify(expectedProgramme)) {
            throw new Error('The saved programme changed after preview. Preview again before applying.');
          }
          return reduceThermostatProfiles(state, {
            type: 'apply-started', deviceId: id, operationId, ...(manual ? { profileId: selected } : {}),
          });
        });
        if (!plan) {
          throw new Error('Could not prepare the selected thermostat programme.');
        }
        const result = await this.schedules.apply(id, { draft: stateFor(plan.programme), expectedFingerprint });
        const snapshot = result.readback ?? result.backup;
        this.snapshots.set(id, snapshot);
        mayHaveChangedDevice = result.applied > 0 || result.unknownOutcome === true || result.status === 'conflict';
        failureStatus = result.status === 'conflict' ? 'conflict' : mayHaveChangedDevice ? 'partial' : 'failed';
        if (result.status !== 'verified' && result.status !== 'no_changes') {
          throw new Error(result.error ?? `Programme application ${result.status}.`);
        }
        // The preview and automation enrollment both describe activation explicitly.
        mayHaveChangedDevice = true;
        await this.schedules.activateProgramme(id);
        await this.readSettings(id);
        this.requireSevenDayMode(id);
        if (this.nativeSettings.get(id)?.mode !== 'smart') {
          throw new Error('The programme was uploaded, but scheduled mode could not be confirmed.');
        }
        const confirmed = plan;
        await this.updateState(state => reduceThermostatProfiles(state, {
          type: 'apply-confirmed', deviceId: id, operationId, programme: confirmed.programme, confirmedAt: Date.now(),
        }));
        this.jobs.set(id, { status: 'verified', requestedProfile: confirmed.profileId, completedAt: Date.now() });
      } catch (error) {
        this.pending.delete(id);
        await this.updateState(state => reduceThermostatProfiles(state, {
          type: 'apply-failed', deviceId: id, operationId, error: message(error), mayHaveChangedDevice,
        }), true);
        this.jobs.set(id, { status: mayHaveChangedDevice && failureStatus !== 'conflict' ? 'partial' : failureStatus,
          error: message(error) });
      }
    });
  }

  private launch(id: string, status: string, task: () => Promise<void>) {
    if (this.running.has(id)) {
      throw new Error('A thermostat operation is already in progress.');
    }
    this.jobs.set(id, { status });
    const promise = Promise.resolve().then(task).catch(error => {
      this.jobs.set(id, { status: 'failed', error: message(error) });
      this.log.warn('Thermostat operation failed: %s', message(error));
    }).finally(() => {
      this.running.delete(id);
      this.emit('change');
      const next = this.pending.get(id);
      this.pending.delete(id);
      if (next && !this.closed && this.jobs.get(id)?.status === 'verified' && this.state.enabledDeviceIds.includes(id)
        && this.state.devices[id]?.requestedProfile === next && this.state.devices[id]?.status !== 'confirmed') {
        this.launchApply(id, next, this.snapshots.get(id)?.fingerprint ?? '', false);
      }
    });
    this.running.set(id, promise);
    this.emit('change');
  }

  private async readSettings(id: string) {
    const response = await this.manager.api.get(`/v2.0/cloud/thing/${id}/shadow/properties`, {
      codes: 'ControlMode,Event_Adaptive_Set',
    });
    if (!response.success || !Array.isArray(response.result?.properties)) {
      throw new Error('Could not read the thermostat programme mode and grouping.');
    }
    const properties = response.result.properties as { code: string; value: unknown }[];
    const mode = properties.find(item => item.code === 'ControlMode')?.value;
    const grouping = properties.find(item => item.code === 'Event_Adaptive_Set')?.value;
    this.nativeSettings.set(id, {
      mode: typeof mode === 'string' ? mode : undefined,
      grouping: typeof grouping === 'number' && Number.isInteger(grouping) ? grouping : undefined,
    });
  }

  private requireSevenDayMode(id: string) {
    const grouping = this.nativeSettings.get(id)?.grouping;
    if (grouping === undefined || (grouping & 1) !== 0) {
      throw new Error('Select seven-day programming in SmartLife, then read the thermostat again before applying weekly profiles.');
    }
  }

  private deviceId(value: unknown): string {
    if (typeof value !== 'string' || !this.devices().some(device => device.id === value)) {
      throw new Error('Choose a supported thermostat from this Homebridge instance.');
    }
    return value;
  }

  private deviceIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > this.devices().length) {
      throw new Error('Select at least one thermostat.');
    }
    return [...new Set(value.map(id => this.deviceId(id)))];
  }

  private deviceIdToName(id: string) {
    return this.manager.getDevice(id)?.name ?? id;
  }

  private celsius(device: TuyaDevice) {
    return device.status.find(status => status.code === 'temp_unit_convert')?.value === 'c';
  }

  private requireAvailable(id: string, alreadyRunning = false) {
    this.deviceId(id);
    const device = this.manager.getDevice(id)!;
    if (!device.online || !this.celsius(device)) {
      throw new Error('The thermostat must be online and configured in Celsius.');
    }
    if (!alreadyRunning && this.running.has(id)) {
      throw new Error('A selected thermostat already has an operation in progress.');
    }
  }

  private expirePreviews() {
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= Date.now()) {
        this.previews.delete(id);
      }
    }
    while (this.previews.size > 20) {
      this.previews.delete(this.previews.keys().next().value!);
    }
  }

  private async persist() {
    const contents = JSON.stringify({ version: 1, profiles: this.state, snapshots: [...this.snapshots.values()] });
    const write = this.persistence.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, contents, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    this.persistence = write.catch(() => undefined);
    return write;
  }

  /** Keep filesystem rollback and UI/HomeKit/job reducers in one short transaction queue. */
  private updateState(change: (state: ThermostatProfilesState) => ThermostatProfilesState, retainOnFailure = false) {
    const operation = this.stateTransactions.then(async () => {
      const previous = this.state;
      this.state = change(previous);
      try {
        await this.persist();
      } catch (error) {
        if (!retainOnFailure) {
          this.state = previous;
        }
        throw error;
      }
      this.emit('change');
    });
    this.stateTransactions = operation.catch(() => undefined);
    return operation;
  }
}
