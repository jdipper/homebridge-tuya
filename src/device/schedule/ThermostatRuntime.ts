import EventEmitter from 'events';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Logger } from 'homebridge';
import TuyaDevice, { TuyaDeviceStatus } from '../TuyaDevice';
import TuyaDeviceManager, { ThermostatTemperatureObservation } from '../TuyaDeviceManager';
import { getFastWarmTemperatureReport, isFastWarmThermostat } from '../profile/FastWarmThermostat';
import { collectFastWarmSchedule, FastWarmScheduleState } from './FastWarmSchedule';
import FastWarmScheduleManager, { FastWarmScheduleSnapshot } from './FastWarmScheduleManager';
import {
  createThermostatProfilesState, prepareThermostatProfileApply, reduceThermostatProfiles, restoreThermostatProfilesState,
  ThermostatProfileApplyPlan, ThermostatProfileId, ThermostatProfilesState, ThermostatWeeklyProgramme,
  validateThermostatWeeklyProgramme,
} from './ThermostatProfiles';
import ThermostatRuntimeServer from './ThermostatRuntimeServer';
import {
  createThermostatControlPolicy, evaluateThermostatControlPolicy, policyDeadlines, policyIntent, policyMinutes,
  policyTimestamp, restoreThermostatControlPolicy, ThermostatControlPolicy,
} from './ThermostatControlPolicy';
import FastWarmOverrideTransport, { FastWarmOverrideBaseline } from './FastWarmOverrideTransport';
import { getThermostatNowNext, isThermostatTimeZone } from './ThermostatNowNext';
import ThermostatHistory, { ThermostatTemperaturePoint } from './ThermostatHistory';

