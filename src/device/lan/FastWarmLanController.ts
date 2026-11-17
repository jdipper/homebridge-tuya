import { createHash } from 'crypto';
import FastWarmLanClient, {
  FastWarmLanClientOptions, FastWarmLanError, FastWarmLanReport, isFastWarmLanCommand,
} from './FastWarmLanClient';
import type { FastWarmLocalDeviceConfig } from './FastWarmLanConfiguration';
import {
  FastWarmLanCommandOptions, FastWarmLanConnectionListener, FastWarmLanProperty, FastWarmLanRawListener,
  FastWarmLanScheduleRead, FastWarmLanTransport,
} from './FastWarmLanTransport';
import TuyaDevice from '../TuyaDevice';
import { isFastWarmThermostat } from '../profile/FastWarmThermostat';
import { collectFastWarmSchedule, decodeFastWarmSchedule, FastWarmScheduleReport } from '../schedule/FastWarmSchedule';

const CODES: Record<string, number> = {
  power1: 101, SetTemp: 102, ControlMode: 103, RoomTemper: 105, FloorTemper: 106,
  TemperUnitChange: 107, Lock: 108, Event_Adaptive_Set: 110, week_program: 119, inquire: 122,
};
const CODE_BY_DP = new Map(Object.entries(CODES).map(([code, dp]) => [String(dp), code]));
const STATUS_KEYS = ['101', '102', '103', '105', '107', '110'];

interface Entry {
  config: FastWarmLocalDeviceConfig;
  client?: FastWarmLanClient;
  allowed: boolean;
  ready: boolean;
  generation: number;
  lastReportAt: number;
  lastStatusAt: number;
  connectedAt: number;
  lastProgrammeAt: number;
  cache: Record<string, unknown>;
  timer?: NodeJS.Timeout;
  tail: Promise<void>;
}

export interface FastWarmLanControllerOptions {
  clientFactory?: (options: FastWarmLanClientOptions) => FastWarmLanClient;
  refreshIntervalMs?: number;
  reconnectIntervalMs?: number;
}

function permitted(guard?: () => boolean): boolean {
  try {
    return guard?.() !== false;
  } catch {
    return false;
  }
}

/** One owner per selected thermostat. Native reports feed the existing Tuya provider contract. */
export default class FastWarmLanController implements FastWarmLanTransport {
  private readonly entries = new Map<string, Entry>();
  private readonly rawListeners = new Set<FastWarmLanRawListener>();
  private readonly connectionListeners = new Set<FastWarmLanConnectionListener>();
  private readonly rawWaiters = new Set<(id: string, report: FastWarmLanReport) => void>();
  private readonly waits = new Set<() => void>();
  private readonly refreshIntervalMs: number;
  private readonly reconnectIntervalMs: number;
  private closed = false;

  constructor(configurations: FastWarmLocalDeviceConfig[], keys: Map<string, string>, options: FastWarmLanControllerOptions = {}) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? 60000;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 15000;
    for (const config of configurations.filter(item => item.enabled !== false)) {
      const entry: Entry = {config: {...config}, allowed: false, ready: false, generation: 0,
        lastReportAt: 0, lastStatusAt: 0, connectedAt: Infinity, lastProgrammeAt: 0, cache: {}, tail: Promise.resolve()};
      const localKey = keys.get(config.deviceId);
      if (localKey) {
        entry.client = (options.clientFactory ?? (value => new FastWarmLanClient(value)))({
          deviceId: config.deviceId, address: config.address, localKey, timeoutMs: 5000,
        });
        entry.client.on('report', (report: FastWarmLanReport) => this.accept(config.deviceId, report));
        entry.client.on('connection', (event: {connected: boolean; generation: number}) => {
          if (event.generation !== entry.generation) {
            entry.ready = false;
            entry.cache = {};
            entry.lastReportAt = 0;
            entry.lastStatusAt = 0;
            entry.lastProgrammeAt = 0;
          }
          entry.generation = event.generation;
          entry.connectedAt = event.connected ? Date.now() : Infinity;
          if (!event.connected) {
            entry.ready = false;
            entry.cache = {};
            this.connection(config.deviceId, false);
          }
        });
      }
      this.entries.set(config.deviceId, entry);
    }
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  generation(id: string): number {
    return this.entries.get(id)?.generation ?? 0;
  }

