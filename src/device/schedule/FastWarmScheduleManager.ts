import { createHash, randomUUID } from 'crypto';
import TuyaOpenAPI from '../../core/TuyaOpenAPI';
import TuyaOpenMQ, { TuyaMQConnectionEvent } from '../../core/TuyaOpenMQ';
import TuyaDevice from '../TuyaDevice';
import { isFastWarmThermostat } from '../profile/FastWarmThermostat';
import { FastWarmLanConnectionEvent, FastWarmLanTransport } from '../lan/FastWarmLanTransport';
import FastWarmGroupCommandBroker, { FastWarmGroupCommandRejected, FastWarmProgrammeGroup } from './FastWarmGroupCommandBroker';
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
  /** A local cancellation guard stopped unsent commands; no failed/unknown native write is covered. */
  superseded?: boolean;
  /** Readback inquiries attempted after the writes; these never replay a programme command. */
  verificationReads?: number;
}

export interface FastWarmScheduleManagerOptions {
  localTransport?: FastWarmLanTransport;
  programmeGroups?: FastWarmProgrammeGroup[];
  readTimeoutMs?: number;
  commandTimeoutMs?: number;
  freshnessToleranceMs?: number;
  verificationAttempts?: number;
  verificationDelayMs?: number;
  /** Quiet time after a programme packet's HTTP acknowledgement, before the next packet for that thermostat. */
  writeIntervalMs?: number;
}

/** Packet shapes are opt-in per thermostat after independent hardware validation. */
export type FastWarmProgrammeWriteMode = 'single-events' | 'grouped-events' | 'whole-days' | 'grouped-days';
export interface FastWarmScheduleWrite {
  dayMask: number;
  events: FastWarmScheduleEvent[];
  payload: string;
}
export interface FastWarmScheduleApplyRequest {
  draft: FastWarmScheduleState;
  expectedFingerprint: string;
  writeMode?: FastWarmProgrammeWriteMode;
  /** Runs after the fresh week comparison, immediately before the first schedule write. */
  beforeWrite?: () => Promise<void>;
}

