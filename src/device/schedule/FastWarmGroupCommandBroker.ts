import TuyaOpenAPI from '../../core/TuyaOpenAPI';
import { decodeFastWarmSchedule } from './FastWarmSchedule';

/** An existing group whose exact membership and packet delivery were independently validated. */
export interface FastWarmProgrammeGroup {
  groupId: string;
  deviceIds: string[];
}
type Properties = { inquire: true } | { week_program: string };
interface Pending {
  deviceId: string;
  properties: Properties;
  guard: () => boolean;
  individual: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}
interface Cohort {group: FastWarmProgrammeGroup; pending: Map<string, Pending>; timer: NodeJS.Timeout}
interface Capabilities {maxRawLength: number; observedAt: number; expiresAt: number; generation: number}
/** Stable instruction metadata only; device state and group membership are never cached here. */
export const FASTWARM_GROUP_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

/** A pre-dispatch rejection establishes that no group instruction was sent. */
export class FastWarmGroupCommandRejected extends Error {}

/**
 * Joins commands already authorised by every member's owned automatic operation.
 * Missing/different commands use their individual routes before any group dispatch.
 * Once a full cohort is claimed, neither errors nor ambiguous responses replay it.
 */
export default class FastWarmGroupCommandBroker {
  private readonly groups = new Map<string, FastWarmProgrammeGroup>();
  private readonly cohorts = new Map<string, Cohort>();
  private readonly capabilities = new Map<string, Capabilities>();
  private readonly generations = new Map<string, number>();
  private authenticationRecoveryCount: number | undefined;
  private closed = false;

  constructor(private readonly api: TuyaOpenAPI, groups: FastWarmProgrammeGroup[] = [],
    private readonly timeoutMs = 15000, private readonly rendezvousMs = 500) {
    this.authenticationRecoveryCount = api.tokenRecoveryCount;
    if (!Array.isArray(groups) || groups.length > 4 || !Number.isSafeInteger(rendezvousMs)
      || rendezvousMs < 1 || rendezvousMs > 1000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Validated FastWarm programme groups are required.');
    }
    const groupIds = new Set<string>();
    for (const value of groups) {
      if (!value || Object.keys(value).sort().join(',') !== 'deviceIds,groupId'
        || typeof value.groupId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(value.groupId)
        || groupIds.has(value.groupId) || !Array.isArray(value.deviceIds) || value.deviceIds.length !== 6
        || new Set(value.deviceIds).size !== 6 || value.deviceIds.some(id =>
          typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.groups.has(id))) {
        throw new Error('Each validated group must have one group ID and six distinct, non-overlapping device IDs.');
      }
      const group = {groupId: value.groupId, deviceIds: [...value.deviceIds].sort()};
      groupIds.add(group.groupId);
      for (const id of group.deviceIds) this.groups.set(id, group);
    }
  }

  send(deviceId: string, properties: Properties, guard: () => boolean, individual: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The grouped programme connection is closed.'));
    const group = this.groups.get(deviceId);
    if (!group) return individual();
    // Only the two native schedule operations may ever reach the group endpoint.
    const keys = Object.keys(properties).join(',');
    if (keys !== 'inquire' && keys !== 'week_program') return Promise.reject(new Error('Unsupported grouped schedule command.'));
    if ('inquire' in properties ? properties.inquire !== true : typeof properties.week_program !== 'string') {
      return Promise.reject(new Error('Invalid grouped schedule command.'));
    }
    if ('week_program' in properties && decodeFastWarmSchedule(properties.week_program).events.length !== 1) {
      // This opt-in validates the six-byte single-event packet, not a complete-day fan-out.
      return individual();
    }
    const key = group.groupId + ':' + JSON.stringify(properties);
    return new Promise((resolve, reject) => {
      let cohort = this.cohorts.get(key);
      if (!cohort) {
        const timer = setTimeout(() => this.fallback(key), this.rendezvousMs);
        cohort = {group, pending: new Map(), timer}; this.cohorts.set(key, cohort);
      }
      if (cohort.pending.has(deviceId)) {
        reject(new Error('A thermostat already has a pending grouped command.')); return;
      }
      cohort.pending.set(deviceId, {deviceId, properties: {...properties}, guard, individual, resolve, reject});
      if (cohort.pending.size === group.deviceIds.length) {
        clearTimeout(cohort.timer); this.cohorts.delete(key);
        void this.dispatch(cohort).then(() => {
          for (const item of cohort!.pending.values()) item.resolve();
        }, error => {for (const item of cohort!.pending.values()) item.reject(error);});
      }
    });
  }