  isConnected(id: string): boolean {
    const entry = this.entries.get(id);
    return !this.closed && Boolean(entry?.allowed && entry.ready && entry.client?.isConnected())
      && entry!.client!.generation === entry!.generation
      && Date.now() - entry!.lastStatusAt <= this.refreshIntervalMs * 2;
  }

  /** Metadata proves the exact product; a key alone never enrolls an arbitrary Tuya device. */
  async start(devices: readonly TuyaDevice[]): Promise<void> {
    for (const [id, entry] of this.entries) {
      entry.allowed = devices.some(device => device.id === id && isFastWarmThermostat(device));
    }
    await Promise.allSettled([...this.entries.keys()].map(id => this.refresh(id)));
    for (const id of this.entries.keys()) {
      this.schedule(id);
    }
  }

  addRawMessageListener(listener: FastWarmLanRawListener): void {
    this.rawListeners.add(listener);
  }

  removeRawMessageListener(listener: FastWarmLanRawListener): void {
    this.rawListeners.delete(listener);
  }

  addConnectionListener(listener: FastWarmLanConnectionListener): void {
    this.connectionListeners.add(listener);
  }

  removeConnectionListener(listener: FastWarmLanConnectionListener): void {
    this.connectionListeners.delete(listener);
  }

  readProperties(id: string, codes: string[], options: FastWarmLanCommandOptions = {}) {
    if (!Array.isArray(codes) || codes.some(code => !Object.prototype.hasOwnProperty.call(CODES, code))) {
      return Promise.reject(new FastWarmLanError('invalid-command'));
    }
    return this.enqueue(id, async entry => {
      const report = await this.status(entry, options);
      const properties = codes.map(code => ({code, dp_id: CODES[code], value: report.dps[String(CODES[code])]}));
      if (properties.some(property => property.value === undefined)
        || !entry.client?.isConnected() || !this.coherent(entry, report)) {
        throw new FastWarmLanError('unavailable');
      }
      return {properties, receivedAt: report.receivedAt, generation: entry.generation};
    });
  }

