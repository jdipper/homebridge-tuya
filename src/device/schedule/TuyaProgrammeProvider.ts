import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { writePrivateJson } from '../../util/PrivateFile';
import TuyaDevice, { TuyaDeviceStatus } from '../TuyaDevice';
import TuyaDeviceManager, { ThermostatTemperatureObservation } from '../TuyaDeviceManager';
import { getFastWarmSetTemperatureReport, isFastWarmThermostat } from '../profile/FastWarmThermostat';
import {
  collectFastWarmSchedule, encodeFastWarmSchedule, FASTWARM_SCHEDULE_DAYS, FastWarmScheduleEventId,
  FastWarmScheduleState,
} from './FastWarmSchedule';
import FastWarmScheduleManager, { FastWarmProgrammeWriteMode, FastWarmScheduleSnapshot } from './FastWarmScheduleManager';
import TuyaProgrammeProviderServer from './TuyaProgrammeProviderServer';
import { FastWarmProgrammeGroup } from './FastWarmGroupCommandBroker';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
type WeeklyProgramme = Record<typeof WEEKDAYS[number], { startMinute: number; targetC: number }[]>;
type Transport = Pick<FastWarmScheduleManager, 'read' | 'apply' | 'activateProgramme' | 'close'>
  & Partial<Pick<FastWarmScheduleManager, 'prepareAutomatic' | 'applyAutomatic' | 'discardAutomatic' | 'invalidateAutomatic' | 'invalidateGroupCapabilities'>>;
interface NativeSettings { mode: string; grouping: number }
interface Preview {
  token: string; deviceId: string; programme: WeeklyProgramme; expiresAt: number; changesRequired: boolean;
  fingerprint: string; settings: NativeSettings;
  requireScheduled: boolean;
}
export interface TuyaProgrammeProviderOptions {
  programmeWriteModes?: { deviceId: string; mode: Exclude<FastWarmProgrammeWriteMode, 'single-events'> }[];
  programmeGroups?: FastWarmProgrammeGroup[];
}
interface AutomaticLease {
  token: string; deviceId: string; programme: WeeklyProgramme; managerToken: string;
  backup: FastWarmScheduleSnapshot; expiresAt: number; consumed: boolean;
  proceed: (apply: boolean) => void; result: Promise<unknown>;
}
interface DeviceObservation {
  id: string; at: number; sourceAt?: number; currentTemperature?: number; targetTemperature?: number;
  online: boolean; unit?: 'c' | 'f';
}
const MAX_OBSERVATIONS_PER_ZONE = 200;
const MAX_OBSERVATIONS = 2000;
const MAX_OBSERVATION_ZONES = 64;

function text(error: unknown) {
  return error instanceof Error ? error.message : 'The thermostat operation could not be confirmed.';
}

/** Validate the complete canonical week before performing any device operation. */
export function programmeToFastWarm(value: unknown): FastWarmScheduleState {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 7 || Object.keys(value).some(key => !WEEKDAYS.includes(key as typeof WEEKDAYS[number]))) {
    throw new Error('A complete Monday-to-Sunday programme is required.');
  }
  const week = value as Record<string, unknown>;
  return collectFastWarmSchedule(WEEKDAYS.map((name, index) => {
    const periods = week[name];
    if (!Array.isArray(periods) || periods.length !== 4) {
      throw new Error('FastWarm programmes require exactly four periods per day.');
    }
    let previous = -1;
    const events = periods.map((period: unknown, event) => {
      if (!period || typeof period !== 'object' || Array.isArray(period)
        || Object.keys(period).length !== 2 || !Object.prototype.hasOwnProperty.call(period, 'startMinute')
        || !Object.prototype.hasOwnProperty.call(period, 'targetC')) {
        throw new Error('Each programme period requires only a time and a Celsius target.');
      }
      const { startMinute, targetC } = period as { startMinute: unknown; targetC: unknown };
      if (typeof startMinute !== 'number' || !Number.isInteger(startMinute) || startMinute < 0 || startMinute >= 1440
        || startMinute <= previous || typeof targetC !== 'number') {
        throw new Error('Programme times must be valid and strictly increasing within each day.');
      }
      previous = startMinute;
      return { event: event as FastWarmScheduleEventId, hour: Math.floor(startMinute / 60), minute: startMinute % 60,
        temperature: targetC };
    });
    const dayMask = FASTWARM_SCHEDULE_DAYS[index];
    encodeFastWarmSchedule({ dayMask, events });
    return { packet: { dayMask, events } };
  }));
}

