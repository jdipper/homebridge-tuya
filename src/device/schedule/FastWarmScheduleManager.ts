import { createHash } from 'crypto';
import TuyaOpenAPI from '../../core/TuyaOpenAPI';
import TuyaOpenMQ from '../../core/TuyaOpenMQ';
import TuyaDevice from '../TuyaDevice';
import { isFastWarmThermostat } from '../profile/FastWarmThermostat';
import {
  collectFastWarmSchedule, decodeFastWarmSchedule, encodeFastWarmSchedule, FASTWARM_SCHEDULE_DAYS,
  FastWarmScheduleEvent, FastWarmScheduleReport, FastWarmScheduleState,
} from './FastWarmSchedule';

export interface FastWarmScheduleSnapshot {
  deviceId: string;
  startedAt: number;
  finishedAt: number;
  state: FastWarmScheduleState;
  /** Available only after an acknowledged inquiry returned a complete fresh week. */
  fingerprint: string | null;
  timedOut: boolean;
  errors: string[];
}

export interface FastWarmScheduleApplyResult {
  status: 'verified' | 'no_changes' | 'conflict' | 'partial' | 'failed' | 'unverified';
  backup: FastWarmScheduleSnapshot;
  readback?: FastWarmScheduleSnapshot;
  planned: number;
  /** Commands acknowledged by Tuya; only status=verified confirms the complete resulting week. */
  applied: number;
  error?: string;
  unknownOutcome?: boolean;
}

export interface FastWarmScheduleManagerOptions {
  readTimeoutMs?: number;
  commandTimeoutMs?: number;
  freshnessToleranceMs?: number;
}

interface ReadSession {
  startedAt: number;
  reports: FastWarmScheduleReport[];
  acknowledged: boolean;
  finish: (timedOut: boolean, error?: string) => void;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTimestamp(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) {
    return undefined;
  }
  const milliseconds = Math.trunc(number < 1e12 ? number * 1000 : number);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function fingerprint(state: FastWarmScheduleState): string {
  return createHash('sha256').update(JSON.stringify(state.days.map(day => [day.day, day.events]))).digest('hex');
}

/** Validate and copy the whole draft before queueing any work or making any network call. */
function validateDraft(draft: FastWarmScheduleState): FastWarmScheduleState {
  if (!draft || !Array.isArray(draft.days) || draft.days.length !== 7 || draft.complete !== true) {
    throw new Error('A schedule draft must contain all seven complete days.');
  }
  const seen = new Set<number>();
  const reports: FastWarmScheduleReport[] = [];
  for (const day of draft.days) {
    if (!FASTWARM_SCHEDULE_DAYS.includes(day.day) || seen.has(day.day) || !Array.isArray(day.events) || day.events.length !== 4) {
      throw new Error('A schedule draft must contain each day once and all four events per day.');
    }
    seen.add(day.day);
    const packet = decodeFastWarmSchedule(encodeFastWarmSchedule({ dayMask: day.day, events: day.events }));
    const ordered = [...packet.events].sort((a, b) => a.event - b.event);
    if (ordered.some((event, index) => index > 0
      && event.hour * 60 + event.minute <= ordered[index - 1].hour * 60 + ordered[index - 1].minute)) {
      throw new Error('Wake, Leave, Return and Sleep times must increase within each day.');
    }
    reports.push({ packet });
  }
  const state = collectFastWarmSchedule(reports);
  if (!state.complete) {
    throw new Error('A schedule draft must contain all 28 events.');
  }
  return state;
}

/** Explicit operations only: construction, reconnects and reports never apply a programme. */
export default class FastWarmScheduleManager {
  private sessions = new Map<string, ReadSession>();
  private queues = new Map<string, Promise<void>>();
  private snapshots = new Map<string, FastWarmScheduleSnapshot>();
  private closed = false;
  private readTimeoutMs: number;
  private commandTimeoutMs: number;
  private freshnessToleranceMs: number;