export interface FastWarmAutomaticPreparation {
  token: string;
  backup: FastWarmScheduleSnapshot;
}
export interface FastWarmAutomaticApplyRequest {
  token: string;
  draft: FastWarmScheduleState;
  writeMode?: FastWarmProgrammeWriteMode;
  /** Must persist the fresh backup and validate current controls before any command. */
  beforeApply: (backup: FastWarmScheduleSnapshot, planned: number) => Promise<void>;
  /** Household cancellation is independent of native report changes caused by our own writes. */
  isCurrent?: () => boolean;
}
interface AutomaticPreparation extends FastWarmAutomaticPreparation {
  deviceId: string;
  generation: number;
  reportRevision: number;
  connectionRevision: number;
  availabilityRevision: number;
  expiresAt: number;
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

/** Never manufacture two/three-event packets: DP119 permits one event or a complete day. */
export function planFastWarmScheduleWrites(backup: FastWarmScheduleState, desired: FastWarmScheduleState,
  mode: FastWarmProgrammeWriteMode = 'single-events'): FastWarmScheduleWrite[] {
  const before = validateDraft(backup), draft = validateDraft(desired);
  if (!['single-events', 'grouped-events', 'whole-days', 'grouped-days'].includes(mode)) {
    throw new Error('Choose a supported, validated FastWarm programme write mode.');
  }
  const packets: { dayMask: number; events: FastWarmScheduleEvent[] }[] = [];
  for (const [index, day] of draft.days.entries()) {
    const changed = day.events.filter((event, eventIndex) =>
      JSON.stringify(event) !== JSON.stringify(before.days[index].events[eventIndex]));
    if (!changed.length) {
      continue;
    }
    const eventGroups = mode === 'whole-days' || mode === 'grouped-days' ? [day.events] : changed.map(event => [event]);
    for (const events of eventGroups) {
      const same = mode === 'grouped-events' || mode === 'grouped-days'
        ? packets.find(packet => JSON.stringify(packet.events) === JSON.stringify(events)) : undefined;
      if (same) {
        same.dayMask |= day.day;
      } else {
        packets.push({ dayMask: day.day, events: events.map(event => ({ ...event })) });
      }
    }
  }
  return packets.map(packet => ({ ...packet, payload: encodeFastWarmSchedule(packet) }));
}

/** Explicit operations only: construction, reconnects and reports never apply a programme. */
export default class FastWarmScheduleManager {
  private sessions = new Map<string, ReadSession>();
  private queues = new Map<string, Promise<void>>();
  private snapshots = new Map<string, FastWarmScheduleSnapshot>();
  private closed = false;
  private automaticPreparations = new Map<string, AutomaticPreparation>();
  private automaticBaselines = new Map<string, AutomaticPreparation>();
  private readGenerations = new Map<string, number>();
  private reportRevisions = new Map<string, number>();
  private connectionRevision = 0;
  private availabilityRevisions = new Map<string, number>();
  private readTimeoutMs: number;
  private commandTimeoutMs: number;
  private freshnessToleranceMs: number;
  private verificationAttempts: number;
  private verificationDelayMs: number;
  private verificationDelays = new Set<() => void>();
  private writeIntervalMs: number;
  private writeAcknowledgedAt = new Map<string, number>();
  private writeDelays = new Map<string, () => void>();
  private readonly groups: FastWarmGroupCommandBroker;
  private readonly localTransport?: FastWarmLanTransport;

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
    this.writeIntervalMs = options.writeIntervalMs ?? 1000;
    this.localTransport = options.localTransport;
    // A mixed group would send a selected thermostat both cloud and LAN commands.
    const cloudGroups = options.programmeGroups?.filter(group =>
      !group.deviceIds.some(id => this.localTransport?.has(id)));
    this.groups = new FastWarmGroupCommandBroker(api, cloudGroups, this.commandTimeoutMs);
    if (![this.readTimeoutMs, this.commandTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(this.freshnessToleranceMs) || this.freshnessToleranceMs < 0) {
      throw new Error('Schedule timeouts must be positive integers and freshness tolerance must be nonnegative.');
    }
    if (!Number.isSafeInteger(this.verificationAttempts) || this.verificationAttempts < 1 || this.verificationAttempts > 3
      || !Number.isSafeInteger(this.verificationDelayMs) || this.verificationDelayMs < 0 || this.verificationDelayMs > 60000) {
      throw new Error('Schedule verification requires 1 to 3 attempts and a delay from 0 to 60000 milliseconds.');
    }
    if (!Number.isSafeInteger(this.writeIntervalMs) || this.writeIntervalMs < 0 || this.writeIntervalMs > 60000) {
      throw new Error('Schedule write interval must be from 0 to 60000 milliseconds.');
    }
    this.mq.addRawMessageListener(this.onRawReport);
    this.mq.addConnectionListener(this.onConnection);
    this.localTransport?.addRawMessageListener(this.onLanRawReport);
    this.localTransport?.addConnectionListener(this.onLanConnection);
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
    request: FastWarmScheduleApplyRequest,
  ): Promise<FastWarmScheduleApplyResult> {
    let draft: FastWarmScheduleState;
    try {
      draft = validateDraft(request?.draft);
      if (!/^[0-9a-f]{64}$/.test(request.expectedFingerprint)) {
        throw new Error('Apply requires the fingerprint of a complete fresh schedule read.');
      }
      if (request.writeMode !== undefined
        && !['single-events', 'grouped-events', 'whole-days', 'grouped-days'].includes(request.writeMode)) {
        throw new Error('Choose a supported, validated FastWarm programme write mode.');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const expectedFingerprint = request.expectedFingerprint;
    return this.enqueue(deviceId, async () => this.applyFromBackup(deviceId, draft,
      await this.readInternal(deviceId), expectedFingerprint, request.writeMode, request.beforeWrite));
  }

  /** One-use baseline handle; callers retain their per-device queue until apply/discard. */
  prepareAutomatic(deviceId: string): Promise<FastWarmAutomaticPreparation> {
    return this.enqueue(deviceId, async () => {
      const connectionRevision = this.connectionFor(deviceId);
      const availabilityRevision = this.availabilityRevisions.get(deviceId) ?? 0;
      if (!this.messageConnected(deviceId)) {
        throw new Error('A live Tuya message connection is required for an owned automatic baseline.');
      }
      const backup = await this.readInternal(deviceId, true);
      if (connectionRevision !== this.connectionFor(deviceId) || !this.messageConnected(deviceId)
        || availabilityRevision !== (this.availabilityRevisions.get(deviceId) ?? 0)) {
        throw new Error('The message connection changed during the automatic baseline read.');
      }
      if (!backup.fingerprint) {
        throw new Error('Could not read a complete fresh automatic backup; no schedule was sent.');
      }
      for (const [token, item] of this.automaticPreparations) {
        if (item.expiresAt <= Date.now() || item.deviceId === deviceId) {
          this.automaticPreparations.delete(token);
        }
      }
      const token = randomUUID();
      const prepared = {token, deviceId, backup: structuredClone(backup),
        generation: this.readGenerations.get(deviceId)!, reportRevision: this.reportRevisions.get(deviceId) ?? 0,
        connectionRevision, availabilityRevision, expiresAt: Date.now() + 10000};
      this.automaticPreparations.set(token, prepared); this.automaticBaselines.set(deviceId, prepared);
      return {token, backup: structuredClone(backup)};
    });
  }

  discardAutomatic(token: string): void {
    const prepared = this.automaticPreparations.get(token);
    this.automaticPreparations.delete(token);
    if (prepared && this.automaticBaselines.get(prepared.deviceId) === prepared) {
      this.automaticBaselines.delete(prepared.deviceId);
    }
  }

  applyAutomatic(deviceId: string, request: FastWarmAutomaticApplyRequest): Promise<FastWarmScheduleApplyResult> {
    let draft: FastWarmScheduleState;
    try {
      draft = validateDraft(request?.draft);
      if (typeof request.beforeApply !== 'function') {
        throw new Error('A durable backup and fresh control guard are required.');
      }
      if (request.writeMode !== undefined
        && !['single-events', 'grouped-events', 'whole-days', 'grouped-days'].includes(request.writeMode)) {
        throw new Error('Choose a supported, validated FastWarm programme write mode.');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const prepared = this.automaticPreparations.get(request.token);
    this.automaticPreparations.delete(request.token);
    if (!prepared || prepared.deviceId !== deviceId) {
      return Promise.reject(new Error('The automatic baseline expired or was consumed.'));
    }
    return this.enqueue(deviceId, async () => {
      try {
        if (!this.ownedBaselineUnchanged(prepared)) {
          return {status: 'conflict', backup: prepared.backup, planned: 0, applied: 0,
            error: 'The owned automatic baseline changed or expired; no schedule was sent.'};
        }
        return await this.applyFromBackup(deviceId, draft, prepared.backup, prepared.backup.fingerprint!,
          request.writeMode, async (backup, planned) => {
            await request.beforeApply(backup, planned);
            if (!this.ownedBaselineUnchanged(prepared)) {
              throw new Error('The native programme or message connection changed before automatic upload; no schedule was sent.');
            }
          }, true, () => this.ownedBaselineUnchanged(prepared), true, request.isCurrent);
      } finally {
        if (this.automaticBaselines.get(deviceId) === prepared) {
          this.automaticBaselines.delete(deviceId);
        }
      }
    });
  }

  private ownedBaselineUnchanged(prepared: AutomaticPreparation): boolean {
    return !this.closed && this.automaticBaselines.get(prepared.deviceId) === prepared
      && prepared.expiresAt > Date.now() && this.readGenerations.get(prepared.deviceId) === prepared.generation
      && (this.reportRevisions.get(prepared.deviceId) ?? 0) === prepared.reportRevision
      && this.connectionFor(prepared.deviceId) === prepared.connectionRevision && this.messageConnected(prepared.deviceId)
      && (this.availabilityRevisions.get(prepared.deviceId) ?? 0) === prepared.availabilityRevision;
  }

  invalidateAutomatic(deviceId: string): void {
    this.availabilityRevisions.set(deviceId, (this.availabilityRevisions.get(deviceId) ?? 0) + 1);
    this.writeDelays.get(deviceId)?.();
    this.groups.invalidateCapabilities(deviceId);
  }

  invalidateGroupCapabilities(deviceId: string): void {
    this.groups.invalidateCapabilities(deviceId);
  }

  private onConnection = (event?: TuyaMQConnectionEvent) => {
    this.connectionRevision++;
    for (const [id, finish] of [...this.writeDelays.entries()]) {
      if (!this.localTransport?.has(id)) {
        finish();
      }
    }
    if (!event || !event.connected || event.recoveryRequired) {
      this.groups.invalidateCapabilities();
    }
  };

  private connectionFor(deviceId: string): number {
    return this.localTransport?.has(deviceId) ? this.localTransport.generation(deviceId) : this.connectionRevision;
  }

  private messageConnected(deviceId: string): boolean {
    return this.localTransport?.has(deviceId) ? this.localTransport.isConnected(deviceId) : this.mq.isConnected();
  }

  private onLanConnection = (event: FastWarmLanConnectionEvent) => {
    if (!this.localTransport?.has(event.deviceId)) {
      return;
    }
    this.availabilityRevisions.set(event.deviceId, (this.availabilityRevisions.get(event.deviceId) ?? 0) + 1);
    this.writeDelays.get(event.deviceId)?.();
  };

  private async applyFromBackup(deviceId: string, draft: FastWarmScheduleState, backup: FastWarmScheduleSnapshot,
    expectedFingerprint: string | undefined, writeMode: FastWarmProgrammeWriteMode | undefined,
    beforeWrite?: (backup: FastWarmScheduleSnapshot, planned: number) => Promise<void>, guardNoChanges = false,
    beforeFirstDispatch?: () => boolean, allowGroup = false, isCurrent?: () => boolean,
  ): Promise<FastWarmScheduleApplyResult> {
    if (!backup.fingerprint) {
      return { status: 'failed', backup, planned: 0, applied: 0, error: 'Could not read a complete fresh backup; no schedule was sent.' };
    }
    if (expectedFingerprint !== undefined && backup.fingerprint !== expectedFingerprint) {
      return { status: 'conflict', backup, planned: 0, applied: 0, error: 'The thermostat schedule changed. Refresh before applying.' };
    }
    const commands = planFastWarmScheduleWrites(backup.state, draft,
      this.localTransport?.has(deviceId) ? 'single-events' : writeMode);
    const connectionRevision = this.connectionFor(deviceId);
    const availabilityRevision = this.availabilityRevisions.get(deviceId) ?? 0;
    const writeContextCurrent = () => !this.closed && connectionRevision === this.connectionFor(deviceId)
      && availabilityRevision === (this.availabilityRevisions.get(deviceId) ?? 0);
    if (commands.length === 0 && !guardNoChanges) {
      return { status: 'no_changes', backup, planned: 0, applied: 0 };
    }

    try {
      if (isCurrent?.() === false) {
        throw new FastWarmSelectionSuperseded('The automatic selection was superseded before upload.');
      }
      if (commands.length > 0) {
        // Keep any cross-operation cooldown ahead of the final fresh-control guard.
        await this.waitForWriteInterval(deviceId);
        this.requireDevice(deviceId);
        if (!writeContextCurrent()) {
          throw new ScheduleCommandNotSent('The thermostat or message connection changed before upload; no schedule was sent.');
        }
        if (isCurrent?.() === false) {
          throw new FastWarmSelectionSuperseded('The automatic selection was superseded before upload.');
        }
      }
      await beforeWrite?.(backup, commands.length);
      if (isCurrent?.() === false) {
        throw new FastWarmSelectionSuperseded('The automatic selection was superseded before upload.');
      }
    } catch (error) {
      return { status: 'conflict', backup, planned: commands.length, applied: 0,
        error: errorText(error), unknownOutcome: false,
        ...(error instanceof FastWarmSelectionSuperseded ? {superseded: true} : {}) };
    }

    if (commands.length === 0) {
      return { status: 'no_changes', backup, planned: 0, applied: 0 };
    }
    let applied = 0;
    let writeError: string | undefined;
    let unknownOutcome = false;
    let superseded = false;
    for (const command of commands) {
      let submitted = false;
      try {
        if (applied > 0) {
          await this.waitForWriteInterval(deviceId);
        }
        this.requireDevice(deviceId);
        if (!writeContextCurrent()) {
          throw new ScheduleCommandNotSent('The thermostat or message connection changed; remaining schedule commands were not sent.');
        }
        if (isCurrent?.() === false) {
          throw new FastWarmSelectionSuperseded('The automatic selection was superseded; remaining commands were not sent.');
        }
        submitted = true;
        const shouldProceed = () => {
          if (!writeContextCurrent() || isCurrent?.() === false || (applied === 0 && beforeFirstDispatch?.() === false)) {
            return false;
          }
          try {
            this.requireDevice(deviceId);
            return true;
          } catch {
            return false;
          }
        };
        await this.issue(deviceId, { week_program: command.payload }, shouldProceed,
          allowGroup && commands.length === 1);
        this.writeAcknowledgedAt.set(deviceId, performance.now());
        applied++;
      } catch (error) {
        writeError = errorText(error);
        unknownOutcome = submitted && !(error instanceof ScheduleCommandRejected) && !(error instanceof FastWarmGroupCommandRejected)
          && !(error instanceof ScheduleCommandNotSent);
        superseded = error instanceof FastWarmSelectionSuperseded
          || (isCurrent?.() === false && (error instanceof ScheduleCommandNotSent || error instanceof FastWarmGroupCommandRejected));
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
        readback = await this.readInternal(deviceId, allowGroup);
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
        error: writeError, unknownOutcome, verificationReads, ...(superseded && !unknownOutcome ? {superseded: true} : {}),
      };
    }
    if (readback?.fingerprint === targetFingerprint) {
      return { status: 'verified', backup, readback, planned: commands.length, applied, verificationReads,
        ...(isCurrent?.() === false ? {superseded: true} : {}) };
    }
    return {
      status: 'unverified', backup, readback, planned: commands.length, applied,
      error: `The complete resulting programme could not be verified after ${verificationReads} readback `
        + `${verificationReads === 1 ? 'attempt' : 'attempts'}: ${verificationDetails(readback, draft)} Do not automatically retry.`,
      unknownOutcome: true, verificationReads,
    };
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
    this.groups.close();
    this.automaticPreparations.clear(); this.automaticBaselines.clear();
    this.mq.removeRawMessageListener(this.onRawReport);
    this.mq.removeConnectionListener(this.onConnection);
    this.localTransport?.removeRawMessageListener(this.onLanRawReport);
    this.localTransport?.removeConnectionListener(this.onLanConnection);
    for (const session of [...this.sessions.values()]) {
      session.finish(false, 'Schedule manager closed.');
    }
    for (const finish of [...this.verificationDelays]) {
      finish();
    }
    for (const finish of [...this.writeDelays.values()]) {
      finish();
    }
    this.writeAcknowledgedAt.clear();
  }

  private waitForWriteInterval(deviceId: string): Promise<void> {
    this.requireDevice(deviceId);
    const acknowledgedAt = this.writeAcknowledgedAt.get(deviceId);
    const remaining = acknowledgedAt === undefined ? 0 : Math.ceil(acknowledgedAt + this.writeIntervalMs - performance.now());
    if (remaining <= 0) {
      return Promise.resolve();
    }
    // HTTP acceptance can precede the thermostat applying a packet. Give each
    // device a quiet interval instead of sending its next period immediately.
    // This is a delivery mitigation; only the complete native readback confirms it.
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.writeDelays.delete(deviceId);
        resolve();
      };
      const timer = setTimeout(finish, remaining);
      this.writeDelays.set(deviceId, finish);
    });
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
    if (this.localTransport?.has(deviceId)) {
      if (!this.localTransport.isConnected(deviceId)) {
        throw new Error('The local thermostat connection is unavailable; no cloud fallback was attempted.');
      }
      // The local transport checks native Celsius status at its coherent dispatch boundary.
      return device;
    }
    if (!device.online) {
      throw new Error('The thermostat is offline; no schedule command was sent.');
    }
    if (device.status.find(status => status.code === 'temp_unit_convert')?.value.toString().toLowerCase() !== 'c') {
      throw new Error('Schedule commands require the verified Celsius configuration.');
    }
    return device;
  }

  private async issue(deviceId: string, properties: Record<string, string | boolean>, shouldProceed?: () => boolean, allowGroup = false) {
    if (this.localTransport?.has(deviceId)) {
      try {
        await this.localTransport.issueOnce(deviceId, properties,
          {timeoutMs: this.commandTimeoutMs, shouldProceed});
      } catch (error) {
        if (error && typeof error === 'object' && 'writeAttempted' in error && error.writeAttempted === false) {
          throw new ScheduleCommandNotSent(errorText(error));
        }
        throw error;
      }
      return;
    }
    if (allowGroup && (properties.inquire === true || typeof properties.week_program === 'string')) {
      const guard = () => {
        this.requireDevice(deviceId);
        return this.messageConnected(deviceId) && shouldProceed?.() !== false;
      };
      await this.groups.send(deviceId, properties.inquire === true ? {inquire: true} : {week_program: properties.week_program as string},
        guard, () => this.issue(deviceId, properties, guard));
      return;
    }
    let blocked = false;
    const dispatchGuard = shouldProceed && (() => {
      const allowed = shouldProceed(); if (!allowed) {
        blocked = true;
      } return allowed;
    });
    const response = await this.api.postOnce(`/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`, {
      properties: JSON.stringify(properties),
    }, { timeoutMs: this.commandTimeoutMs, ...(dispatchGuard === undefined ? {} : { shouldProceed: dispatchGuard }) });
    if (blocked) {
      throw new ScheduleCommandNotSent('The local command guard stopped transmission.');
    }
    if (response.success !== true) {
      throw new ScheduleCommandRejected(`${response.code}: ${response.msg}`);
    }
  }

  private readInternal(deviceId: string, allowGroup = false): Promise<FastWarmScheduleSnapshot> {
    this.requireDevice(deviceId);
    this.readGenerations.set(deviceId, (this.readGenerations.get(deviceId) ?? 0) + 1);
    if (this.localTransport?.has(deviceId)) {
      const generation = this.connectionFor(deviceId);
      const requestedAt = Date.now();
      return this.localTransport.readSchedule(deviceId, {timeoutMs: this.readTimeoutMs}).then(read => {
        const snapshot: FastWarmScheduleSnapshot = {deviceId, ...structuredClone(read)};
        if (!Number.isSafeInteger(snapshot.startedAt) || !Number.isSafeInteger(snapshot.finishedAt)
          || snapshot.startedAt < requestedAt - this.freshnessToleranceMs
          || snapshot.finishedAt < snapshot.startedAt || snapshot.finishedAt > Date.now() + this.freshnessToleranceMs) {
          snapshot.errors.push('The local programme read did not establish a fresh inquiry window.');
        }
        if (!this.messageConnected(deviceId) || generation !== this.connectionFor(deviceId)) {
          snapshot.errors.push('The local connection changed during the programme inquiry.');
        }
        if (snapshot.state.complete) {
          validateDraft(snapshot.state);
        }
        if (!snapshot.state.complete || snapshot.timedOut || snapshot.errors.length
          || snapshot.fingerprint !== fingerprint(snapshot.state)) {
          snapshot.fingerprint = null;
        }
        this.snapshots.set(deviceId, snapshot);
        return structuredClone(snapshot);
      });
    }
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
      void this.issue(deviceId, { inquire: true },
        allowGroup ? () => this.sessions.get(deviceId) === session : undefined, allowGroup).then(() => {
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
    if (this.localTransport?.has(data.devId)) {
      return;
    }
    const device = this.getDevice(data.devId);
    const session = this.sessions.get(data.devId);
    if (!device || !isFastWarmThermostat(device) || !device.online) {
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
      const ownedBaseline = this.automaticBaselines.get(data.devId);
      const minimumReportTime = session?.startedAt ?? ownedBaseline?.backup.startedAt ?? Date.now();
      const reportedAt = normalizeTimestamp(report.t) ?? normalizeTimestamp(report.time) ?? normalizeTimestamp(timestamp);
      if (typeof raw !== 'string' || reportedAt === undefined
        || reportedAt < minimumReportTime - this.freshnessToleranceMs
        || reportedAt > Date.now() + this.freshnessToleranceMs) {
        continue;
      }
      try {
        const packet = decodeFastWarmSchedule(raw);
        this.reportRevisions.set(data.devId, (this.reportRevisions.get(data.devId) ?? 0) + 1);
        if (!session) {
          continue;
        }
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

  private onLanRawReport = (_topic: string, protocol: number, message: unknown) => {
    if (protocol !== 4 || !message || typeof message !== 'object') {
      return;
    }
    const data = message as {devId?: string; status?: unknown[]; source?: string};
    if (data.source !== 'lan' || !data.devId || !this.localTransport?.has(data.devId) || !Array.isArray(data.status)) {
      return;
    }
    // Collection belongs to readSchedule's inquiry window. These reports only invalidate owned baselines.
    for (const value of data.status) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const report = value as Record<string, unknown>, id = report.dp_id ?? report.dpId;
      if (report.code !== 'week_program' && id !== 119 && id !== '119' && !Object.hasOwn(report, '119')) {
        continue;
      }
      try {
        decodeFastWarmSchedule(String(Object.hasOwn(report, '119') ? report['119'] : report.value));
        this.reportRevisions.set(data.devId, (this.reportRevisions.get(data.devId) ?? 0) + 1);
      } catch { /* Malformed reports establish no programme revision. */ }
    }
  };
}

class ScheduleCommandRejected extends Error {}
class ScheduleCommandNotSent extends ScheduleCommandRejected {}
export class FastWarmSelectionSuperseded extends ScheduleCommandRejected {}