function canonical(state: FastWarmScheduleState): WeeklyProgramme {
  if (!state.complete) {
    throw new Error('A complete native FastWarm programme is required.');
  }
  return Object.fromEntries(WEEKDAYS.map((day, index) => [day, state.days[index].events.map(event => ({
    startMinute: event.hour * 60 + event.minute, targetC: event.temperature,
  }))])) as WeeklyProgramme;
}

/** Device connection only. Household intent, drafts and timers belong to the shared controller. */
export default class TuyaProgrammeProvider {
  private readonly schedules: Transport;
  private readonly server: TuyaProgrammeProviderServer;
  private readonly snapshots = new Map<string, FastWarmScheduleSnapshot>();
  private readonly settings = new Map<string, NativeSettings>();
  private readonly previews = new Map<string, Preview>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly observations = new Map<string, DeviceObservation[]>();
  private readonly onlineStates = new Map<string, boolean>();
  private readonly writeModes = new Map<string, FastWarmProgrammeWriteMode>();
  private closed = false;
  private automaticLeases = new Map<string, AutomaticLease>();
  private readonly automaticJournalPath: string;

  constructor(private readonly manager: TuyaDeviceManager, persistPath: string, public readonly instanceId: string,
    transport?: Transport, options: TuyaProgrammeProviderOptions = {}) {
    if (options.programmeWriteModes !== undefined && !Array.isArray(options.programmeWriteModes)) {
      throw new Error('Validated FastWarm programme write modes must be a per-device list.');
    }
    for (const item of options.programmeWriteModes ?? []) {
      if (!item || Object.keys(item).some(key => !['deviceId', 'mode'].includes(key))
        || typeof item.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.deviceId)
        || !['whole-days', 'grouped-events', 'grouped-days'].includes(item.mode) || this.writeModes.has(item.deviceId)) {
        throw new Error('Choose one hardware-validated FastWarm programme write mode per device.');
      }
      this.writeModes.set(item.deviceId, item.mode);
    }
    for (const group of options.programmeGroups ?? []) {
      if (!Array.isArray(group?.deviceIds) || group.deviceIds.some(id => !this.devices().some(device => device.id === id))) {
        throw new Error('Validated programme groups may contain only this provider\'s supported FastWarm thermostats.');
      }
    }
    this.schedules = transport ?? new FastWarmScheduleManager(manager.api, manager.mq, id => manager.getDevice(id),
      {programmeGroups: options.programmeGroups});
    this.automaticJournalPath = path.join(path.dirname(persistPath), 'heating-operations', `tuya-${instanceId}`);
    this.server = new TuyaProgrammeProviderServer(persistPath, instanceId, this.handle,
      Boolean(this.schedules.prepareAutomatic && this.schedules.applyAutomatic && this.schedules.discardAutomatic));
    // Cache the initial availability without manufacturing a history observation.
    for (const device of this.devices()) {
      this.onlineStates.set(device.id, device.online);
    }
    if (typeof manager.on === 'function') {
      manager.on(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, this.onTemperatureObservation);
      manager.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, this.onDeviceStatus);
      manager.on(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, this.onDeviceInfo);
    }
  }

  static instanceId(configuration: unknown): string {
    return createHash('sha256').update(JSON.stringify(configuration)).digest('hex').slice(0, 16);
  }

  async start() {
    await this.server.start();
  }

  async close() {
    this.closed = true;
    if (typeof this.manager.removeListener === 'function') {
      this.manager.removeListener(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, this.onTemperatureObservation);
      this.manager.removeListener(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, this.onDeviceStatus);
      this.manager.removeListener(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, this.onDeviceInfo);
    }
    this.previews.clear();
    for (const lease of this.automaticLeases.values()) {
      lease.proceed(false);
    }
    this.schedules.close();
    await Promise.allSettled([...this.queues.values()]);
    await this.server.close();
  }

  handle = async (route: string, body: Record<string, unknown>): Promise<unknown> => {
    if (this.closed) {
      throw new Error('The programme provider is shutting down.');
    }
    const reply = (value: object) => ({ protocolVersion: 1, instanceId: this.instanceId, ...value });
    switch (route) {
      case '/provider/list':
        return reply({ zones: this.devices().map(device => this.zone(device.id)) });
      case '/provider/refresh':
        await this.manager.refreshDeviceRooms();
        return reply({ zones: this.devices().map(device => this.zone(device.id)) });
      case '/provider/read': {
        const id = this.deviceId(body.deviceId);
        return this.enqueue(id, async () => reply({ zone: await this.read(id) }));
      }
      case '/provider/prepare-automatic': {
        const id = this.deviceId(body.deviceId);
        if (body.requireScheduled !== true || Object.keys(body).some(key => !['deviceId', 'programme', 'requireScheduled'].includes(key))) {
          throw new Error('Automatic selections must require Scheduled mode and contain only a complete programme.');
        }
        const programme = canonical(programmeToFastWarm(body.programme));
        return reply({preview: await this.prepareAutomatic(id, programme)});
      }
      case '/provider/apply-automatic': {
        const lease = typeof body.token === 'string' ? this.automaticLeases.get(body.token) : undefined;
        if (!lease || lease.consumed || lease.expiresAt <= Date.now()) {
          throw new Error('The owned automatic baseline expired or was consumed.');
        }
        lease.consumed = true;
        lease.proceed(true);
        return reply({automaticFreshBaseline: true, result: await lease.result});
      }
      case '/provider/discard': {
        if (typeof body.token !== 'string' || Object.keys(body).some(key => key !== 'token')) {
          throw new Error('A preview token is required.');
        }
        const lease = this.automaticLeases.get(body.token);
        if (lease && !lease.consumed) {
          lease.consumed = true; lease.proceed(false);
        }
        this.previews.delete(body.token);
        return reply({discarded: true});
      }
      case '/provider/prepare': {
        const id = this.deviceId(body.deviceId);
        const programme = canonical(programmeToFastWarm(body.programme));
        if (body.expectedFingerprint !== undefined
          && (typeof body.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedFingerprint))) {
          throw new Error('The programme baseline fingerprint is invalid.');
        }
        const expectedFingerprint = body.expectedFingerprint;
        if (body.requireScheduled !== undefined && typeof body.requireScheduled !== 'boolean') {
          throw new Error('Automatic programme preparation must explicitly require Scheduled mode.');
        }
        const requireScheduled = body.requireScheduled === true;
        return this.enqueue(id, async () => {
          const zone = await this.read(id);
          const snapshot = this.snapshots.get(id)!;
          this.requireSevenDayMode(id);
          if (requireScheduled && !zone.scheduled) {
            throw new Error('Automatic changes require the thermostat to be in Scheduled mode.');
          }
          if (!snapshot.fingerprint || (expectedFingerprint !== undefined && snapshot.fingerprint !== expectedFingerprint)) {
            throw new Error('The thermostat programme changed or could not be read completely. Read it again before preparing changes.');
          }
          const preview: Preview = {
            token: randomUUID(), deviceId: id, programme, expiresAt: Date.now() + 5 * 60_000,
            changesRequired: JSON.stringify(zone.programme) !== JSON.stringify(programme) || !zone.scheduled,
            fingerprint: snapshot.fingerprint, settings: { ...this.settings.get(id)! },
            requireScheduled,
          };
          this.expirePreviews();
          this.previews.set(preview.token, preview);
          const { token, deviceId, expiresAt, changesRequired } = preview;
          return reply({ preview: { token, deviceId, programme, expiresAt, changesRequired, requireScheduled } });
        });
      }
      case '/provider/apply': {
        const preview = typeof body.token === 'string' ? this.previews.get(body.token) : undefined;
        if (!preview) {
          throw new Error('Prepare a fresh programme preview before applying it.');
        }
        // Consume before waiting on the device queue: a preview can never be replayed.
        this.previews.delete(preview.token);
        return this.enqueue(preview.deviceId, async () => reply({ result: await this.apply(preview) }));
      }
      default:
        throw new Error('Unsupported programme-provider operation.');
    }
  };

  private devices() {
    return this.manager.devices.filter(isFastWarmThermostat);
  }

  private deviceId(value: unknown): string {
    if (typeof value !== 'string' || !this.devices().some(device => device.id === value)) {
      throw new Error('Choose a supported FastWarm thermostat from this instance.');
    }
    return value;
  }

  private requireAvailable(id: string): TuyaDevice {
    this.deviceId(id);
    const device = this.manager.getDevice(id)!;
    if (this.closed || !device.online || device.status.find(item => item.code === 'temp_unit_convert')?.value !== 'c') {
      throw new Error('The thermostat must be online and configured in Celsius.');
    }
    return device;
  }

  private zone(id: string) {
    const device = this.manager.getDevice(id)!;
    const snapshot = this.snapshots.get(id);
    const settings = this.settings.get(id);
    const observation = this.manager.getTemperatureObservation?.(id);
    const celsius = device.status.find(item => item.code === 'temp_unit_convert')?.value === 'c';
    const temperature = (code: string): number | null => {
      const value = device.status.find(item => item.code === code)?.value;
      return celsius && typeof value === 'number' ? value / 10 : null;
    };
    return {
      id, name: device.room_name ?? device.name, roomName: device.room_name, online: device.online,
      measuredC: temperature('temp_current'), targetC: temperature('temp_set'),
      mode: settings?.mode ?? 'unknown', scheduled: settings?.mode === 'smart' && (settings.grouping & 1) === 0,
      readAt: snapshot?.finishedAt ?? observation?.receivedAt ?? Date.now(),
      temperatureReceivedAt: observation?.receivedAt, temperatureReportedAt: observation?.reportedAt,
      temperatureSource: observation?.source,
      observations: (this.observations.get(id) ?? []).map(point => ({ ...point })),
      ...(snapshot?.fingerprint ? { programme: canonical(snapshot.state), fingerprint: snapshot.fingerprint } : {}),
      writeEnabled: true, limits: { minC: 5, maxC: 40, stepC: 0.5 }, periods: { min: 4, max: 4 },
      programmeWriteMode: this.writeModes.get(id) ?? 'single-events',
    };
  }

  private async read(id: string) {
    this.requireAvailable(id);
    this.snapshots.set(id, await this.schedules.read(id));
    await this.readSettings(id);
    return this.zone(id);
  }

  private async readSettings(id: string): Promise<NativeSettings> {
    this.requireAvailable(id);
    const response = await this.manager.api.request('get', `/v2.0/cloud/thing/${id}/shadow/properties`, {
      codes: 'ControlMode,Event_Adaptive_Set',
    }, null, { attempts: 1, timeoutMs: 10000 });
    const properties = response.success && response.result?.properties;
    const mode = Array.isArray(properties) ? properties.find(item => item.code === 'ControlMode')?.value : undefined;
    const grouping = Array.isArray(properties) ? properties.find(item => item.code === 'Event_Adaptive_Set')?.value : undefined;
    if (typeof mode !== 'string' || typeof grouping !== 'number' || !Number.isInteger(grouping) || grouping < 0) {
      throw new Error('Could not read the thermostat programme mode and grouping.');
    }
    const settings = { mode, grouping };
    this.settings.set(id, settings);
    return settings;
  }

  private requireSevenDayMode(id: string) {
    const settings = this.settings.get(id);
    if (!settings || (settings.grouping & 1) !== 0) {
      throw new Error('Select seven-day programming in SmartLife before applying weekly programmes.');
    }
  }

  /** Retain this provider queue across the controller's durable draft check; apply only signals its owner. */
  private prepareAutomatic(id: string, programme: WeeklyProgramme): Promise<unknown> {
    if (!this.schedules.prepareAutomatic || !this.schedules.applyAutomatic || !this.schedules.discardAutomatic) {
      return Promise.reject(new Error('This provider does not support owned automatic baselines.'));
    }
    let prepared = false;
    let resolvePreview: (value: unknown) => void;
    let rejectPreview: (error: unknown) => void;
    const preview = new Promise((resolve, reject) => {
      resolvePreview = resolve; rejectPreview = reject;
    });
    let resolveResult: (value: unknown) => void;
    const result = new Promise(resolve => {
      resolveResult = resolve;
    });
    void this.enqueue(id, async () => {
      const baseline = await this.schedules.prepareAutomatic!(id);
      this.snapshots.set(id, baseline.backup);
      const token = randomUUID(), expiresAt = Date.now() + 10000;
      let resolveSignal: (apply: boolean) => void;
      const signal = new Promise<boolean>(resolve => {
        resolveSignal = resolve;
      });
      const lease: AutomaticLease = {token, deviceId: id, programme, managerToken: baseline.token,
        backup: baseline.backup, expiresAt, consumed: false, proceed: value => resolveSignal(value), result};
      this.automaticLeases.set(token, lease);
      const timer = setTimeout(() => lease.proceed(false), Math.max(1, expiresAt - Date.now())); timer.unref();
      prepared = true;
      resolvePreview!({token, deviceId: id, programme, expiresAt,
        changesRequired: JSON.stringify(canonical(baseline.backup.state)) !== JSON.stringify(programme),
        requireScheduled: true, automaticFreshBaseline: true});
      try {
        if (!await signal || this.closed || Date.now() >= expiresAt) {
          resolveResult!({status: 'not-applied', reason: 'The automatic selection was cancelled or expired.', writeAttempted: false});
        } else {
          resolveResult!(await this.applyAutomaticOwned(lease));
        }
      } finally {
        clearTimeout(timer); this.automaticLeases.delete(token); this.schedules.discardAutomatic!(baseline.token);
      }
    }).catch(error => {
      if (!prepared) {
        rejectPreview!(error);
      }
      resolveResult!({status: 'not-applied', reason: text(error), writeAttempted: false});
    });
    return preview;
  }

  private async automaticJournal(token: string, value: object, create: boolean): Promise<void> {
    const parent = path.dirname(this.automaticJournalPath);
    for (const directory of [parent, this.automaticJournalPath]) {
      try {
        await fs.mkdir(directory, {mode: 0o700});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
        || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error('Private operation journal directories are required.');
      }
    }
    const stat = await fs.lstat(this.automaticJournalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('A private automatic-operation journal is required.');
    }
    const file = path.join(this.automaticJournalPath, token + '.json');
    if (create) {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await writePrivateJson(file, value);
    }
  }

  private async applyAutomaticOwned(lease: AutomaticLease) {
    const id = lease.deviceId;
    let writePossible = false;
    let initial: NativeSettings | undefined;
    let journal: object | undefined;
    let readback: ReturnType<TuyaProgrammeProvider['zone']> | undefined;
    try {
      const result = await this.schedules.applyAutomatic!(id, {token: lease.managerToken,
        draft: programmeToFastWarm(lease.programme), writeMode: this.writeModes.get(id) ?? 'single-events',
        beforeApply: async (backup, planned) => {
          if (planned) {
            journal = {version: 1, operationId: lease.token, deviceId: id, startedAt: Date.now(),
              state: 'in-flight', backup, desired: lease.programme, planned,
              writeOutcome: 'not-recorded-until-finished'};
            await this.automaticJournal(lease.token, journal, true);
          }
          initial = await this.readSettings(id);
          this.requireSevenDayMode(id);
          if (this.closed || Date.now() >= lease.expiresAt || initial.mode !== 'smart') {
            throw new Error('Automatic changes require fresh Scheduled mode and an unexpired owned baseline.');
          }
          writePossible = planned > 0;
        },
      });
      this.snapshots.set(id, result.readback ?? result.backup);
      const writeAttempted = result.applied > 0 || result.unknownOutcome === true;
      readback = this.zone(id);
      let outcome;
      if (result.status !== 'verified' && result.status !== 'no_changes') {
        outcome = {status: result.status === 'conflict' ? 'conflict'
          : result.unknownOutcome ? 'unknown' : writeAttempted ? 'unconfirmed' : 'not-applied',
        reason: result.error ?? 'The complete programme was not confirmed. Do not automatically retry.', writeAttempted, readback};
      } else {
        const latest = result.status === 'no_changes' ? initial! : await this.readSettings(id);
        readback = this.zone(id);
        outcome = initial && latest.mode === 'smart' && latest.mode === initial.mode && latest.grouping === initial.grouping
          && readback.programme && JSON.stringify(readback.programme) === JSON.stringify(lease.programme) && readback.scheduled
          ? {status: 'confirmed', reason: 'The complete programme and fresh Scheduled controls are confirmed.', writeAttempted, readback}
          : {status: 'conflict', reason: 'The mode, grouping or complete native week changed during automatic application.',
            writeAttempted, readback};
      }
      if (journal) {
        await this.automaticJournal(lease.token,
          {...journal, finishedAt: Date.now(), state: 'finished', result: outcome}, false);
      }
      return outcome;
    } catch (error) {
      const outcome = {status: writePossible ? 'unknown' : 'not-applied', reason: text(error), writeAttempted: writePossible, readback};
      if (journal) {
        await this.automaticJournal(lease.token,
          {...journal, finishedAt: Date.now(), state: 'failed', result: outcome}, false).catch(() => undefined);
      }
      return outcome;
    }
  }

  private async apply(preview: Preview) {
    const id = preview.deviceId;
    let writeAttempted = false;
    let readback: ReturnType<TuyaProgrammeProvider['zone']> | undefined;
    try {
      this.requireAvailable(id);
      if (preview.expiresAt <= Date.now()) {
        return { status: 'not-applied', reason: 'The programme preview expired. Prepare it again.', writeAttempted: false };
      }
      writeAttempted = true;
      const result = await this.schedules.apply(id, {
        draft: programmeToFastWarm(preview.programme), expectedFingerprint: preview.fingerprint,
        writeMode: this.writeModes.get(id) ?? 'single-events',
        beforeWrite: async () => {
          const current = await this.readSettings(id);
          this.requireSevenDayMode(id);
          if (preview.expiresAt <= Date.now() || current.mode !== preview.settings.mode || current.grouping !== preview.settings.grouping
            || (preview.requireScheduled && current.mode !== 'smart')) {
            throw new Error('The thermostat mode or grouping changed after preview, or the preview expired.');
          }
        },
      });
      const observed = result.readback ?? result.backup;
      this.snapshots.set(id, observed);
      writeAttempted = result.applied > 0 || result.unknownOutcome === true;
      readback = this.zone(id);
      if (result.status === 'conflict') {
        return { status: 'conflict', reason: result.error ?? 'The programme changed after preview.', writeAttempted, readback };
      }
      if (result.status !== 'verified' && result.status !== 'no_changes') {
        return { status: result.unknownOutcome ? 'unknown' : writeAttempted ? 'unconfirmed' : 'not-applied',
          reason: result.error ?? 'The complete programme was not confirmed. Do not automatically retry.', writeAttempted, readback };
      }
      // Recheck controls after the readback so an external Hold/boost does not get silently cancelled.
      const latest = await this.readSettings(id);
      if (latest.mode !== preview.settings.mode || latest.grouping !== preview.settings.grouping
        || (preview.requireScheduled && latest.mode !== 'smart')) {
        return { status: 'conflict', reason: 'The thermostat mode or grouping changed during application.', writeAttempted, readback };
      }
      if (latest.mode !== 'smart') {
        this.requireAvailable(id);
        writeAttempted = true;
        await this.schedules.activateProgramme(id);
        // Manual requests can explicitly resume Scheduled mode. Keep an independent
        // fresh proof after that extra command; automatic switches never use this path.
        readback = await this.read(id);
      } else {
        // The manager already verified a complete fresh week. Pair that same
        // readback with the controls read above instead of requesting the week again.
        readback = this.zone(id);
      }
      // A complete fresh week and Scheduled mode are both required for confirmation.
      if (!readback.programme || JSON.stringify(readback.programme) !== JSON.stringify(preview.programme) || !readback.scheduled) {
        return { status: 'unconfirmed', reason: 'The complete programme and Scheduled mode were not confirmed.', writeAttempted, readback };
      }
      return { status: 'confirmed', reason: 'The complete programme and Scheduled mode are confirmed.', writeAttempted, readback };
    } catch (error) {
      return { status: writeAttempted ? 'unknown' : 'not-applied', reason: text(error), writeAttempted, readback };
    }
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(() => {
      if (this.closed) {
        throw new Error('The programme provider is shutting down.');
      }
      return operation();
    });
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) {
        this.queues.delete(id);
      }
    });
    return result;
  }

  private expirePreviews() {
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= Date.now()) {
        this.previews.delete(token);
      }
    }
    while (this.previews.size >= 64) {
      this.previews.delete(this.previews.keys().next().value!);
    }
  }

  private unit(device: TuyaDevice): 'c' | 'f' | undefined {
    const unit = device.status.find(item => item.code === 'temp_unit_convert')?.value;
    return unit === 'c' || unit === 'f' ? unit : undefined;
  }

  private recordObservation(device: TuyaDevice, point: Omit<DeviceObservation, 'id'>) {
    if (this.closed || !isFastWarmThermostat(device) || !this.devices().some(item => item.id === device.id)
      || !Number.isSafeInteger(point.at) || point.at <= 0 || point.at > Date.now() + 300_000
      || (point.sourceAt !== undefined && (!Number.isSafeInteger(point.sourceAt)
        || point.sourceAt <= 0 || point.sourceAt > point.at + 300_000))) {
      return;
    }
    if (!this.observations.has(device.id) && this.observations.size >= MAX_OBSERVATION_ZONES) {
      return;
    }
    const points = this.observations.get(device.id) ?? [];
    points.push({ id: randomUUID(), ...point });
    if (points.length > MAX_OBSERVATIONS_PER_ZONE) {
      points.splice(0, points.length - MAX_OBSERVATIONS_PER_ZONE);
    }
    this.observations.set(device.id, points);
    let total = [...this.observations.values()].reduce((count, entries) => count + entries.length, 0);
    while (total > MAX_OBSERVATIONS) {
      let oldest: DeviceObservation[] | undefined;
      for (const entries of this.observations.values()) {
        if (entries.length && (!oldest || entries[0].at < oldest[0].at)) {
          oldest = entries;
        }
      }
      oldest?.shift();
      total--;
    }
  }

  private onTemperatureObservation = (device: TuyaDevice, observation: ThermostatTemperatureObservation) => {
    if (!observation || !Number.isInteger(observation.value) || observation.value < 0 || observation.value > 1130) {
      return;
    }
    this.recordObservation(device, { at: observation.receivedAt, sourceAt: observation.reportedAt,
      currentTemperature: observation.value / 10, online: device.online, unit: this.unit(device) });
  };

  private onDeviceStatus = (device: TuyaDevice, statuses: TuyaDeviceStatus[]) => {
    if (!Array.isArray(statuses)) {
      return;
    }
    const target = statuses.find(item => item.code === 'temp_set');
    const report = target && getFastWarmSetTemperatureReport({ ...target, code: 'SetTemp' });
    if (report) {
      this.recordObservation(device, { at: Date.now(), sourceAt: report.time, targetTemperature: report.value / 10,
        online: device.online, unit: this.unit(device) });
    }
  };

  private onDeviceInfo = (device: TuyaDevice) => {
    this.schedules.invalidateGroupCapabilities?.(device.id);
    if (!isFastWarmThermostat(device)) {
      return;
    }
    const previous = this.onlineStates.get(device.id);
    this.onlineStates.set(device.id, device.online);
    if (previous !== undefined && previous !== device.online) {
      this.schedules.invalidateAutomatic?.(device.id);
      this.recordObservation(device, { at: Date.now(), online: device.online });
    }
  };
}
