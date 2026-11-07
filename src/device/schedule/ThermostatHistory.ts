import { randomUUID } from 'crypto';
import {
  ThermostatProfileId, ThermostatWeeklyProgramme, validateThermostatWeeklyProgramme,
} from './ThermostatProfiles';

const HOUR = 60 * 60 * 1000;
const RETENTION = 30 * 24 * HOUR;
const MAX_DEVICES = 64;
const MAX_POINTS_PER_DEVICE = 1500;
const MAX_POINTS = 6000;
const MAX_VERSIONS_PER_DEVICE = 50;
const MAX_VERSIONS = 300;
const MAX_BYTES = 2 * 1024 * 1024;
const FUTURE_TOLERANCE = 5 * 60 * 1000;
const UNCHANGED_SAMPLE_INTERVAL = 5 * 60 * 1000;
const PROFILE_IDS: readonly ThermostatProfileId[] = ['home', 'away', 'holiday'];

/** Actual observations only. `at` is reception time; sourceAt is the optional device measurement time. */
export interface ThermostatTemperaturePoint {
  at: number;
  sourceAt?: number;
  currentTemperature?: number;
  targetTemperature?: number;
  online: boolean;
}

export interface ThermostatTemperatureObservation extends ThermostatTemperaturePoint {
  /** Explicitly verified Celsius is required before either temperature is retained. */
  unit?: 'c' | 'f';
}

export interface ThermostatProgrammeVersion {
  id: string;
  at: number;
  source: 'draft' | 'native';
  profile?: ThermostatProfileId;
  programme: ThermostatWeeklyProgramme;
}

export interface ThermostatHistoryState {
  version: 1;
  devices: Record<string, { temperatures: ThermostatTemperaturePoint[]; programmes: ThermostatProgrammeVersion[] }>;
}

export interface ThermostatProgrammeRecord {
  at?: number;
  source: 'draft' | 'native';
  profile?: ThermostatProfileId;
  programme: ThermostatWeeklyProgramme;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && value.trim().length > 0
    && ![...value].some(character => character.charCodeAt(0) < 32);
}

function validTime(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now + FUTURE_TOLERANCE;
}

function validTemperature(value: unknown, target = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= (target ? 5 : -40) && value <= (target ? 40 : 100);
}

function copyVersion(version: ThermostatProgrammeVersion): ThermostatProgrammeVersion {
  return { ...version, programme: validateThermostatWeeklyProgramme(version.programme) };
}

function measurementTime(point: ThermostatTemperaturePoint) {
  return point.sourceAt ?? point.at;
}

/**
 * Bounded, JSON-serializable local history. It never polls a sensor or issues a device command.
 * Feed fresh observation events, rather than cached values from view() or startup. Missing values
 * remain missing; downsampling keeps complete actual observations and never merges measurements.
 */