  issueOnce(id: string, properties: Record<string, string | number | boolean>, options: FastWarmLanCommandOptions = {}): Promise<void> {
    const values = properties && typeof properties === 'object' ? {...properties} : properties;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length === 0) {
      return Promise.reject(new FastWarmLanError('invalid-command'));
    }
    const dps: Record<string, unknown> = {};
    for (const [code, value] of Object.entries(values)) {
      if (!Object.prototype.hasOwnProperty.call(CODES, code)
        || !['power1', 'SetTemp', 'ControlMode', 'Lock', 'week_program', 'inquire'].includes(code)) {
        return Promise.reject(new FastWarmLanError('invalid-command'));
      }
      dps[String(CODES[code])] = value;
    }
    if (!isFastWarmLanCommand(dps)) {
      return Promise.reject(new FastWarmLanError('invalid-command'));
    }
    return this.enqueue(id, async entry => {
      this.requireCelsius(entry);
      const generation = entry.generation;
      await entry.client!.issueOnce(dps, {...options,
        shouldProceed: () => this.isConnected(id) && entry.generation === generation && entry.cache['107'] === false
          && permitted(options.shouldProceed)});
    });
  }

  readSchedule(id: string, options: FastWarmLanCommandOptions = {}): Promise<FastWarmLanScheduleRead> {
    return this.enqueue(id, async entry => {
      const reports: FastWarmScheduleReport[] = [];
      const seen = new Map<string, string>();
      const errors: string[] = [];
      const timeoutMs = Math.min(options.timeoutMs ?? 30000, 60000);
      const deadline = Date.now() + timeoutMs;
      let startedAt = Date.now(), completeAt = 0, collecting = false, timedOut = false;
      const listener = (deviceId: string, report: FastWarmLanReport) => {
        if (deviceId !== id || !collecting || report.receivedAt < startedAt || !('119' in report.dps)) {
          return;
        }
        try {
          if (reports.length >= 1024 || typeof report.dps['119'] !== 'string') {
            throw new Error();
          }
          const packet = decodeFastWarmSchedule(report.dps['119']);
          for (const day of [1, 2, 4, 8, 16, 32, 64]) {
            if (!(day & packet.dayMask)) {
              continue;
            }
            for (const event of packet.events) {
              const key = `${day}:${event.event}`, value = JSON.stringify(event);
              if (seen.has(key) && seen.get(key) !== value) {
                throw new Error();
              }
              seen.set(key, value);
            }
          }
          reports.push({packet, reportedAt: report.receivedAt});
          if (seen.size === 28 && !completeAt) {
            completeAt = Date.now();
          }
        } catch {
          errors.push('Conflicting or malformed local programme reports.');
        }
      };
      this.rawWaiters.add(listener);
      try {
        // A full status response is a read barrier, never a cached schedule chunk.
        const before = await this.status(entry, options);
        this.requireCelsius(entry);
        const activeGeneration = entry.generation;
        // Exclude the preceding write echo before opening this inquiry's collector.
        let quietSince = Math.max(Date.now(), entry.lastProgrammeAt);
        while (Date.now() - quietSince < 1000) {
          if (this.closed || !this.isConnected(id) || entry.generation !== activeGeneration || !permitted(options.shouldProceed)) {
            throw new FastWarmLanError('unavailable');
          }
          if (Date.now() >= deadline) {
            throw new FastWarmLanError('timeout');
          }
          await this.delay(Math.min(100, deadline - Date.now()));
          quietSince = Math.max(quietSince, entry.lastProgrammeAt);
        }
        if (!permitted(options.shouldProceed) || !this.isConnected(id)) {
          throw new FastWarmLanError('cancelled');
        }
        startedAt = Date.now(); collecting = true;
        await entry.client!.issueOnce({'122': true}, {timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now())),
          shouldProceed: () => !this.closed && entry.generation === activeGeneration && permitted(options.shouldProceed)});
        while (Date.now() < deadline && (!completeAt || Date.now() - completeAt < 2000)) {
          if (!this.isConnected(id) || entry.generation !== activeGeneration || !permitted(options.shouldProceed)) {
            throw new FastWarmLanError('unavailable');
          }
          await this.delay(Math.min(100, deadline - Date.now()));
        }
        timedOut = !completeAt || Date.now() - completeAt < 2000;
        const after = await this.status(entry, {timeoutMs: 5000, shouldProceed: options.shouldProceed});
        this.requireCelsius(entry);
        if (['101', '103', '107', '110'].some(key => !Object.is(before.dps[key], after.dps[key]))) {
          throw new FastWarmLanError('unavailable');
        }
        if (entry.generation !== activeGeneration) {
          throw new FastWarmLanError('unavailable');
        }
      } catch {
        errors.push('The local weekly programme could not be verified.');
      } finally {
        collecting = false;
        this.rawWaiters.delete(listener);
      }
      const state = collectFastWarmSchedule(reports);
      const fingerprint = state.complete && !timedOut && errors.length === 0 && this.isConnected(id)
        ? createHash('sha256').update(JSON.stringify(state.days.map(day => [day.day, day.events]))).digest('hex') : null;
      return {startedAt, finishedAt: Date.now(), state, fingerprint, timedOut, errors};
    });
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.client?.close();
    }
    for (const finish of [...this.waits]) {
      finish();
    }
    this.rawWaiters.clear();
  }

  private async refresh(id: string): Promise<void> {
    try {
      await this.enqueue(id, entry => this.status(entry));
    } catch {
      const entry = this.entries.get(id)!;
      entry.ready = false;
      entry.client?.close();
    }
  }

  private schedule(id: string): void {
    const entry = this.entries.get(id)!;
    if (this.closed || !entry.allowed || !entry.client) {
      return;
    }
    entry.timer = setTimeout(() => {
      void this.refresh(id).finally(() => this.schedule(id));
    }, this.isConnected(id) ? this.refreshIntervalMs : this.reconnectIntervalMs);
    entry.timer.unref();
  }

  private async status(entry: Entry, options: FastWarmLanCommandOptions = {}): Promise<FastWarmLanReport> {
    if (!entry.allowed || !entry.client || this.closed || !permitted(options.shouldProceed)) {
      throw new FastWarmLanError('unavailable');
    }
    // Reconnection is read-side only. No write is replayed by this path.
    await entry.client.connect();
    const report = await entry.client.queryStatus(options);
    if (!this.coherent(entry, report)) {
      throw new FastWarmLanError('unavailable');
    }
    return report;
  }

  private requireCelsius(entry: Entry): void {
    if (!this.isConnected(entry.config.deviceId) || entry.cache['107'] !== false) {
      throw new FastWarmLanError('unavailable');
    }
  }

  private coherent(entry: Entry, report: FastWarmLanReport): boolean {
    return entry.ready && report.receivedAt >= entry.connectedAt && report.receivedAt >= entry.lastStatusAt
      && Date.now() - report.receivedAt <= this.refreshIntervalMs * 2
      && (report.generation === undefined || report.generation === entry.generation)
      && STATUS_KEYS.every(key => Object.prototype.hasOwnProperty.call(report.dps, key)
      && Object.is(entry.cache[key], report.dps[key]));
  }

  private accept(id: string, report: FastWarmLanReport): void {
    const entry = this.entries.get(id)!;
    if (this.closed || !entry.allowed || !entry.client?.isConnected() || !report || !report.dps
      || !Number.isFinite(report.receivedAt) || report.receivedAt > Date.now() + 5000
      || report.receivedAt < entry.connectedAt || report.receivedAt < entry.lastReportAt
      || Date.now() - report.receivedAt > this.refreshIntervalMs * 2
      || report.generation !== undefined && report.generation !== entry.generation) {
      return;
    }
    const values: Record<string, unknown> = {};
    try {
      if (typeof report.dps !== 'object' || Array.isArray(report.dps)) {
        throw new Error();
      }
      for (const [dp, value] of Object.entries(report.dps)) {
        if (!/^\d{1,3}$/.test(dp)) {
          throw new Error();
        }
        if (!CODE_BY_DP.has(dp)) {
          continue;
        }
        let valid = true;
        if (['101', '107', '108', '122'].includes(dp)) {
          valid = typeof value === 'boolean';
        } else if (dp === '103') {
          valid = typeof value === 'string' && ['smart', 'holiday', 'hold'].includes(value);
        } else if (dp === '119') {
          valid = typeof value === 'string';
        } else {
          const [minimum, maximum] = dp === '102' ? [41, 1040] : dp === '110' ? [0, 100] : [0, 1130];
          valid = typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
        }
        if (!valid) {
          throw new Error();
        }
        values[dp] = value;
      }
    } catch {
      entry.ready = false;
      entry.cache = {};
      entry.client.close();
      return;
    }
    entry.lastReportAt = report.receivedAt;
    Object.assign(entry.cache, values);
    const wasReady = entry.ready;
    if (STATUS_KEYS.every(key => Object.prototype.hasOwnProperty.call(values, key))) {
      entry.ready = true;
      entry.lastStatusAt = report.receivedAt;
    }
    if (Object.prototype.hasOwnProperty.call(report.dps, '119')) {
      entry.lastProgrammeAt = report.receivedAt;
    }
    if (!wasReady && entry.ready) {
      this.connection(id, true);
    }
    const safeReport = {...report, dps: values};
    const status: FastWarmLanProperty[] = Object.entries(values)
      .filter(([dp]) => CODE_BY_DP.has(dp)).map(([dp, value]) => ({code: CODE_BY_DP.get(dp)!, dp_id: Number(dp), value}));
    for (const listener of this.rawListeners) {
      listener('fastwarm/lan', 4, {devId: id, status, source: 'lan'}, report.receivedAt);
    }
    for (const listener of this.rawWaiters) {
      listener(id, safeReport);
    }
  }

  private connection(id: string, connected: boolean): void {
    for (const listener of this.connectionListeners) {
      listener({deviceId: id, connected, generation: this.generation(id)});
    }
  }

  private enqueue<T>(id: string, operation: (entry: Entry) => Promise<T>): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry || this.closed) {
      return Promise.reject(new FastWarmLanError('unavailable'));
    }
    const result = entry.tail.then(() => {
      if (this.closed) {
        throw new FastWarmLanError('unavailable');
      }
      return operation(entry);
    });
    entry.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer); this.waits.delete(finish); resolve();
      };
      const timer = setTimeout(finish, Math.max(1, milliseconds));
      this.waits.add(finish);
    });
  }
}
