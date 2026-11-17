import fs from 'fs/promises';
import {constants} from 'fs';
import path from 'path';
import TuyaDevice, {TuyaDeviceSchema, TuyaDeviceSchemaType, TuyaDeviceStatus} from '../TuyaDevice';
import {isFastWarmThermostat} from '../profile/FastWarmThermostat';
import {writePrivateJson} from '../../util/PrivateFile';

const MAX_BYTES = 1024 * 1024;
const MAX_DEVICES = 64;
const STRINGS: Record<string, number> = {id: 128, uuid: 128, name: 256, product_id: 128, product_name: 256,
  category: 64, owner_id: 128, room_id: 128, room_name: 256, time_zone: 100};
const TIMES = ['create_time', 'active_time', 'update_time'];
const FIELDS = new Set([...Object.keys(STRINGS), ...TIMES, 'schema', 'status']);
const STATUS_CODES = new Set(['switch', 'temp_set', 'temp_current', 'temp_unit_convert', 'child_lock',
  'factory_reset', 'holiday_days_set', 'mode', 'work_state', 'c_f']);
const SENSITIVE = /password|secret|(?:access|refresh|local|api|tuya)[_-]?(?:key|token)|authorization|ticket/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireValid(allowed: unknown): asserts allowed {
  if (!allowed) {
    throw new Error('The private FastWarm startup metadata is invalid.');
  }
}

function filePath(persistPath: string, instanceId: string): string {
  requireValid(typeof persistPath === 'string' && path.isAbsolute(persistPath) && !persistPath.includes('\0')
    && /^[a-f0-9]{16}$/.test(instanceId));
  return path.join(persistPath, `FastWarmLocalMetadata.${instanceId}.json`);
}

async function requireDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory);
  requireValid(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o022)
    && (!process.getuid || info.uid === process.getuid()));
}

function validCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value) && !SENSITIVE.test(value);
}

function schemaProperty(value: unknown, strict: boolean): TuyaDeviceSchema['property'] {
  if (typeof value === 'string') {
    requireValid(value.length <= 256 && !SENSITIVE.test(value));
    return value;
  }
  requireValid(record(value));
  const allowed = new Set(['min', 'max', 'scale', 'step', 'unit', 'range', 'maxlen']);
  if (strict) {
    requireValid(Object.keys(value).every(key => allowed.has(key)));
  }
  const result: Record<string, unknown> = {};
  for (const key of ['min', 'max', 'scale', 'step', 'maxlen']) {
    if (value[key] !== undefined) {
      requireValid(typeof value[key] === 'number' && Number.isFinite(value[key]));
      if (key === 'scale') {
        requireValid(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 10);
      }
      if (key === 'step') {
        requireValid(value[key] > 0);
      }
      if (key === 'maxlen') {
        requireValid(Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 65536);
      }
      result[key] = value[key];
    }
  }
  if (result.min !== undefined && result.max !== undefined) {
    requireValid(Number(result.min) <= Number(result.max));
  }
  if (value.unit !== undefined) {
    requireValid(typeof value.unit === 'string' && value.unit.length <= 64);
    result.unit = value.unit;
  }
  if (value.range !== undefined) {
    requireValid(Array.isArray(value.range) && value.range.length <= 128
      && value.range.every(item => typeof item === 'string' && item.length <= 128 && !SENSITIVE.test(item)));
    result.range = [...value.range];
  }
  return result as TuyaDeviceSchema['property'];
}

function schemas(value: unknown, strict: boolean): TuyaDeviceSchema[] {
  requireValid(Array.isArray(value) && value.length <= 128);
  const seen = new Set<string>();
  const result: TuyaDeviceSchema[] = [];
  for (const item of value) {
    requireValid(record(item));
    if (!validCode(item.code)) {
      requireValid(!strict);
      continue;
    }
    requireValid(!seen.has(item.code) && Object.values(TuyaDeviceSchemaType).includes(item.type as TuyaDeviceSchemaType)
      && ['', 'rw', 'ro', 'wo'].includes(String(item.mode)));
    if (strict) {
      requireValid(Object.keys(item).every(key => ['code', 'mode', 'type', 'property'].includes(key)));
    }
    seen.add(item.code);
    result.push({code: item.code, mode: item.mode as TuyaDeviceSchema['mode'], type: item.type as TuyaDeviceSchemaType,
      property: schemaProperty(item.property, strict)});
  }
  return result;
}