  constructor(
    private api: TuyaOpenAPI,
    private mq: TuyaOpenMQ,
    private getDevice: (deviceId: string) => TuyaDevice | undefined,
    options: FastWarmScheduleManagerOptions = {},
  ) {
    this.readTimeoutMs = options.readTimeoutMs ?? 30000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15000;
    this.freshnessToleranceMs = options.freshnessToleranceMs ?? 2000;
    if (![this.readTimeoutMs, this.commandTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(this.freshnessToleranceMs) || this.freshnessToleranceMs < 0) {
      throw new Error('Schedule timeouts must be positive integers and freshness tolerance must be nonnegative.');
    }
    this.mq.addRawMessageListener(this.onRawReport);
  }

  read(deviceId: string): Promise<FastWarmScheduleSnapshot> {
    return this.enqueue(deviceId, () => this.readInternal(deviceId));
  }

  getSnapshot(deviceId: string): FastWarmScheduleSnapshot | undefined {
    const snapshot = this.snapshots.get(deviceId);
    return snapshot && JSON.parse(JSON.stringify(snapshot)) as FastWarmScheduleSnapshot;
  }

  apply(
    deviceId: string,
    request: { draft: FastWarmScheduleState; expectedFingerprint: string },
  ): Promise<FastWarmScheduleApplyResult> {
    let draft: FastWarmScheduleState;
    try {
      draft = validateDraft(request?.draft);
      if (!/^[0-9a-f]{64}$/.test(request.expectedFingerprint)) {
        throw new Error('Apply requires the fingerprint of a complete fresh schedule read.');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const expectedFingerprint = request.expectedFingerprint;
    return this.enqueue(deviceId, async () => {
      const backup = await this.readInternal(deviceId);
      if (!backup.fingerprint) {
        return { status: 'failed', backup, planned: 0, applied: 0, error: 'Could not read a complete fresh backup; no schedule was sent.' };
      }
      if (backup.fingerprint !== expectedFingerprint) {
        return { status: 'conflict', backup, planned: 0, applied: 0, error: 'The thermostat schedule changed. Refresh before applying.' };
      }
      const commands: { day: number; event: FastWarmScheduleEvent }[] = [];
      draft.days.forEach((day, index) => day.events.forEach((event, eventIndex) => {
        if (JSON.stringify(event) !== JSON.stringify(backup.state.days[index].events[eventIndex])) {
          commands.push({ day: day.day, event });
        }
      }));
      if (commands.length === 0) {
        return { status: 'no_changes', backup, planned: 0, applied: 0 };
      }

      let applied = 0;
      let writeError: string | undefined;
      let unknownOutcome = false;
      for (const command of commands) {
        let submitted = false;
        try {
          this.requireDevice(deviceId);
          submitted = true;
          await this.issue(deviceId, { week_program: encodeFastWarmSchedule({ dayMask: command.day, events: [command.event] }) });
          applied++;
        } catch (error) {
          writeError = errorText(error);
          unknownOutcome = submitted && !(error instanceof ScheduleCommandRejected);
          break;
        }
      }

      let readback: FastWarmScheduleSnapshot | undefined;
      try {
        readback = await this.readInternal(deviceId);
      } catch (error) {
        writeError = writeError ?? errorText(error);
      }
      if (writeError) {
        return {
          status: applied > 0 ? 'partial' : 'failed', backup, readback, planned: commands.length, applied,
          error: writeError, unknownOutcome,
        };
      }
      if (readback?.fingerprint === fingerprint(draft)) {
        return { status: 'verified', backup, readback, planned: commands.length, applied };
      }
      return {
        status: 'unverified', backup, readback, planned: commands.length, applied,
        error: 'The complete resulting programme could not be verified. Do not automatically retry.', unknownOutcome: true,
      };
    });
  }

  /** Separate explicit activation; writing a schedule never changes mode or power. */
  activateProgramme(deviceId: string): Promise<void> {
    return this.enqueue(deviceId, async () => {
      this.requireDevice(deviceId);
      await this.issue(deviceId, { ControlMode: 'smart' });
    });
  }

  close() {
    this.closed = true;
    this.mq.removeRawMessageListener(this.onRawReport);
    for (const session of [...this.sessions.values()]) {
      session.finish(false, 'Schedule manager closed.');
    }
  }

  private enqueue<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.requireDevice(deviceId);
      return operation();
    };
    const result = (this.queues.get(deviceId) ?? Promise.resolve()).then(run);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(deviceId, tail);
    void tail.then(() => {
      if (this.queues.get(deviceId) === tail) {
        this.queues.delete(deviceId);
      }
    });
    return result;
  }

  private requireDevice(deviceId: string) {
    if (this.closed) {
      throw new Error('Schedule manager is closed.');
    }
    const device = this.getDevice(deviceId);
    if (!device || !isFastWarmThermostat(device)) {
      throw new Error('Schedules are supported only for the verified FastWarm ET-63 product.');
    }
    if (!device.online) {
      throw new Error('The thermostat is offline; no schedule command was sent.');
    }
    if (device.status.find(status => status.code === 'temp_unit_convert')?.value.toString().toLowerCase() !== 'c') {
      throw new Error('Schedule commands require the verified Celsius configuration.');
    }
    return device;
  }

  private async issue(deviceId: string, properties: Record<string, string | boolean>) {
    const response = await this.api.postOnce(`/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`, {
      properties: JSON.stringify(properties),
    }, { timeoutMs: this.commandTimeoutMs });
    if (response.success !== true) {
      throw new ScheduleCommandRejected(`${response.code}: ${response.msg}`);
    }
  }

  private readInternal(deviceId: string): Promise<FastWarmScheduleSnapshot> {
    this.requireDevice(deviceId);
    return new Promise(resolve => {
      const session: ReadSession = {
        startedAt: Date.now(), reports: [], acknowledged: false,
        finish: (timedOut, error) => {
          if (this.sessions.get(deviceId) !== session) {
            return;
          }
          clearTimeout(timer);
          this.sessions.delete(deviceId);
          const state = collectFastWarmSchedule(session.reports);
          const errors = error ? [error] : [];
          if (!session.acknowledged && !error) {
            errors.push('The programme inquiry was not acknowledged before the read ended.');
          }
          const snapshot: FastWarmScheduleSnapshot = {
            deviceId, startedAt: session.startedAt, finishedAt: Date.now(), state, timedOut, errors,
            fingerprint: state.complete && session.acknowledged && errors.length === 0 ? fingerprint(state) : null,
          };
          this.snapshots.set(deviceId, snapshot);
          resolve(JSON.parse(JSON.stringify(snapshot)) as FastWarmScheduleSnapshot);
        },
      };
      const timer = setTimeout(() => session.finish(true), this.readTimeoutMs);
      this.sessions.set(deviceId, session);
      // The listener and session are present before requesting the programme.
      void this.issue(deviceId, { inquire: true }).then(() => {
        session.acknowledged = true;
        if (collectFastWarmSchedule(session.reports).complete) {
          session.finish(false);
        }
      }, error => session.finish(false, errorText(error)));
    });
  }

  private onRawReport = (_topic: string, protocol: number, message: unknown, timestamp: number) => {
    if (protocol !== 4 || !message || typeof message !== 'object') {
      return;
    }
    const data = message as { devId?: string; status?: unknown[] };
    if (!data.devId || !Array.isArray(data.status)) {
      return;
    }
    const device = this.getDevice(data.devId);
    const session = this.sessions.get(data.devId);
    if (!session || !device || !isFastWarmThermostat(device) || !device.online) {
      return;
    }
    for (const value of data.status) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const report = value as Record<string, unknown>;
      const numericKey = Object.prototype.hasOwnProperty.call(report, '119');
      const id = report.dp_id ?? report.dpId;
      if (report.code !== 'week_program' && id !== 119 && id !== '119' && !numericKey) {
        continue;
      }
      const raw = numericKey ? report['119'] : report.value;
      const reportedAt = normalizeTimestamp(report.t) ?? normalizeTimestamp(report.time) ?? normalizeTimestamp(timestamp);
      if (typeof raw !== 'string' || reportedAt === undefined
        || reportedAt < session.startedAt - this.freshnessToleranceMs || reportedAt > Date.now() + this.freshnessToleranceMs) {
        continue;
      }
      try {
        const packet = decodeFastWarmSchedule(raw);
        if (session.reports.length >= 1024) {
          session.finish(false, 'Too many programme reports; a complete read could not be established.');
          return;
        }
        session.reports.push({ packet, reportedAt });
        if (session.acknowledged && collectFastWarmSchedule(session.reports).complete) {
          session.finish(false);
          return;
        }
      } catch {
        // Invalid programme chunks cannot establish any missing schedule entries.
      }
    }
  };
}

class ScheduleCommandRejected extends Error {}