  close(): void {
    this.closed = true;
    this.invalidateCapabilities();
    for (const cohort of this.cohorts.values()) {
      clearTimeout(cohort.timer);
      for (const item of cohort.pending.values()) item.reject(new Error('The grouped programme connection is closed.'));
    }
    this.cohorts.clear();
  }

  /** An availability/info change resets one group; an unexpected connection gap resets all. */
  invalidateCapabilities(deviceId?: string): void {
    const groups = deviceId === undefined ? new Set([...this.groups.values()].map(group => group.groupId))
      : new Set(this.groups.has(deviceId) ? [this.groups.get(deviceId)!.groupId] : []);
    for (const groupId of groups) this.invalidateGroup(groupId);
  }

  private invalidateGroup(groupId: string, expectedGeneration?: number): void {
    if (expectedGeneration !== undefined && this.generation(groupId) !== expectedGeneration) return;
    this.generations.set(groupId, this.generation(groupId) + 1); this.capabilities.delete(groupId);
  }

  private generation(groupId: string): number {return this.generations.get(groupId) ?? 0;}

  private checkAuthenticationEpoch(): void {
    // Ordinary token refreshes keep the schema cache. A full recovery login does not.
    if (this.authenticationRecoveryCount !== this.api.tokenRecoveryCount) {
      this.authenticationRecoveryCount = this.api.tokenRecoveryCount; this.invalidateCapabilities();
    }
  }

  private currentCapabilities(groupId: string, value: Capabilities): boolean {
    this.checkAuthenticationEpoch();
    const now = Date.now();
    return !this.closed && this.capabilities.get(groupId) === value && this.generation(groupId) === value.generation
      && now >= value.observedAt && now < value.expiresAt;
  }

  private async readCapabilities(base: string, groupId: string, generation: number): Promise<Capabilities> {
    const cached = this.capabilities.get(groupId);
    if (cached && this.currentCapabilities(groupId, cached)) return cached;
    this.capabilities.delete(groupId);
    const response = await this.api.request('get', base + '/properties', null, null, {attempts: 1, timeoutMs: this.timeoutMs});
    this.checkAuthenticationEpoch();
    const maxRawLength = response.success === true ? this.parseCapabilities(response.result) : undefined;
    if (this.closed || this.generation(groupId) !== generation || maxRawLength === undefined) {
      throw new FastWarmGroupCommandRejected('The native group instruction metadata could not be confirmed.');
    }
    const observedAt = Date.now();
    const value = Object.freeze({maxRawLength, observedAt, expiresAt: observedAt + FASTWARM_GROUP_CAPABILITY_TTL_MS, generation});
    this.capabilities.set(groupId, value); return value;
  }

  private fallback(key: string): void {
    const cohort = this.cohorts.get(key);
    if (!cohort) return;
    this.cohorts.delete(key);
    for (const item of cohort.pending.values()) {
      if (!this.allowed([item])) {
        item.reject(new FastWarmGroupCommandRejected('The owned programme operation changed before dispatch.'));
      } else {
        void item.individual().then(item.resolve, item.reject);
      }
    }
  }

  private allowed(items: Pending[]): boolean {
    return !this.closed && items.every(item => {try {return item.guard() === true;} catch {return false;}});
  }

