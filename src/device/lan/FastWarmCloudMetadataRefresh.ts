import {isDeepStrictEqual} from 'util';
import path from 'path';
import TuyaOpenAPI, {TuyaOpenAPIResponse, TuyaRequestOptions} from '../../core/TuyaOpenAPI';
import type {TuyaPlatformConfigOptions, TuyaPlatformHomeConfigOptions} from '../../config';
import TuyaDevice, {TuyaDeviceSchema, TuyaDeviceSchemaMode, TuyaDeviceSchemaType} from '../TuyaDevice';
import {isFastWarmThermostat} from '../profile/FastWarmThermostat';
import {readFastWarmLanMetadata, saveFastWarmLanMetadata} from './FastWarmLanBootstrap';
import {TuyaApiUsageMeter, TuyaRequestUsage} from '../../util/TuyaApiUsage';

const LOGIN = '/v1.0/iot-01/associated-users/actions/authorized-login';
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REQUESTS = 128;
const DEADLINE_MS = 60000;
const REQUEST_MS = 5000;
const queues = new Map<string, Promise<void>>();
const ENDPOINTS = new Set<string>(Object.values(TuyaOpenAPI.Endpoints));
const noop = () => undefined;
const SILENT_LOG = Object.freeze({info: noop, debug: noop, warn: noop, error: noop, success: noop});

function failure(): Error {
  return new Error('FastWarm cloud metadata refresh failed.');
}