function statuses(value: unknown, strict: boolean): TuyaDeviceStatus[] {
  requireValid(Array.isArray(value) && value.length <= 128);
  const result: TuyaDeviceStatus[] = [], seen = new Set<string>();
  for (const item of value) {
    requireValid(record(item));
    if (!validCode(item.code) || !STATUS_CODES.has(item.code)) {
      requireValid(!strict);
      continue;
    }
    requireValid(!seen.has(item.code));
    if (strict) {
      requireValid(Object.keys(item).every(key => ['code', 'value'].includes(key)));
    }
    requireValid(typeof item.value === 'boolean' || (typeof item.value === 'number' && Number.isFinite(item.value))
      || (typeof item.value === 'string' && item.value.length <= 256 && /^[A-Za-z0-9_.+-]*$/.test(item.value)
        && !SENSITIVE.test(item.value)));
    seen.add(item.code);
    result.push({code: item.code, value: item.value as TuyaDeviceStatus['value']});
  }
  return result;
}

function metadata(value: unknown, strict: boolean): Partial<TuyaDevice> {
  requireValid(record(value));
  if (strict) {
    requireValid(Object.keys(value).every(key => FIELDS.has(key)));
  }
  const result: Record<string, unknown> = {};
  for (const [key, maximum] of Object.entries(STRINGS)) {
    if (value[key] === undefined) {
      continue;
    }
    requireValid(typeof value[key] === 'string' && value[key].length <= maximum && !value[key].includes('\0'));
    result[key] = value[key];
  }
  requireValid(typeof result.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.id)
    && result.product_id === 'lmtejj3f4kafi2k1' && typeof result.name === 'string'
    && typeof result.category === 'string' && result.category.length > 0);
  for (const key of TIMES) {
    if (value[key] !== undefined) {
      requireValid(typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0);
      result[key] = value[key];
    }
  }
  result.schema = schemas(value.schema, strict);
  result.status = statuses(value.status, strict);
  return result as Partial<TuyaDevice>;
}

/** Inventory only: credentials, network addresses and cloud availability are never cached here. */
export async function saveFastWarmLanMetadata(persistPath: string, instanceId: string, devices: readonly TuyaDevice[]): Promise<void> {
  const file = filePath(persistPath, instanceId);
  requireValid(Array.isArray(devices));
  const selected = devices.filter(isFastWarmThermostat);
  requireValid(selected.length <= MAX_DEVICES);
  const saved = selected.map(device => metadata(device, false));
  requireValid(new Set(saved.map(device => device.id)).size === saved.length);
  const payload = {version: 1, devices: saved};
  requireValid(Buffer.byteLength(JSON.stringify(payload, null, 2) + '\n') <= MAX_BYTES);
  await fs.mkdir(persistPath, {recursive: true, mode: 0o700});
  await requireDirectory(persistPath);
  try {
    const existing = await fs.lstat(file);
    requireValid(existing.isFile() && !existing.isSymbolicLink() && (!process.getuid || existing.uid === process.getuid()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await writePrivateJson(file, payload);
}

/** A restored device remains offline until its selected LAN connection supplies fresh evidence. */
export async function readFastWarmLanMetadata(persistPath: string, instanceId: string): Promise<TuyaDevice[]> {
  const file = filePath(persistPath, instanceId);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    await requireDirectory(persistPath);
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    requireValid(info.isFile() && !(info.mode & 0o077) && info.size > 0 && info.size <= MAX_BYTES
      && (!process.getuid || info.uid === process.getuid()));
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) {
        break;
      }
      length += read.bytesRead;
    }
    requireValid(length > 0 && length <= MAX_BYTES && length === info.size);
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } catch {
      throw new Error('The private FastWarm startup metadata is invalid.');
    }
    requireValid(record(value) && Object.keys(value).sort().join(',') === 'devices,version' && value.version === 1
      && Array.isArray(value.devices) && value.devices.length <= MAX_DEVICES);
    const saved = value.devices.map(device => metadata(device, true));
    requireValid(new Set(saved.map(device => device.id)).size === saved.length);
    return saved.map(device => new TuyaDevice({...device, uuid: device.uuid || device.id,
      product_name: device.product_name || 'FastWarm ET-63', owner_id: device.owner_id || '', online: false}));
  } finally {
    await handle.close();
  }
}