export default class ThermostatHistory {
  private devices = new Map<string, ThermostatHistoryState['devices'][string]>();
  private now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Unsupported/legacy state has no trusted observation times and starts empty, without backfilling. */
  restore(value: unknown): void {
    this.devices.clear();
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.devices)) {
      return;
    }
    const now = this.now();
    for (const [id, saved] of Object.entries(value.devices).slice(0, MAX_DEVICES)) {
      if (!validDeviceId(id) || !isRecord(saved)) {
        continue;
      }
      const temperatures: ThermostatTemperaturePoint[] = [];
      for (const item of (Array.isArray(saved.temperatures) ? saved.temperatures : []).slice(-MAX_POINTS_PER_DEVICE)) {
        if (!isRecord(item) || !validTime(item.at, now) || typeof item.online !== 'boolean'
          || (item.sourceAt !== undefined && (!validTime(item.sourceAt, now) || item.sourceAt > item.at + FUTURE_TOLERANCE))) {
          continue;
        }
        if ((item.currentTemperature !== undefined && !validTemperature(item.currentTemperature))
          || (item.targetTemperature !== undefined && !validTemperature(item.targetTemperature, true))
          || (!item.online && (item.currentTemperature !== undefined || item.targetTemperature !== undefined))) {
          continue;
        }
        temperatures.push({
          at: item.at, online: item.online,
          ...(item.sourceAt !== undefined ? { sourceAt: item.sourceAt as number } : {}),
          ...(item.currentTemperature !== undefined ? { currentTemperature: item.currentTemperature as number } : {}),
          ...(item.targetTemperature !== undefined ? { targetTemperature: item.targetTemperature as number } : {}),
        });
      }
      temperatures.sort((a, b) => a.at - b.at);
      const programmes: ThermostatProgrammeVersion[] = [];
      const seenIds = new Set<string>();
      for (const item of (Array.isArray(saved.programmes) ? saved.programmes : []).slice(-MAX_VERSIONS_PER_DEVICE)) {
        if (!isRecord(item) || typeof item.id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
          || seenIds.has(item.id) || !validTime(item.at, now)
          || (item.source !== 'draft' && item.source !== 'native')
          || (item.profile !== undefined && !PROFILE_IDS.includes(item.profile as ThermostatProfileId))
          || (item.source === 'draft' && item.profile === undefined)) {
          continue;
        }
        try {
          programmes.push({
            id: item.id, at: item.at, source: item.source,
            ...(item.profile !== undefined ? { profile: item.profile as ThermostatProfileId } : {}),
            programme: validateThermostatWeeklyProgramme(item.programme),
          });
          seenIds.add(item.id);
        } catch {
          // Invalid or incomplete persisted programmes cannot become restore candidates.
        }
      }
      programmes.sort((a, b) => a.at - b.at);
      this.devices.set(id, { temperatures, programmes });
    }
    this.prune();
  }

  snapshot(): ThermostatHistoryState {
    this.prune();
    return {
      version: 1,
      devices: Object.fromEntries([...this.devices].map(([id, device]) => [id, {
        temperatures: device.temperatures.map(point => ({ ...point })),
        programmes: device.programmes.map(copyVersion),
      }])),
    };
  }

  /** Returns false for duplicates, stale/out-of-order events and malformed timestamps. */
  ingestTemperature(deviceId: string, observation: ThermostatTemperatureObservation): boolean {
    this.requireDeviceId(deviceId);
    const now = this.now();
    if (!validTime(observation.at, now) || typeof observation.online !== 'boolean'
      || (observation.sourceAt !== undefined && (!validTime(observation.sourceAt, now)
        || observation.sourceAt > observation.at + FUTURE_TOLERANCE))) {
      return false;
    }
    const device = this.device(deviceId);
    const latest = device.temperatures[device.temperatures.length - 1];
    if (latest && observation.at < latest.at) {
      return false;
    }
    const point: ThermostatTemperaturePoint = { at: observation.at, online: observation.online };
    if (observation.sourceAt !== undefined) {
      point.sourceAt = observation.sourceAt;
    }
    if (observation.online && observation.unit === 'c' && measurementTime(point) >= now - RETENTION) {
      for (const field of ['currentTemperature', 'targetTemperature'] as const) {
        const value = observation[field];
        if (!validTemperature(value, field === 'targetTemperature')) {
          continue;
        }
        const previous = [...device.temperatures].reverse().find(item => item[field] !== undefined);
        if (previous && ((point.sourceAt !== undefined && previous.sourceAt !== undefined && point.sourceAt <= previous.sourceAt)
          || (previous[field] === value && measurementTime(point) - measurementTime(previous) < UNCHANGED_SAMPLE_INTERVAL))) {
          continue;
        }
        point[field] = value;
      }
    }
    if (latest?.online === point.online && point.currentTemperature === undefined && point.targetTemperature === undefined) {
      return false;
    }
    // Online-only changes have no measurement timestamp: never imply a fresh temperature report.
    if (point.currentTemperature === undefined && point.targetTemperature === undefined) {
      delete point.sourceAt;
    }
    device.temperatures.push(point);
    this.prune();
    return true;
  }

  /** Measurement-time order. Plot sourceAt ?? at, preserve gaps, and do not extend a series beyond its final report. */
  temperatureHistory(deviceId: string, hours = 24): ThermostatTemperaturePoint[] {
    this.requireDeviceId(deviceId);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 30 * 24) {
      throw new Error('Temperature history must cover more than zero and at most 720 hours.');
    }
    this.prune();
    const earliest = this.now() - hours * HOUR;
    return (this.devices.get(deviceId)?.temperatures ?? [])
      .filter(point => measurementTime(point) >= earliest).sort((a, b) => measurementTime(a) - measurementTime(b))
      .map(point => ({ ...point }));
  }

  recordProgramme(deviceId: string, input: ThermostatProgrammeRecord): ThermostatProgrammeVersion {
    this.requireDeviceId(deviceId);
    const at = input.at ?? this.now();
    if (!validTime(at, this.now()) || (input.source !== 'draft' && input.source !== 'native')
      || (input.profile !== undefined && !PROFILE_IDS.includes(input.profile))
      || (input.source === 'draft' && input.profile === undefined)) {
      throw new Error('Programme history requires a valid time, source and draft profile.');
    }
    const programme = validateThermostatWeeklyProgramme(input.programme);
    const device = this.device(deviceId);
    const previous = [...device.programmes].reverse().find(item => item.source === input.source && item.profile === input.profile);
    if (previous && JSON.stringify(previous.programme) === JSON.stringify(programme)) {
      return copyVersion(previous);
    }
    const version: ThermostatProgrammeVersion = {
      id: randomUUID(), at, source: input.source,
      ...(input.profile !== undefined ? { profile: input.profile } : {}), programme,
    };
    device.programmes.push(version);
    device.programmes.sort((a, b) => a.at - b.at);
    this.prune();
    return copyVersion(version);
  }

  /** Newest first; all programmes are independently validated copies. */
  programmeHistory(deviceId: string): ThermostatProgrammeVersion[] {
    this.requireDeviceId(deviceId);
    return (this.devices.get(deviceId)?.programmes ?? []).slice().reverse().map(copyVersion);
  }

  /** Selecting a version is read-only. The caller may save its programme into an explicitly chosen draft. */
  getProgrammeVersion(deviceId: string, versionId: string): ThermostatProgrammeVersion | undefined {
    this.requireDeviceId(deviceId);
    const version = this.devices.get(deviceId)?.programmes.find(item => item.id === versionId);
    return version ? copyVersion(version) : undefined;
  }

  private requireDeviceId(id: string) {
    if (!validDeviceId(id)) {
      throw new Error('A valid thermostat device ID is required.');
    }
  }

  private device(id: string) {
    let device = this.devices.get(id);
    if (!device) {
      if (this.devices.size >= MAX_DEVICES) {
        throw new Error('The thermostat history device limit has been reached.');
      }
      device = { temperatures: [], programmes: [] };
      this.devices.set(id, device);
    }
    return device;
  }

  private prune() {
    const now = this.now();
    for (const device of this.devices.values()) {
      const retained = device.temperatures.filter(point => measurementTime(point) >= now - RETENTION);
      const buckets = new Map<string, ThermostatTemperaturePoint>();
      const recent: ThermostatTemperaturePoint[] = [];
      for (const point of retained) {
        if (measurementTime(point) >= now - 24 * HOUR) {
          recent.push(point);
        } else {
          // Keep the last actual observation per hour and field shape, without inventing merged points.
          const shape = `${point.currentTemperature !== undefined}:${point.targetTemperature !== undefined}:${point.online}`;
          buckets.set(`${Math.floor(measurementTime(point) / HOUR)}:${shape}`, point);
        }
      }
      device.temperatures = [...buckets.values(), ...recent].sort((a, b) => a.at - b.at).slice(-MAX_POINTS_PER_DEVICE);
      device.programmes = device.programmes.slice(-MAX_VERSIONS_PER_DEVICE);
    }
    this.trimTotal('temperatures', MAX_POINTS);
    this.trimTotal('programmes', MAX_VERSIONS);
    // Keep the complete persistence/IPC payload well below the runtime's four-megabyte limit.
    while (this.byteSize() > MAX_BYTES) {
      if (!this.dropOldest('temperatures') && !this.dropOldest('programmes')) {
        break;
      }
    }
  }

  private trimTotal(field: 'temperatures' | 'programmes', maximum: number) {
    let count = [...this.devices.values()].reduce((sum, device) => sum + device[field].length, 0);
    while (count > maximum && this.dropOldest(field)) {
      count--;
    }
  }

  private dropOldest(field: 'temperatures' | 'programmes'): boolean {
    const oldest = [...this.devices.values()].filter(device => device[field].length)
      .sort((a, b) => a[field][0].at - b[field][0].at)[0];
    if (!oldest) {
      return false;
    }
    oldest[field].shift();
    return true;
  }

  private byteSize() {
    return Buffer.byteLength(JSON.stringify({ version: 1, devices: Object.fromEntries(this.devices) }), 'utf8');
  }
}