function requireValid(value: unknown): asserts value {
  if (!value) {
    throw failure();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Narrow dependency contract: no message queue, LAN connection or device command methods exist here. */
export interface FastWarmCloudMetadataAPI {
  tokenInfo: {uid: string};
  setUsageMeter(meter: TuyaRequestUsage): void;
  homeLogin(countryCode: number, username: string, password: string, appSchema: string): Promise<TuyaOpenAPIResponse>;
  request(method: string, requestPath: string, params?: unknown, body?: unknown,
    options?: TuyaRequestOptions): Promise<TuyaOpenAPIResponse>;
}

export interface FastWarmCloudMetadataRefreshRequest {
  persistPath: string;
  instanceId: string;
  options: TuyaPlatformConfigOptions;
  deviceIds: readonly string[];
}

export interface FastWarmCloudMetadataRefreshDependencies {
  createAPI?: (options: TuyaPlatformHomeConfigOptions) => FastWarmCloudMetadataAPI;
  openUsageMeter?: (directory: string, instanceId: string, onError: () => void, now: () => number) =>
    Promise<TuyaRequestUsage & {flush(): Promise<void>}>;
  now?: () => number;
}

/** A disposable authentication session: never reconnect, renew a token, poll status or obtain a local key. */
class MetadataReadAPI extends TuyaOpenAPI {
  private readonly deadline = Date.now() + DEADLINE_MS;
  private calls = 0;

  constructor(options: TuyaPlatformHomeConfigOptions) {
    super(options.endpoint || TuyaOpenAPI.getDefaultEndpoint(options.countryCode), options.accessId, options.accessKey,
      'en', false, options.forceIPv4);
    // Silence this one API instance, including login, transport errors and command-line debug mode.
    Object.defineProperty(this, 'log', {value: SILENT_LOG, writable: false});
  }

  async _refreshAccessTokenIfNeed(requestPath: string): Promise<void> {
    if (requestPath !== LOGIN) {
      requireValid(this.isLogin() && !this.isTokenExpired());
    }
  }

  async request(method: string, requestPath: string, params?, body?, options: TuyaRequestOptions = {}) {
    const login = method === 'post' && requestPath === LOGIN;
    const read = method === 'get' && (
      /^\/v1\.0\/users\/[A-Za-z0-9_-]{1,128}\/homes$/.test(requestPath)
      || /^\/v1\.0\/homes\/\d{1,32}\/(?:devices|rooms|rooms\/\d{1,32}\/devices)$/.test(requestPath)
      || /^\/v1\.0\/devices\/[A-Za-z0-9_-]{1,128}\/specifications$/.test(requestPath));
    requireValid((login || read) && ENDPOINTS.has(this.endpoint) && ++this.calls <= MAX_REQUESTS);
    const remaining = this.deadline - Date.now();
    requireValid(remaining > 0);
    return super.request(method, requestPath, params, body, {...options, attempts: 1,
      timeoutMs: Math.min(REQUEST_MS, remaining), shouldProceed: () => Date.now() < this.deadline});
  }
}

function homeOptions(value: TuyaPlatformConfigOptions): TuyaPlatformHomeConfigOptions {
  requireValid(record(value) && value.projectType === '2');
  const options = value as unknown as TuyaPlatformHomeConfigOptions;
  requireValid(Number.isSafeInteger(options.countryCode) && options.countryCode > 0
    && options.countryCode <= 999999 && (options.endpoint === undefined || options.endpoint === '' || ENDPOINTS.has(options.endpoint)));
  for (const field of ['accessId', 'accessKey', 'username', 'password', 'appSchema'] as const) {
    requireValid(typeof options[field] === 'string' && options[field].length > 0 && options[field].length <= 1024);
  }
  requireValid(/^[A-Za-z0-9_-]{1,64}$/.test(options.appSchema));
  requireValid(options.homeWhitelist === undefined || Array.isArray(options.homeWhitelist)
    && options.homeWhitelist.length <= 32 && options.homeWhitelist.every(id => Number.isSafeInteger(id) && id > 0));
  return options;
}

function numericId(value: unknown): string {
  requireValid((typeof value === 'string' || typeof value === 'number') && /^\d{1,32}$/.test(String(value)));
  if (typeof value === 'number') {
    requireValid(Number.isSafeInteger(value) && value > 0);
  }
  return String(value);
}

function list(value: unknown, maximum: number): unknown[] {
  requireValid(Array.isArray(value) && value.length <= maximum);
  return value;
}

function schema(value: unknown): TuyaDeviceSchema[] {
  requireValid(record(value));
  const status = list(value.status, 256), functions = list(value.functions, 256);
  requireValid(status.length + functions.length > 0);
  const result = new Map<string, TuyaDeviceSchema>();
  for (const [items, mode] of [[status, TuyaDeviceSchemaMode.READ_ONLY], [functions, TuyaDeviceSchemaMode.WRITE_ONLY]] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      requireValid(record(item) && typeof item.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(item.code)
        && typeof item.type === 'string' && Object.values(TuyaDeviceSchemaType).includes(item.type as TuyaDeviceSchemaType)
        && typeof item.values === 'string' && item.values.length <= 16384 && !seen.has(item.code));
      seen.add(item.code);
      const property: unknown = JSON.parse(item.values);
      requireValid(record(property) || typeof property === 'string');
      const previous = result.get(item.code);
      requireValid(!previous || previous.type === item.type && isDeepStrictEqual(previous.property, property));
      result.set(item.code, {code: item.code, type: item.type as TuyaDeviceSchemaType,
        mode: previous ? TuyaDeviceSchemaMode.READ_WRITE : mode, property});
    }
  }
  return [...result.values()].sort((left, right) => left.code.localeCompare(right.code));
}

/** Check essential controls independently; retain the complete previously vetted runtime schema. */
function compatibleSchema(previous: TuyaDeviceSchema[], fresh: TuyaDeviceSchema[]): void {
  requireValid(Array.isArray(previous) && previous.length > 0);
  for (const code of ['switch', 'temp_set']) {
    const old = previous.find(item => item.code === code);
    requireValid(old);
    const next = fresh.find(item => item.code === old.code);
    requireValid(next && next.type === old.type && next.mode === old.mode && isDeepStrictEqual(next.property, old.property));
  }
  requireValid(fresh.some(item => item.code === 'switch' && item.type === TuyaDeviceSchemaType.Boolean)
    && fresh.some(item => item.code === 'temp_set' && item.type === TuyaDeviceSchemaType.Integer));
}

async function refresh(request: FastWarmCloudMetadataRefreshRequest,
  dependencies: FastWarmCloudMetadataRefreshDependencies): Promise<{refreshed: true; restartRequired: true; deviceCount: number}> {
  const options = homeOptions(request.options);
  requireValid(typeof request.persistPath === 'string' && typeof request.instanceId === 'string'
    && /^[a-f0-9]{16}$/i.test(request.instanceId) && Array.isArray(request.deviceIds)
    && request.deviceIds.length > 0 && request.deviceIds.length <= 64
    && request.deviceIds.every(id => typeof id === 'string' && IDENTIFIER.test(id))
    && new Set(request.deviceIds).size === request.deviceIds.length);
  const old = await readFastWarmLanMetadata(request.persistPath, request.instanceId);
  const selected = new Set(request.deviceIds);
  requireValid(old.length > 0 && request.deviceIds.every(id => old.some(device => device.id === id && isFastWarmThermostat(device))));
  const now = dependencies.now ?? Date.now;
  const deadline = now() + DEADLINE_MS;
  const api = (dependencies.createAPI ?? (value => new MetadataReadAPI(value)))(options);
  const meter = await (dependencies.openUsageMeter ?? TuyaApiUsageMeter.open)(request.persistPath, request.instanceId, noop, now);
  api.setUsageMeter(meter);
  try {
    let calls = 0;
    const get = async (requestPath: string): Promise<unknown> => {
      const remaining = deadline - now();
      requireValid(remaining > 0 && ++calls <= MAX_REQUESTS);
      const response = await api.request('get', requestPath, null, null,
        {attempts: 1, timeoutMs: Math.min(REQUEST_MS, remaining), shouldProceed: () => now() < deadline});
      requireValid(response?.success === true && now() < deadline);
      return response.result;
    };
    const login = await api.homeLogin(options.countryCode, options.username, options.password, options.appSchema);
    requireValid(login?.success === true && typeof api.tokenInfo.uid === 'string'
      && IDENTIFIER.test(api.tokenInfo.uid) && now() < deadline);
    const homes = list(await get(`/v1.0/users/${api.tokenInfo.uid}/homes`), 32);
    const homeIds = homes.map(home => {
      requireValid(record(home));
      return numericId(home.home_id);
    });
    requireValid(new Set(homeIds).size === homeIds.length);
    const permittedHomes = options.homeWhitelist === undefined ? homeIds
      : homeIds.filter(id => options.homeWhitelist!.includes(Number(id)));
    const fresh = new Map<string, TuyaDevice>();
    for (const homeId of permittedHomes) {
      for (const value of list(await get(`/v1.0/homes/${homeId}/devices`), 512)) {
        requireValid(record(value) && typeof value.id === 'string' && IDENTIFIER.test(value.id));
        if (!selected.has(value.id)) {
          continue;
        }
        requireValid(!fresh.has(value.id) && isFastWarmThermostat(value as unknown as TuyaDevice)
        && (value.owner_id === undefined || String(value.owner_id) === homeId));
        const previous = old.find(device => device.id === value.id)!;
        if (previous.uuid && previous.uuid !== previous.id) {
          requireValid(value.uuid === previous.uuid);
        }
        requireValid(typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 256);
        // Refresh labels and membership only. Do not adopt cloud status, optional schema changes or credentials.
        const device = new TuyaDevice({...structuredClone(previous), name: value.name, owner_id: homeId, online: false});
        // A fully read room membership list below is the only source of room assignments.
        delete device.room_id;
        delete device.room_name;
        fresh.set(device.id, device);
      }
    }
    requireValid(fresh.size === selected.size);
    for (const device of fresh.values()) {
      const specification = schema(await get(`/v1.0/devices/${device.id}/specifications`));
      compatibleSchema(old.find(previous => previous.id === device.id)!.schema, specification);
    }
    for (const homeId of new Set([...fresh.values()].map(device => device.owner_id))) {
      const result = await get(`/v1.0/homes/${homeId}/rooms`);
      requireValid(record(result));
      const rooms = list(result.rooms, 128), roomIds = new Set<string>();
      const assignments = new Map<string, {id: string; name: string}>();
      for (const value of rooms) {
        requireValid(record(value) && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 256);
        const roomId = numericId(value.room_id);
        requireValid(!roomIds.has(roomId));
        roomIds.add(roomId);
        for (const member of list(await get(`/v1.0/homes/${homeId}/rooms/${roomId}/devices`), 512)) {
          requireValid(record(member) && typeof member.id === 'string' && IDENTIFIER.test(member.id));
          const device = fresh.get(member.id);
          if (!device || device.owner_id !== homeId) {
            continue;
          }
          requireValid(!assignments.has(member.id));
          assignments.set(member.id, {id: roomId, name: value.name.trim()});
        }
      }
      for (const device of fresh.values()) {
        if (device.owner_id !== homeId) {
          continue;
        }
        const room = assignments.get(device.id);
        if (room) {
          device.room_id = room.id;
          device.room_name = room.name;
        }
      }
    }
    requireValid(now() < deadline);
    // Re-read before the sole atomic commit so another metadata writer cannot be overwritten unnoticed.
    const current = await readFastWarmLanMetadata(request.persistPath, request.instanceId);
    requireValid(isDeepStrictEqual(current, old));
    await saveFastWarmLanMetadata(request.persistPath, request.instanceId, old.map(device => fresh.get(device.id) ?? device));
    return {refreshed: true, restartRequired: true, deviceCount: fresh.size};
  } finally {
    await meter.flush();
  }
}

/** Explicit UI action only. An unsuccessful or partial read leaves the previous startup cache intact. */
export async function refreshFastWarmCloudMetadata(request: FastWarmCloudMetadataRefreshRequest,
  dependencies: FastWarmCloudMetadataRefreshDependencies = {}): Promise<{refreshed: true; restartRequired: true; deviceCount: number}> {
  let key: string;
  try {
    requireValid(request && typeof request.persistPath === 'string' && typeof request.instanceId === 'string');
    key = `${path.resolve(request.persistPath)}\0${request.instanceId.toLowerCase()}`;
  } catch {
    throw failure();
  }
  const operation = (queues.get(key) ?? Promise.resolve()).then(() => refresh(request, dependencies)).catch(() => {
    throw failure();
  });
  const tail = operation.then(noop, noop);
  queues.set(key, tail);
  try {
    return await operation;
  } finally {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  }
}