type ScheduleTransport = Pick<FastWarmScheduleManager, 'read' | 'apply' | 'activateProgramme' | 'close'>;
type OverrideTransport = Pick<FastWarmOverrideTransport, 'preview' | 'startOverride' | 'resumeOverride'>;
interface RoomSettings { name?: string; timeZone: string; clockVerified: boolean }
interface OverrideState {
  temperature: number; endsAt: number; startedAt: number; expiry: 'homebridge'; baseline: FastWarmOverrideBaseline;
  status: 'starting' | 'active' | 'resuming' | 'recovery-required' | 'failed' | 'completed'; error?: string;
}
interface OverridePreview {
  id: string; expiresAt: number; deviceId: string; temperature: number; endsAt: number; baseline: FastWarmOverrideBaseline;
}
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
  private controls = createThermostatControlPolicy();
  private policyTimer?: NodeJS.Timeout;
  private policyOperation: Promise<void> = Promise.resolve();
  private overrideTransport: OverrideTransport;
  private overrides: Record<string, OverrideState> = {};
  private overrideTimers = new Map<string, NodeJS.Timeout>();
  private pendingOverrideResume = new Set<string>();
  private overridePreviews = new Map<string, OverridePreview>();
  private roomSettings: Record<string, RoomSettings> = {};
  private history = new ThermostatHistory();
  private historyDirty = false;
  private historyTimer?: NodeJS.Timeout;
  private onlineStates = new Map<string, boolean>();

  constructor(
    public manager: TuyaDeviceManager,
    persistPath: string,
    public instanceId: string,
    private log: Pick<Logger, 'warn'>,
    transport?: ScheduleTransport,
    overrideTransport?: OverrideTransport,
  ) {
    super();
    this.overrideTransport = overrideTransport ?? new FastWarmOverrideTransport(manager.api, id => manager.getDevice(id));
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
      if (saved.version !== 1 && saved.version !== 2) {
        throw new Error('Unsupported thermostat profiles file version.');
      }
      this.state = restoreThermostatProfilesState(saved.profiles);
      this.controls = restoreThermostatControlPolicy(saved.controls, this.state.anyoneHome, this.state.holiday, Date.now());
      this.history.restore(saved.history);
      for (const [id, settings] of Object.entries(saved.rooms ?? {})) {
        this.roomSettings[id] = this.validateRoomSettings(settings);
      }
      for (const [id, override] of Object.entries(saved.overrides ?? {}) as [string, OverrideState][]) {
        if (!override || !Number.isFinite(override.temperature) || !Number.isSafeInteger(override.endsAt)
          || !Number.isSafeInteger(override.startedAt) || override.expiry !== 'homebridge' || !override.baseline) {
          throw new Error('Invalid saved thermostat override.');
        }
        this.overrides[id] = ['completed', 'failed'].includes(override.status) ? override : {
          ...override, status: 'recovery-required',
          error: 'Homebridge restarted during an override. Review the thermostat and explicitly resume its programme.',
        };
      }
      for (const [id, device] of Object.entries(saved.profiles.devices) as [string, { inFlight?: unknown }][]) {
        if (device.inFlight) {
          this.jobs.set(id, { status: 'partial', error: 'A previous upload was interrupted. Read the thermostat before applying again.' });
        }
      }
      for (const snapshot of Array.isArray(saved.snapshots) ? saved.snapshots : []) {
        try {
          if (!this.devices().some(device => device.id === snapshot.deviceId) || !Number.isSafeInteger(snapshot.finishedAt)
            || !Number.isSafeInteger(snapshot.startedAt) || snapshot.startedAt > snapshot.finishedAt
            || snapshot.finishedAt > Date.now() || !Array.isArray(snapshot.errors)
            || snapshot.errors.some(error => typeof error !== 'string')) {
            continue;
          }
          const programme = validateThermostatWeeklyProgramme({ days: snapshot.state?.days });
          const state = stateFor(programme);
          const fingerprint = createHash('sha256').update(JSON.stringify(state.days.map(day => [day.day, day.events]))).digest('hex');
          this.snapshots.set(snapshot.deviceId, { ...snapshot, state,
            fingerprint: snapshot.fingerprint === fingerprint && snapshot.errors.length === 0 ? fingerprint : null });
        } catch {
          // Cached malformed/partial programmes have no authority and can be read again.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    for (const device of this.devices()) {
      this.state = reduceThermostatProfiles(this.state, { type: 'register-device', deviceId: device.id });
      this.onlineStates.set(device.id, device.online);
    }
    if (typeof this.manager.on === 'function') {
      this.manager.on(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, this.onTemperatureObservation);
      this.manager.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, this.onDeviceStatus);
      this.manager.on(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, this.onDeviceInfo);
    }
    if (publishServer) {
      await this.server.start();
    }
    // Restoring intent and cached programmes never triggers cloud commands.
    this.schedulePolicyTimer();
    this.emit('change');
  }

  devices() {
    return this.manager.devices.filter(isFastWarmThermostat);
  }

  get householdPresence() {
    return this.controls.actualHome;
  }

  get holidayActive() {
    return this.controls.holidayActive;
  }

  view() {
    return {
      instanceId: this.instanceId,
      thermostats: this.devices().map(device => {
        const profiles = this.state.devices[device.id];
        const snapshot = this.snapshots.get(device.id);
        const job = this.jobs.get(device.id);
        const native = this.nativeSettings.get(device.id);
        const syncStatus = job?.status === 'verified' && profiles
          && ['pending', 'failed', 'partial'].includes(profiles.status)
          ? profiles.status : job?.status ?? profiles?.status ?? 'idle';
        const requestedProgramme = profiles?.requestedProfile ? profiles.programmes[profiles.requestedProfile] : undefined;
        // A successful read or unrelated operation is not confirmation of a profile upload.
        // Keep the last confirmation time separate from whether it still matches current intent.
        const confirmationMatchesRequested = Boolean(device.online && profiles?.status === 'confirmed'
          && profiles.requestedProfile !== null && profiles.requestedProfile === profiles.confirmedProfile
          && profiles.confirmedAt !== null && !profiles.inFlight && requestedProgramme && profiles.confirmedProgramme
          && JSON.stringify(requestedProgramme) === JSON.stringify(profiles.confirmedProgramme)
          && snapshot?.fingerprint && JSON.stringify(stateFor(profiles.confirmedProgramme).days) === JSON.stringify(snapshot.state.days)
          && native?.mode === 'smart' && native.grouping !== undefined && (native.grouping & 1) === 0
          && !this.hasOverride(device.id) && !this.controls.recoveryRequired && !profiles.error && !job?.error
          && (!job || job.status === 'verified'));
        const current = device.status.find(status => status.code === 'temp_current')?.value;
        const target = device.status.find(status => status.code === 'temp_set')?.value;
        const settings = this.roomSettings[device.id] ?? this.defaultRoomSettings();
        const observation = typeof this.manager.getTemperatureObservation === 'function'
          ? this.manager.getTemperatureObservation(device.id) : undefined;
        const nowNext = snapshot?.fingerprint ? getThermostatNowNext({ days: snapshot.state.days.map(day => ({
          day: day.day, events: day.events,
        })) }, settings) : undefined;
        return {
          id: device.id, name: settings.name ?? device.room_name ?? device.name, deviceName: device.name, online: device.online,
          roomName: device.room_name, nameSource: settings.name ? 'custom' : device.room_name ? 'smartlife' : 'device',
          customName: settings.name,
          timeZone: settings.timeZone, clockVerified: settings.clockVerified, nowNext,
          temperatureReceivedAt: observation?.receivedAt, temperatureReportedAt: observation?.reportedAt,
          temperatureSource: observation?.source,
          override: this.overrides[device.id], programmeHistory: this.history.programmeHistory(device.id),
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
            status: syncStatus,
            profileStatus: profiles?.status ?? 'idle',
            requestedProfile: profiles?.requestedProfile,
            confirmedProfile: profiles?.confirmedProfile,
            confirmedAt: profiles?.confirmedAt ?? null,
            applyingProfile: profiles?.inFlight?.profileId ?? null,
            queuedProfile: this.pending.get(device.id) ?? null,
            lastAttemptedProfile: job?.requestedProfile ?? null,
            confirmationMatchesRequested,
            error: job?.error ?? profiles?.error,
          },
        };
      }),
      presence: { home: this.controls.actualHome, effectiveHome: this.controls.effectiveHome,
        pendingAwayAt: this.controls.pendingAwayAt, holdUntil: this.controls.holdUntil,
        awayDelayMinutes: this.controls.awayDelayMinutes },
      holiday: { active: this.controls.holidayActive, returnAt: this.controls.returnAt,
        preheatMinutes: this.controls.preheatMinutes, preheating: this.controls.preheating,
        recoveryRequired: this.controls.recoveryRequired },
      controls: { recoveryRequired: this.controls.recoveryRequired },
    };
  }

  async close() {
    this.closed = true;
    if (typeof this.manager.removeListener === 'function') {
      this.manager.removeListener(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, this.onTemperatureObservation);
      this.manager.removeListener(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, this.onDeviceStatus);
      this.manager.removeListener(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, this.onDeviceInfo);
    }
    clearTimeout(this.policyTimer);
    clearTimeout(this.historyTimer);
    for (const timer of this.overrideTimers.values()) {
      clearTimeout(timer);
    }
    this.overrideTimers.clear();
    this.pendingOverrideResume.clear();
    this.pending.clear();
    this.schedules.close();
    await this.policyOperation;
    await Promise.allSettled([...this.running.values()]);
    await this.stateTransactions;
    if (this.historyDirty) {
      await this.persist();
      this.historyDirty = false;
    }
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
      case '/rooms/refresh':
        await this.manager.refreshDeviceRooms();
        return this.view();
      case '/rooms/save': {
        const id = this.deviceId(body.deviceId);
        const settings = this.validateRoomSettings({ ...(this.roomSettings[id] ?? this.defaultRoomSettings()), ...body });
        await this.updateState(state => {
          this.roomSettings = { ...this.roomSettings, [id]: settings }; return state;
        });
        return this.view();
      }
      case '/temperatures/history': {
        const id = this.deviceId(body.deviceId);
        const hours = body.hours === undefined ? 24 : body.hours;
        if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
          throw new Error('Choose a history range between one hour and 30 days.');
        }
        return { ...this.view(), temperatureHistory: this.history.temperatureHistory(id, hours) };
      }
      case '/profiles/history': {
        const id = this.deviceId(body.deviceId);
        return { ...this.view(), programmeHistory: this.history.programmeHistory(id) };
      }
      case '/profiles/restore': {
        const id = this.deviceId(body.deviceId);
        const selected = profileId(body.profile);
        const version = typeof body.versionId === 'string' ? this.history.getProgrammeVersion(id, body.versionId) : undefined;
        if (!version) {
          throw new Error('Choose a retained programme version for this thermostat.');
        }
        await this.updateState(state => {
          const existing = state.devices[id]?.programmes[selected];
          if (existing) {
            this.history.recordProgramme(id, { programme: existing, source: 'draft', profile: selected });
          }
          this.history.recordProgramme(id, { programme: version.programme, source: 'draft', profile: selected });
          return reduceThermostatProfiles(state, {
            type: 'set-programme', deviceId: id, profileId: selected, programme: version.programme,
          });
        });
        return this.view();
      }
      case '/overrides/preview':
        return this.previewOverride(body);
      case '/overrides/start':
        return this.startOverride(body);
      case '/overrides/cancel': {
        const id = this.deviceId(body.deviceId);
        this.requireAvailable(id);
        const override = this.overrides[id];
        if (!override || override.status === 'completed' || override.status === 'failed') {
          throw new Error('This thermostat has no override to resume.');
        }
        this.launchResumeOverride(id);
        return this.view();
      }
      case '/schedules/read': {
        const ids = this.deviceIds(body.deviceIds);
        const selected = body.verifyProfile === undefined ? undefined : profileId(body.verifyProfile);
        const programmes = new Map<string, ThermostatWeeklyProgramme>();
        for (const id of ids) {
          if (this.running.has(id)) {
            throw new Error('A selected thermostat already has an operation in progress.');
          }
          if (selected) {
            this.requireAvailable(id, true);
            this.requireNoOverride(id);
            const saved = this.state.devices[id]?.programmes[selected];
            if (!saved) {
              throw new Error('Save a complete programme for every selected room before verifying it.');
            }
            programmes.set(id, validateThermostatWeeklyProgramme(saved));
          }
        }
        if (selected) {
          ids.forEach(id => this.launchVerifyProfile(id, selected, programmes.get(id)!));
          return this.view();
        }
        ids.forEach(id => this.launch(id, 'reading', async () => {
          const snapshot = await this.schedules.read(id);
          this.snapshots.set(id, snapshot);
          await this.readSettings(id);
          await this.updateState(state => {
            if (snapshot.fingerprint) {
              this.history.recordProgramme(id, { source: 'native', programme: { days: snapshot.state.days.map(day => ({
                day: day.day, events: day.events,
              })) } });
            }
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
          const schedule = validateThermostatWeeklyProgramme(body.schedule);
          const selected = profileId(body.profile);
          let next = reduceThermostatProfiles(state, {
            type: 'set-programme', deviceId: id, profileId: profileId(body.profile),
            programme: schedule,
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
          const existing = state.devices[id]?.programmes[selected];
          if (existing) {
            this.history.recordProgramme(id, { programme: existing, source: 'draft', profile: selected });
          }
          this.history.recordProgramme(id, { programme: schedule, source: 'draft', profile: selected });
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
              this.requireNoOverride(id);
              const saved = this.state.devices[id]?.programmes[selected];
              if (!saved) {
                throw new Error(`Save a complete ${selected} programme for every selected thermostat first.`);
              }
              const programme = validateThermostatWeeklyProgramme(saved);
              const baseline = this.snapshots.get(id);
              if (!baseline?.fingerprint || baseline.finishedAt > Date.now() || Date.now() - baseline.finishedAt > 5 * 60 * 1000) {
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
      case '/controls/settings': {
        const delay = policyMinutes(body.awayDelayMinutes, 'Away delay', 1440);
        return this.setPolicy(policy => ({ ...policy, awayDelayMinutes: delay,
          pendingAwayAt: policy.pendingAwayAt === null ? null
            : policy.pendingAwayAt + (delay - policy.awayDelayMinutes) * 60000 }));
      }
      case '/presence/hold': {
        const until = policyTimestamp(body.until, 'Keep Home until', Date.now());
        return this.setPolicy(policy => ({ ...policy, holdUntil: until }));
      }
      case '/controls/recover':
        if (body.confirm !== true) {
          throw new Error('Review and explicitly confirm heating policy recovery.');
        }
        return this.setPolicy(policy => ({ ...policy, recoveryRequired: null }));
      case '/presence':
        if (typeof body.home !== 'boolean') {
          throw new Error('Presence must indicate whether anyone is home.');
        }
        return this.setPolicy(policy => {
          const home = body.home as boolean;
          return { ...policy, actualHome: home, effectiveHome: home ? true : policy.effectiveHome,
            pendingAwayAt: home || policy.awayDelayMinutes === 0 ? null
              : policy.actualHome === false ? policy.pendingAwayAt : Date.now() + policy.awayDelayMinutes * 60000 };
        });
      case '/holiday':
        if (typeof body.active !== 'boolean') {
          throw new Error('Holiday must be on or off.');
        }
        return this.setPolicy(policy => {
          const active = body.active as boolean;
          if (!active && policy.holidayActive && policy.actualHome === null && policy.holdUntil === null
            && this.state.enabledDeviceIds.length) {
            throw new Error('Set whether anyone is home before ending Holiday, so the correct programme can be restored.');
          }
          const returnAt = active && body.returnAt !== undefined
            ? policyTimestamp(body.returnAt, 'Holiday return', Date.now()) : active ? policy.returnAt : null;
          const preheatMinutes = body.preheatMinutes !== undefined ? policyMinutes(body.preheatMinutes, 'Preheat lead', 1440)
            : policy.preheatMinutes;
          if (active && (!policy.holidayActive || body.returnAt !== undefined || body.preheatMinutes !== undefined)
            && returnAt !== null && returnAt - preheatMinutes * 60000 <= Date.now() && preheatMinutes > 0) {
            throw new Error('Choose a Holiday return time after the preheat period.');
          }
          return { ...policy, holidayActive: active, returnAt, preheatMinutes, preheating: false };
        });
      default:
        throw new Error('Unsupported thermostat operation.');
    }
  };

  private async setPolicy(change: (policy: ThermostatControlPolicy) => ThermostatControlPolicy) {
    let previous = this.state;
    await this.updateState(state => {
      previous = state;
      this.controls = evaluateThermostatControlPolicy(change(this.controls), Date.now());
      if (this.controls.recoveryRequired) {
        return state;
      }
      const intent = policyIntent(this.controls);
      const next = intent.anyoneHome === null ? { ...state, anyoneHome: null }
        : reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: intent.anyoneHome });
      return reduceThermostatProfiles(next, { type: 'holiday', enabled: intent.holiday });
    });
    this.schedulePolicyTimer();
    this.applyIntentChanges(previous);
    return this.view();
  }

  private applyIntentChanges(previous: ThermostatProfilesState) {
    if (this.closed) {
      return;
    }
    for (const id of this.state.enabledDeviceIds) {
      const selected = this.state.devices[id]?.requestedProfile;
      if (selected && previous.devices[id]?.requestedProfile !== selected) {
        if (this.running.has(id) || this.hasOverride(id)) {
          this.pending.set(id, selected);
        } else {
          this.launchApply(id, selected, this.snapshots.get(id)?.fingerprint ?? '', false);
        }
      }
    }
  }

  private schedulePolicyTimer() {
    clearTimeout(this.policyTimer);
    if (this.closed) {
      return;
    }
    const next = policyDeadlines(this.controls).sort((a, b) => a - b)[0];
    if (next === undefined) {
      return;
    }
    this.policyTimer = setTimeout(() => {
      this.policyOperation = this.setPolicy(policy => policy).then(() => undefined).catch(async error => {
        this.log.warn('Heating policy deadline failed: %s', message(error));
        await this.updateState(state => {
          this.controls = { ...this.controls, recoveryRequired: `Heating policy stopped: ${message(error)}` };
          return state;
        }, true).catch(() => this.emit('change'));
      });
    }, Math.min(2147483647, Math.max(1, next - Date.now())));
    this.policyTimer.unref();
  }

  private launchApply(id: string, selected: ThermostatProfileId, expectedFingerprint: string, manual: boolean,
    expectedProgramme?: ThermostatWeeklyProgramme) {
    this.launch(id, 'applying', async () => {
      this.requireAvailable(id, true);
      this.requireNoOverride(id);
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
        if (this.closed) {
          throw new Error('Homebridge stopped before the programme upload began.');
        }
        const result = await this.schedules.apply(id, { draft: stateFor(plan.programme), expectedFingerprint });
        const snapshot = result.readback ?? result.backup;
        this.snapshots.set(id, snapshot);
        mayHaveChangedDevice = result.applied > 0 || result.unknownOutcome === true || result.status === 'conflict';
        failureStatus = result.status === 'conflict' ? 'conflict' : mayHaveChangedDevice ? 'partial' : 'failed';
        await this.updateState(state => {
          for (const observed of [result.backup, result.readback]) {
            if (observed?.fingerprint) {
              this.history.recordProgramme(id, { source: 'native', programme: { days: observed.state.days.map(day => ({
                day: day.day, events: day.events,
              })) } });
            }
          }
          return state;
        }, mayHaveChangedDevice);
        if (result.status !== 'verified' && result.status !== 'no_changes') {
          throw new Error(result.error ?? `Programme application ${result.status}.`);
        }
        // The preview and automation enrollment both describe activation explicitly.
        mayHaveChangedDevice = true;
        if (this.closed) {
          throw new Error('Homebridge stopped before programme mode could be activated.');
        }
        await this.schedules.activateProgramme(id);
        await this.readSettings(id);
        this.requireSevenDayMode(id);
        if (this.nativeSettings.get(id)?.mode !== 'smart') {
          throw new Error('The programme was uploaded, but scheduled mode could not be confirmed.');
        }
        const confirmed = plan;
        await this.updateState(state => {
          this.history.recordProgramme(id, { source: 'native', programme: confirmed.programme });
          return reduceThermostatProfiles(state, {
            type: 'apply-confirmed', deviceId: id, operationId, programme: confirmed.programme, confirmedAt: Date.now(),
          });
        });
        this.jobs.set(id, { status: 'verified', requestedProfile: confirmed.profileId, completedAt: Date.now() });
      } catch (error) {
        this.pending.delete(id);
        await this.updateState(state => reduceThermostatProfiles(state, {
          type: 'apply-failed', deviceId: id, operationId, error: message(error), mayHaveChangedDevice,
        }), true);
        this.jobs.set(id, { status: mayHaveChangedDevice && failureStatus !== 'conflict' ? 'partial' : failureStatus,
          requestedProfile: selected,
          error: message(error) });
      }
    }, selected);
  }

  /** Reconcile a saved profile with fresh device evidence; never upload or change mode. */
  private launchVerifyProfile(id: string, selected: ThermostatProfileId, expectedProgramme: ThermostatWeeklyProgramme) {
    this.launch(id, 'verifying', async () => {
      this.requireAvailable(id, true);
      this.requireNoOverride(id);
      const snapshot = await this.schedules.read(id);
      this.snapshots.set(id, snapshot);
      await this.readSettings(id);
      this.requireSevenDayMode(id);
      if (!snapshot.fingerprint || JSON.stringify(snapshot.state.days) !== JSON.stringify(stateFor(expectedProgramme).days)) {
        throw new Error('The programme on the thermostat does not match the saved programme. No changes were sent.');
      }
      if (this.nativeSettings.get(id)?.mode !== 'smart') {
        throw new Error('The saved programme matches, but the thermostat is not in Scheduled mode. No changes were sent.');
      }
      await this.updateState(state => {
        this.requireAvailable(id, true);
        this.requireNoOverride(id);
        if (this.closed) {
          throw new Error('Homebridge stopped before programme verification finished.');
        }
        const next = reduceThermostatProfiles(state, { type: 'programme-verified', deviceId: id,
          profileId: selected, programme: expectedProgramme, confirmedAt: Date.now() });
        this.history.recordProgramme(id, { source: 'native', programme: expectedProgramme });
        return next;
      });
      this.jobs.set(id, { status: 'verified', requestedProfile: selected, completedAt: Date.now() });
    }, selected);
  }

  private launch(id: string, status: string, task: () => Promise<void>, requestedProfile?: ThermostatProfileId) {
    if (this.running.has(id)) {
      throw new Error('A thermostat operation is already in progress.');
    }
    this.jobs.set(id, { status, ...(requestedProfile ? { requestedProfile } : {}) });
    const promise = Promise.resolve().then(task).catch(error => {
      this.jobs.set(id, { status: 'failed', error: message(error), ...(requestedProfile ? { requestedProfile } : {}) });
      this.log.warn('Thermostat operation failed: %s', message(error));
    }).finally(() => {
      this.running.delete(id);
      this.emit('change');
      if (this.pendingOverrideResume.delete(id) && !this.closed && this.overrides[id]?.status === 'active') {
        try {
          this.launchResumeOverride(id);
        } catch (error) {
          void this.overrideFailed(id, error);
        }
        return;
      }
      const next = this.pending.get(id);
      if (next && !this.closed && this.jobs.get(id)?.status === 'verified' && this.state.enabledDeviceIds.includes(id)
        && this.state.devices[id]?.requestedProfile === next && this.state.devices[id]?.status === 'pending'
        && !this.hasOverride(id) && !this.controls.recoveryRequired) {
        this.pending.delete(id);
        this.launchApply(id, next, this.snapshots.get(id)?.fingerprint ?? '', false);
      } else if (!this.hasOverride(id) && !this.controls.recoveryRequired) {
        this.pending.delete(id);
      }
    });
    this.running.set(id, promise);
    this.emit('change');
  }

  private onTemperatureObservation = (device: TuyaDevice, observation: ThermostatTemperatureObservation) => {
    if (!observation || !isFastWarmThermostat(device)) {
      return;
    }
    void this.recordTemperature(device.id, { at: observation.receivedAt, sourceAt: observation.reportedAt,
      currentTemperature: observation.value / 10,
      online: device.online, unit: this.celsius(device) ? 'c' : undefined,
    }).catch(error => this.log.warn('Temperature history could not be saved: %s', message(error)));
  };

  private onDeviceStatus = (device: TuyaDevice, status: TuyaDeviceStatus[]) => {
    if (!isFastWarmThermostat(device) || !Array.isArray(status)) {
      return;
    }
    const target = status.find(item => item.code === 'temp_set');
    if (!target || typeof target.value !== 'number') {
      return;
    }
    const report = getFastWarmTemperatureReport({ ...target, dp_id: 105 });
    void this.recordTemperature(device.id, { at: Date.now(), sourceAt: report?.time,
      targetTemperature: target.value / 10, online: device.online, unit: this.celsius(device) ? 'c' : undefined,
    }).catch(error => this.log.warn('Target temperature history could not be saved: %s', message(error)));
  };

  private onDeviceInfo = (device: TuyaDevice) => {
    if (!isFastWarmThermostat(device) || this.onlineStates.get(device.id) === device.online) {
      return;
    }
    this.onlineStates.set(device.id, device.online);
    void this.recordTemperature(device.id, { at: Date.now(), online: device.online })
      .catch(error => this.log.warn('Thermostat availability history could not be saved: %s', message(error)));
  };

  /** Only genuine accepted observations call this method; UI reads never manufacture history points. */
  async recordTemperature(deviceId: string, observation: ThermostatTemperaturePoint & { unit?: 'c' | 'f' }) {
    if (this.closed || !this.devices().some(device => device.id === deviceId)) {
      return;
    }
    let changed = false;
    await this.updateState(state => {
      changed = this.history.ingestTemperature(deviceId, observation);
      if (changed) {
        this.historyDirty = true;
      }
      return state;
    }, false, false);
    if (changed && this.historyDirty && !this.historyTimer && !this.closed) {
      this.historyTimer = setTimeout(() => {
        this.historyTimer = undefined;
        void this.updateState(state => state).catch(error =>
          this.log.warn('Temperature history could not be saved: %s', message(error)));
      }, 30000);
      this.historyTimer.unref();
    }
  }

  private defaultRoomSettings(): RoomSettings {
    return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', clockVerified: false };
  }

  private validateRoomSettings(value: unknown): RoomSettings {
    if (!value || typeof value !== 'object') {
      throw new Error('Provide room settings.');
    }
    const source = value as Record<string, unknown>;
    if (typeof source.timeZone !== 'string' || source.timeZone.length > 100 || typeof source.clockVerified !== 'boolean') {
      throw new Error('Choose the thermostat time zone and confirm its clock explicitly.');
    }
    if (!isThermostatTimeZone(source.timeZone)) {
      throw new Error('Choose a valid IANA time zone, such as Europe/London.');
    }
    if (source.name !== undefined && (typeof source.name !== 'string' || source.name.length > 80)) {
      throw new Error('Room name must contain no more than 80 characters.');
    }
    return { name: typeof source.name === 'string' ? source.name.trim() || undefined : undefined,
      timeZone: source.timeZone, clockVerified: source.clockVerified };
  }

  private hasOverride(id: string) {
    const override = this.overrides[id];
    return override !== undefined && override.status !== 'completed' && override.status !== 'failed';
  }

  private requireNoOverride(id: string) {
    if (this.hasOverride(id)) {
      throw new Error('Resume this thermostat’s programme before applying a different programme.');
    }
  }

  private async previewOverride(body: Record<string, unknown>) {
    const id = this.deviceId(body.deviceId);
    this.requireAvailable(id);
    this.requireNoOverride(id);
    const temperature = body.temperature;
    if (typeof temperature !== 'number' || temperature < 5 || temperature > 40 || !Number.isInteger(temperature * 2)) {
      throw new Error('Override temperature must be between 5 and 40°C in half-degree steps.');
    }
    let endsAt: number;
    if (body.endsAt === 'next-period') {
      const snapshot = this.snapshots.get(id);
      if (!snapshot?.fingerprint || snapshot.finishedAt > Date.now() || Date.now() - snapshot.finishedAt > 5 * 60000) {
        throw new Error('Read a fresh complete programme before choosing the next period.');
      }
      const next = getThermostatNowNext({ days: snapshot.state.days.map(day => ({ day: day.day, events: day.events })) },
        this.roomSettings[id] ?? this.defaultRoomSettings());
      if (!next.safeForExpiry || !next.next) {
        throw new Error(next.reason ?? 'Verify the thermostat clock and time zone before using the next period.');
      }
      endsAt = next.next.at;
    } else {
      endsAt = policyTimestamp(body.endsAt, 'Override end', Date.now(), false)!;
    }
    if (endsAt > Date.now() + 86400000) {
      throw new Error('A temporary override must end within 24 hours.');
    }
    const baseline = await this.overrideTransport.preview(id);
    this.requireAvailable(id);
    this.requireNoOverride(id);
    const preview: OverridePreview = { id: randomUUID(), expiresAt: Date.now() + 5 * 60000,
      deviceId: id, temperature, endsAt, baseline };
    this.overridePreviews.set(preview.id, preview);
    for (const [key, existing] of this.overridePreviews) {
      if (existing.expiresAt <= Date.now()) {
        this.overridePreviews.delete(key);
      }
    }
    while (this.overridePreviews.size > 20) {
      this.overridePreviews.delete(this.overridePreviews.keys().next().value!);
    }
    return { ...this.view(), overridePreview: {
      id: preview.id, expiresAt: preview.expiresAt, deviceId: id, name: this.deviceIdToName(id), temperature, endsAt,
      expiry: 'homebridge',
      warning: 'Homebridge and internet access must remain available to end this override. '
        + 'If either stops, the thermostat may keep this temperature until you resume its programme.',
    } };
  }

  private async startOverride(body: Record<string, unknown>) {
    const preview = typeof body.previewId === 'string' ? this.overridePreviews.get(body.previewId) : undefined;
    if (!preview || preview.expiresAt <= Date.now() || preview.endsAt <= Date.now()) {
      throw new Error('Review the override again before starting it.');
    }
    if (body.acceptHostDependentExpiry !== true) {
      throw new Error('Explicitly accept that Homebridge and internet access are needed to end the override.');
    }
    const id = preview.deviceId;
    this.requireAvailable(id);
    this.requireNoOverride(id);
    this.overridePreviews.delete(preview.id);
    this.launch(id, 'overriding', async () => {
      await this.updateState(state => {
        this.overrides = { ...this.overrides, [id]: { temperature: preview.temperature, endsAt: preview.endsAt,
          baseline: preview.baseline, startedAt: Date.now(), expiry: 'homebridge', status: 'starting' } };
        return state;
      });
      try {
        if (this.closed) {
          throw new Error('Homebridge stopped before the override began.');
        }
        await this.overrideTransport.startOverride(id, { temperature: preview.temperature, endsAt: preview.endsAt,
          baseline: preview.baseline });
        if (this.closed) {
          throw new Error('Homebridge stopped during override activation. Review the thermostat before resuming.');
        }
        await this.updateState(state => {
          this.overrides = { ...this.overrides, [id]: { ...this.overrides[id], status: 'active' } };
          return state;
        }, true);
        this.nativeSettings.set(id, { ...this.nativeSettings.get(id), mode: 'hold' });
        this.jobs.set(id, { status: 'verified', completedAt: Date.now() });
        this.scheduleOverrideTimer(id);
      } catch (error) {
        await this.overrideFailed(id, error);
      }
    });
    return this.view();
  }

  private scheduleOverrideTimer(id: string) {
    clearTimeout(this.overrideTimers.get(id));
    const override = this.overrides[id];
    if (this.closed || !override || override.status !== 'active') {
      return;
    }
    const timer = setTimeout(() => {
      this.overrideTimers.delete(id);
      if (Date.now() < override.endsAt) {
        this.scheduleOverrideTimer(id);
        return;
      }
      if (this.running.has(id)) {
        // Finish the existing read, then perform this one due resume attempt.
        this.pendingOverrideResume.add(id);
        return;
      }
      try {
        this.requireAvailable(id);
        this.launchResumeOverride(id);
      } catch (error) {
        void this.overrideFailed(id, error).catch(failure => this.log.warn('Could not save override failure: %s', message(failure)));
      }
    }, Math.min(2147483647, Math.max(1, override.endsAt - Date.now())));
    timer.unref();
    this.overrideTimers.set(id, timer);
  }

  private launchResumeOverride(id: string) {
    const override = this.overrides[id];
    this.launch(id, 'resuming', async () => {
      clearTimeout(this.overrideTimers.get(id));
      this.overrideTimers.delete(id);
      try {
        await this.updateState(state => {
          this.overrides = { ...this.overrides, [id]: { ...override, status: 'resuming' } };
          return state;
        });
        if (this.closed) {
          throw new Error('Homebridge stopped before the programme could be resumed.');
        }
        await this.overrideTransport.resumeOverride(id, { temperature: override.temperature, baseline: override.baseline });
        await this.updateState(state => {
          this.overrides = { ...this.overrides, [id]: { ...override, status: 'completed' } };
          this.nativeSettings.set(id, { ...this.nativeSettings.get(id), mode: 'smart' });
          return state;
        }, true);
        const selected = this.state.devices[id]?.requestedProfile;
        if (selected && this.state.enabledDeviceIds.includes(id) && this.state.devices[id]?.status === 'pending') {
          this.pending.set(id, selected);
        }
        this.jobs.set(id, { status: 'verified', completedAt: Date.now() });
      } catch (error) {
        await this.overrideFailed(id, error);
      }
    });
  }

  private async overrideFailed(id: string, error: unknown) {
    const reason = `${message(error)} Review the thermostat and explicitly resume its programme; `
      + 'this operation will not retry automatically.';
    await this.updateState(state => {
      this.overrides = { ...this.overrides, [id]: { ...this.overrides[id], status: 'recovery-required', error: reason } };
      return state;
    }, true);
    this.jobs.set(id, { status: 'failed', error: reason });
    this.emit('change');
  }

  private async readSettings(id: string) {
    const response = await this.manager.api.request('get', `/v2.0/cloud/thing/${id}/shadow/properties`, {
      codes: 'ControlMode,Event_Adaptive_Set',
    }, null, { attempts: 1, timeoutMs: 10000 });
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
    const device = this.manager.getDevice(id);
    return this.roomSettings[id]?.name ?? device?.room_name ?? device?.name ?? id;
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
    const contents = JSON.stringify({ version: 2, profiles: this.state, controls: this.controls,
      snapshots: [...this.snapshots.values()], overrides: this.overrides, rooms: this.roomSettings, history: this.history.snapshot() });
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
  private updateState(change: (state: ThermostatProfilesState) => ThermostatProfilesState, retainOnFailure = false, save = true) {
    const operation = this.stateTransactions.then(async () => {
      const previous = this.state;
      const previousControls = this.controls;
      const previousOverrides = this.overrides;
      const previousRooms = this.roomSettings;
      const previousHistory = this.history.snapshot();
      try {
        this.state = change(previous);
        if (save) {
          await this.persist();
          this.historyDirty = false;
          clearTimeout(this.historyTimer);
          this.historyTimer = undefined;
        }
      } catch (error) {
        if (!retainOnFailure) {
          this.state = previous;
          this.controls = previousControls;
          this.overrides = previousOverrides;
          this.roomSettings = previousRooms;
          this.history.restore(previousHistory);
        }
        throw error;
      }
      this.emit('change');
    });
    this.stateTransactions = operation.catch(() => undefined);
    return operation;
  }
}
