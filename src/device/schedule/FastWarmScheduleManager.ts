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
  /** Readback inquiries attempted after the writes; these never replay a programme command. */
  verificationReads?: number;
}

export interface FastWarmScheduleManagerOptions {
  readTimeoutMs?: number;
  commandTimeoutMs?: number;
  freshnessToleranceMs?: number;
  verificationAttempts?: number;
  verificationDelayMs?: number;
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

function verificationDetails(snapshot: FastWarmScheduleSnapshot | undefined, draft: FastWarmScheduleState): string {
  if (!snapshot) {
    return 'No complete readback was available.';
  }
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const eventNames = ['Wake', 'Leave', 'Return', 'Sleep'];
  const missing: string[] = [];
  const different: string[] = [];
  draft.days.forEach((day, dayIndex) => day.events.forEach(event => {
    const actual = snapshot.state.days.find(item => item.day === day.day)?.events.find(item => item.event === event.event);
    const label = `${dayNames[dayIndex]} ${eventNames[event.event]}`;
    if (!actual) {
      missing.push(label);
    } else if (JSON.stringify(actual) !== JSON.stringify(event)) {
      different.push(label);
    }
  }));
  const describe = (labels: string[]) => labels.slice(0, 3).join(', ') + (labels.length > 3 ? ', …' : '');
  const details: string[] = [];
  if (missing.length) {
    details.push(`${missing.length} missing ${missing.length === 1 ? 'period' : 'periods'} (${describe(missing)})`);
  }
  if (different.length) {
    details.push(`${different.length} differing ${different.length === 1 ? 'period' : 'periods'} (${describe(different)})`);
  }
  if (snapshot.errors.length) {
    details.push(snapshot.errors.join(' '));
  } else if (snapshot.timedOut) {
    details.push('the latest inquiry timed out');
  }
  return details.length ? details.join('; ') + '.' : 'The latest readback did not establish an acknowledged complete programme.';
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
  private verificationAttempts: number;
  private verificationDelayMs: number;
  private verificationDelays = new Set<() => void>();

  constructor(
    private api: TuyaOpenAPI,
    private mq: TuyaOpenMQ,
    private getDevice: (deviceId: string) => TuyaDevice | undefined,
    options: FastWarmScheduleManagerOptions = {},
  ) {
    this.readTimeoutMs = options.readTimeoutMs ?? 30000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15000;
    this.freshnessToleranceMs = options.freshnessToleranceMs ?? 2000;
    this.verificationAttempts = options.verificationAttempts ?? 3;
    this.verificationDelayMs = options.verificationDelayMs ?? 1000;
    if (![this.readTimeoutMs, this.commandTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(this.freshnessToleranceMs) || this.freshnessToleranceMs < 0) {
      throw new Error('Schedule timeouts must be positive integers and freshness tolerance must be nonnegative.');
    }
    if (!Number.isSafeInteger(this.verificationAttempts) || this.verificationAttempts < 1 || this.verificationAttempts > 3
      || !Number.isSafeInteger(this.verificationDelayMs) || this.verificationDelayMs < 0 || this.verificationDelayMs > 60000) {
      throw new Error('Schedule verification requires 1 to 3 attempts and a delay from 0 to 60000 milliseconds.');
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
      let verificationReads = 0;
      const targetFingerprint = fingerprint(draft);
      try {
        // Tuya's command acknowledgement can precede the thermostat applying its
        // final event. Repeat only the inquiry, never any programme or mode write.
        do {
          if (verificationReads > 0) {
            await this.waitForVerification(deviceId);
          }
          this.requireDevice(deviceId);
          verificationReads++;
          readback = await this.readInternal(deviceId);
          if (writeError || readback.fingerprint === targetFingerprint) {
            break;
          }
        } while (verificationReads < this.verificationAttempts);
      } catch (error) {
        writeError = writeError ?? errorText(error);
      }
      if (writeError) {
        return {
          status: applied > 0 ? 'partial' : 'failed', backup, readback, planned: commands.length, applied,
          error: writeError, unknownOutcome, verificationReads,
        };
      }
      if (readback?.fingerprint === targetFingerprint) {
        return { status: 'verified', backup, readback, planned: commands.length, applied, verificationReads };
      }
      return {
        status: 'unverified', backup, readback, planned: commands.length, applied,
        error: `The complete resulting programme could not be verified after ${verificationReads} readback `
          + `${verificationReads === 1 ? 'attempt' : 'attempts'}: ${verificationDetails(readback, draft)} Do not automatically retry.`,
        unknownOutcome: true, verificationReads,
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
    for (const finish of [...this.verificationDelays]) {
      finish();
    }
  }

  private waitForVerification(deviceId: string): Promise<void> {
    this.requireDevice(deviceId);
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.verificationDelays.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, this.verificationDelayMs);
      this.verificationDelays.add(finish);
    });
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
