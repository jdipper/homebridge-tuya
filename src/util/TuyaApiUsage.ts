import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { writePrivateJson } from './PrivateFile';

export const TUYA_REQUEST_CATEGORIES = ['authentication', 'messaging', 'temperature', 'programme', 'read', 'control', 'other'] as const;
export type TuyaRequestCategory = typeof TUYA_REQUEST_CATEGORIES[number];
export interface TuyaRequestUsage {
  record(category: TuyaRequestCategory): void;
}
export interface TuyaApiUsageSnapshot {
  version: 1;
  scope: 'this-plugin-instance';
  measure: 'http-attempts-not-billing';
  instanceId: string;
  month: string;
  observedSince: string;
  updatedAt: string;
  attempts: number;
  byCategory: Record<TuyaRequestCategory, number>;
}

/** Classification is deliberately lossy: no request value or URL is retained. */
export function classifyTuyaRequest(method: string, inputPath: string, params?: unknown, body?: unknown): TuyaRequestCategory {
  const route = inputPath.split('?')[0];
  if (route.startsWith('/v1.0/token') || route === '/v1.0/iot-01/associated-users/actions/authorized-login'
    || route === '/v1.0/iot-03/users/login') {
    return 'authentication';
  }
  if (route === '/v1.0/iot-03/open-hub/access-config') {
    return 'messaging';
  }
  const query = params && typeof params === 'object' ? params as Record<string, unknown> : undefined;
  if (method.toLowerCase() === 'get') {
    if (route.endsWith('/shadow/properties') && typeof query?.codes === 'string'
      && query.codes.split(',').includes('RoomTemper')) {
      return 'temperature';
    }
    return 'read';
  }
  if ((route.endsWith('/shadow/properties/issue') || /^\/v2\.1\/cloud\/thing\/group\/[1-9][0-9]{0,29}\/properties$/.test(route))
    && body && typeof body === 'object') {
    const properties = (body as Record<string, unknown>).properties;
    if (typeof properties === 'string' && properties.length <= 65536) {
      try {
        const value = JSON.parse(properties);
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'week_program')) {
          return 'programme';
        }
      } catch { /* A malformed body is still counted, without inspecting or recording its contents. */ }
    }
  }
  return ['post', 'put', 'patch', 'delete'].includes(method.toLowerCase()) ? 'control' : 'other';
}

function newSnapshot(instanceId: string, now: number): TuyaApiUsageSnapshot {
  const stamp = new Date(now).toISOString();
  return {version: 1, scope: 'this-plugin-instance', measure: 'http-attempts-not-billing', instanceId,
    month: stamp.slice(0, 7), observedSince: stamp, updatedAt: stamp, attempts: 0,
    byCategory: Object.fromEntries(TUYA_REQUEST_CATEGORIES.map(category => [category, 0])) as Record<TuyaRequestCategory, number>};
}
function validSnapshot(value: unknown, instanceId: string): value is TuyaApiUsageSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const item = value as TuyaApiUsageSnapshot;
  if (Object.keys(item).sort().join(',') !== 'attempts,byCategory,instanceId,measure,month,observedSince,scope,updatedAt,version'
    || item.version !== 1 || item.scope !== 'this-plugin-instance' || item.measure !== 'http-attempts-not-billing'
    || item.instanceId !== instanceId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.month)
    || typeof item.observedSince !== 'string' || !Number.isFinite(Date.parse(item.observedSince))
    || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))
    || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !item.byCategory
    || Object.keys(item.byCategory).sort().join(',') !== [...TUYA_REQUEST_CATEGORIES].sort().join(',')) {
    return false;
  }
  return TUYA_REQUEST_CATEGORIES.every(category => Number.isSafeInteger(item.byCategory[category]) && item.byCategory[category] >= 0)
    && TUYA_REQUEST_CATEGORIES.reduce((sum, category) => sum + item.byCategory[category], 0) === item.attempts;
}

/** One production API client's observed attempts. Other apps and provider billing are outside its scope. */
export class TuyaApiUsageMeter implements TuyaRequestUsage {
  private pending?: Promise<void>;
  private dirty = false;
  private warned = false;

  private constructor(
    private readonly file: string,
    private state: TuyaApiUsageSnapshot,
    private readonly onError: () => void,
    private readonly now: () => number,
  ) {}

  static async open(directory: string, instanceId: string, onError: () => void = () => undefined,
    now: () => number = Date.now): Promise<TuyaApiUsageMeter> {
    if (!/^[a-f0-9]{16}$/.test(instanceId)) {
      throw new Error('A validated Tuya instance ID is required for usage accounting.');
    }
    const file = path.join(directory, `TuyaApiUsage.${instanceId}.json`);
    let state = newSnapshot(instanceId, now());
    try {
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8192 || stat.mode & 0o077
          || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
          throw new Error('Usage accounting needs a private owned regular file.');
        }
        const saved: unknown = JSON.parse(await handle.readFile('utf8'));
        if (!validSnapshot(saved, instanceId)) {
          throw new Error('The saved usage accounting is invalid.');
        }
        if (saved.month === state.month) {
          state = saved;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return new TuyaApiUsageMeter(file, state, onError, now);
  }

  snapshot(): TuyaApiUsageSnapshot {
    return structuredClone(this.state);
  }

  record(category: TuyaRequestCategory): void {
    if (!TUYA_REQUEST_CATEGORIES.includes(category)) {
      throw new Error('Unknown Tuya request category.');
    }
    const now = this.now(), stamp = new Date(now).toISOString();
    if (this.state.month !== stamp.slice(0, 7)) {
      this.state = newSnapshot(this.state.instanceId, now);
    }
    if (!Number.isSafeInteger(this.state.attempts + 1)) {
      throw new Error('Usage accounting counter overflow.');
    }
    this.state.attempts++;
    this.state.byCategory[category]++;
    this.state.updatedAt = stamp;
    this.dirty = true;
    this.write();
  }

  private write(): void {
    if (this.pending) {
      return;
    }
    this.pending = this.persist().finally(() => {
      this.pending = undefined;
      if (this.dirty) {
        this.write();
      }
    });
  }

  private async persist(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        await writePrivateJson(this.file, this.snapshot());
      } catch {
        // Keep in-memory accounting usable even on a full or read-only disk.
        if (!this.warned) {
          this.warned = true;
          try {
            this.onError();
          } catch { /* Diagnostics cannot interrupt heating. */ }
        }
      }
    }
  }

  async flush(): Promise<void> {
    while (this.pending) {
      await this.pending;
    }
  }
}