  private async dispatch(cohort: Cohort): Promise<void> {
    const items = cohort.group.deviceIds.map(id => cohort.pending.get(id)!);
    if (!this.allowed(items)) throw new FastWarmGroupCommandRejected('An owned programme operation changed before grouped dispatch.');
    const base = `/v2.1/cloud/thing/group/${cohort.group.groupId}`;
    this.checkAuthenticationEpoch();
    const groupId = cohort.group.groupId, generation = this.generation(groupId);
    let members: Awaited<ReturnType<TuyaOpenAPI['request']>>, capabilities: Capabilities;
    try {
      [members, capabilities] = await Promise.all([
        this.api.request('get', base + '/devices', {page_no: 1, page_size: 20}, null,
          {attempts: 1, timeoutMs: this.timeoutMs}),
        this.readCapabilities(base, groupId, generation),
      ]);
    } catch {
      this.invalidateGroup(groupId, generation);
      throw new FastWarmGroupCommandRejected('The current group metadata could not be read; no group command was sent.');
    }
    if (members.success !== true || !this.exactMembers(members.result, cohort.group)
      || !this.currentCapabilities(groupId, capabilities)
      || ('week_program' in items[0].properties && items[0].properties.week_program.length > capabilities.maxRawLength)) {
      this.invalidateGroup(groupId, generation);
      throw new FastWarmGroupCommandRejected('The current group membership or native schedule capabilities could not be confirmed; no group command was sent.');
    }
    if (!this.allowed(items)) throw new FastWarmGroupCommandRejected('An owned programme operation changed during group validation.');
    try {
      const response = await this.api.postOnce(base + '/properties', {properties: JSON.stringify(items[0].properties)}, {
        timeoutMs: this.timeoutMs, shouldProceed: () => this.allowed(items) && this.currentCapabilities(groupId, capabilities),
      });
      if (response.success !== true || response.result?.result !== true) {
        // A failed group acknowledgement does not establish which members applied it.
        throw new Error('The grouped schedule command was not acknowledged. Do not automatically retry.');
      }
    } catch (error) {
      this.invalidateGroup(groupId, generation); throw error;
    }
  }

  private exactMembers(value: unknown, group: FastWarmProgrammeGroup): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const page = value as Record<string, unknown>;
    if (page.page_no !== 1 || page.page_size !== 20 || page.count !== 6 || !Array.isArray(page.data_list)
      || page.data_list.length !== 6) return false;
    const ids = page.data_list.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const member = item as Record<string, unknown>;
      const id = typeof member.group_id === 'number' && Number.isSafeInteger(member.group_id)
        ? String(member.group_id) : member.group_id;
      return id === group.groupId && typeof member.device_id === 'string' ? member.device_id : null;
    });
    return ids.every(id => typeof id === 'string') && new Set(ids).size === 6
      && JSON.stringify(ids.sort()) === JSON.stringify(group.deviceIds);
  }

  private parseCapabilities(value: unknown): number | undefined {
    if (!Array.isArray(value) || value.length > 1000) return undefined;
    const codes = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.code !== 'string'
        || !/^[A-Za-z0-9_]{1,100}$/.test(item.code) || typeof item.type !== 'string'
        || !/^[A-Za-z0-9_]{1,30}$/.test(item.type) || codes.has(item.code)) return undefined;
      codes.add(item.code);
    }
    const inquiry = value.find(item => item.code === 'inquire'), programme = value.find(item => item.code === 'week_program');
    if (inquiry?.type !== 'bool' || programme?.type !== 'raw') return undefined;
    try {
      const raw = programme.type_desc;
      if (typeof raw !== 'string' || raw.length > 8192) return undefined;
      const constraints = JSON.parse(raw);
      return constraints && typeof constraints === 'object' && !Array.isArray(constraints) && Number.isSafeInteger(constraints.maxlen)
        && constraints.maxlen >= 8 && constraints.maxlen <= 4096 ? constraints.maxlen : undefined;
    } catch {return undefined;}
  }
}
