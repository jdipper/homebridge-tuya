import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { writePrivateJson } from '../../util/PrivateFile';

export interface FastWarmLocalDeviceConfig {
  deviceId: string;
  address: string;
  version: '3.5';
  enabled?: boolean;
}

const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOCAL_KEY = /^[\x20-\x7e]{16}$/;
const MAX_FILE_BYTES = 64 * 1024;
const writes = new Map<string, Promise<void>>();

function configurationError(): Error {
  return new Error('FastWarm local device configuration is invalid.');
}

function storageError(): Error {
  return new Error('FastWarm local key storage is unavailable.');
}

/** JSON objects only: accessors and prototype-bearing objects are not configuration data. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function privateAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    return false;
  }
  const octets = value.split('.').map(Number);
  return octets.every(octet => octet <= 255)
    && (octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
      || octets[0] === 192 && octets[1] === 168);
}

export function parseFastWarmLocalDevices(value: unknown): FastWarmLocalDeviceConfig[] {
  if (value === undefined) {
    return [];
  }
  try {
    if (!Array.isArray(value)) {
      throw configurationError();
    }
    const ids = new Set<string>(), addresses = new Set<string>();
    return Array.from(value, entry => {
      if (!isRecord(entry) || Reflect.ownKeys(entry).some(key => !['deviceId', 'address', 'version', 'enabled'].includes(String(key)))
        || typeof entry.deviceId !== 'string' || !DEVICE_ID.test(entry.deviceId) || !privateAddress(entry.address)
        || entry.version !== '3.5' || (Object.hasOwn(entry, 'enabled') && typeof entry.enabled !== 'boolean')
        || ids.has(entry.deviceId) || addresses.has(entry.address)) {
        throw configurationError();
      }
      ids.add(entry.deviceId);
      addresses.add(entry.address);
      return {deviceId: entry.deviceId, address: entry.address, version: '3.5',
        ...(typeof entry.enabled === 'boolean' ? {enabled: entry.enabled} : {})};
    });
  } catch {
    // Neither a malformed entry nor a caller-supplied getter may disclose its contents through an error.
    throw configurationError();
  }
}

interface KeyFile {
  version: 1;
  keys: Record<string, string>;
}

function validKeyFile(value: unknown): value is KeyFile {
  return isRecord(value) && Object.keys(value).sort().join(',') === 'keys,version'
    && value.version === 1 && isRecord(value.keys)
    && Object.entries(value.keys).every(([id, key]) => DEVICE_ID.test(id) && typeof key === 'string' && LOCAL_KEY.test(key));
}

/** Keys stay outside Homebridge configuration and diagnostics; callers receive no filesystem error details. */
export class FastWarmLanKeyStore {
  private readonly directory: string;
  private readonly filename: string;

  constructor(persistPath: string, instanceId: string) {
    if (typeof persistPath !== 'string' || !path.isAbsolute(persistPath) || persistPath.includes('\0')
      || persistPath.split(path.sep).includes('..') || typeof instanceId !== 'string' || !/^[a-f0-9]{16}$/i.test(instanceId)) {
      throw storageError();
    }
    this.directory = path.resolve(persistPath);
    this.filename = `FastWarmLocalKeys.${instanceId.toLowerCase()}.json`;
  }

  async read(deviceId: string): Promise<string | undefined> {
    try {
      this.validateId(deviceId);
      const file = await this.verifiedFilePath();
      const saved = await this.load(file);
      return saved && Object.hasOwn(saved.keys, deviceId) ? saved.keys[deviceId] : undefined;
    } catch {
      throw storageError();
    }
  }

  async has(deviceId: string): Promise<boolean> {
    return (await this.read(deviceId)) !== undefined;
  }

  async set(deviceId: string, key: string): Promise<void> {
    try {
      this.validateId(deviceId);
      if (typeof key !== 'string' || !LOCAL_KEY.test(key)) {
        throw storageError();
      }
      const file = await this.verifiedFilePath();
      const pending = (writes.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        // Recheck after waiting; a failed/changed file is never silently overwritten with a fresh store.
        if (await this.verifiedFilePath() !== file) {
          throw storageError();
        }
        const saved = await this.load(file);
        const keys = Object.assign(Object.create(null) as Record<string, string>, saved?.keys);
        keys[deviceId] = key;
        const next: KeyFile = {version: 1, keys};
        if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n', 'utf8') > MAX_FILE_BYTES) {
          throw storageError();
        }
        await writePrivateJson(file, next);
      });
      writes.set(file, pending);
      try {
        await pending;
      } finally {
        if (writes.get(file) === pending) {
          writes.delete(file);
        }
      }
    } catch {
      throw storageError();
    }
  }

  private validateId(deviceId: string): void {
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
      throw storageError();
    }
  }

  private async verifiedFilePath(): Promise<string> {
    // Reject symlinks in every supplied path component, including the persist directory itself.
    let current = path.parse(this.directory).root;
    for (const component of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const directory = await fs.lstat(current);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw storageError();
      }
    }
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || directory.mode & 0o022
      || (typeof process.getuid === 'function' && directory.uid !== process.getuid())) {
      throw storageError();
    }
    return path.join(await fs.realpath(this.directory), this.filename);
  }

  private async load(file: string): Promise<KeyFile | undefined> {
    if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
      throw storageError();
    }
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      // NONBLOCK ensures that an unexpected FIFO cannot hang before its file type is checked.
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw storageError();
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES || (info.mode & 0o7777) !== 0o600 || info.nlink > 1
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw storageError();
      }
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length <= MAX_FILE_BYTES) {
        const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) {
          break;
        }
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) {
        throw storageError();
      }
      const saved: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (!validKeyFile(saved)) {
        throw storageError();
      }
      return saved;
    } finally {
      await handle.close();
    }
  }
}
