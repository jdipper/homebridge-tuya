import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { classifyTuyaRequest, TuyaApiUsageMeter } from '../src/util/TuyaApiUsage';

const instanceId = '0123456789abcdef';
let directory: string;
beforeEach(async () => {directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-usage-'));});
afterEach(async () => {await fs.rm(directory, {recursive: true, force: true});});

test('persists category totals privately, survives restart and keeps snapshots detached', async () => {
  const meter = await TuyaApiUsageMeter.open(directory, instanceId);
  await Promise.all(Array.from({length: 10}, async (_, index) => meter.record(index % 2 ? 'read' : 'programme')));
  await meter.flush();
  const state = meter.snapshot(); state.attempts = 999;
  const reloaded = await TuyaApiUsageMeter.open(directory, instanceId);
  expect(reloaded.snapshot().attempts).toBe(10);
  expect(reloaded.snapshot().byCategory).toMatchObject({read: 5, programme: 5, authentication: 0});
  const file = path.join(directory, `TuyaApiUsage.${instanceId}.json`);
  if (process.platform !== 'win32') {
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  }
  expect(await fs.readdir(directory)).toEqual([`TuyaApiUsage.${instanceId}.json`]);
});

test('UTC month rollover starts a new observed period without claiming earlier usage was measured', async () => {
  let now = Date.parse('2026-11-30T23:59:59Z');
  const meter = await TuyaApiUsageMeter.open(directory, instanceId, undefined, () => now);
  meter.record('authentication'); await meter.flush();
  now = Date.parse('2026-12-01T00:00:00Z');
  meter.record('programme'); await meter.flush();
  expect(meter.snapshot()).toMatchObject({month: '2026-12', attempts: 1, observedSince: '2026-12-01T00:00:00.000Z',
    byCategory: {authentication: 0, programme: 1}});
});

test('all categorization is lossy and no URL, query, device identifier or body reaches persisted state', async () => {
  const meter = await TuyaApiUsageMeter.open(directory, instanceId);
  const cases: Array<[string, string, unknown, unknown]> = [
    ['get', '/v1.0/token/REFRESH_TOKEN_CANARY', undefined, undefined],
    ['post', '/v1.0/iot-03/open-hub/access-config', undefined, {uid: 'UID_CANARY'}],
    ['get', '/v2.0/cloud/thing/DEVICE_CANARY/shadow/properties', {codes: 'RoomTemper,SetTemp'}, undefined],
    ['post', '/v2.0/cloud/thing/DEVICE_CANARY/shadow/properties/issue', undefined,
      {properties: JSON.stringify({week_program: 'PAYLOAD_CANARY'})}],
    ['get', '/unknown/DEVICE_CANARY?secret=SECRET_CANARY', undefined, undefined],
    ['post', '/commands', undefined, {password: 'PASSWORD_CANARY'}],
    ['head', '/unknown/DEVICE_CANARY', undefined, undefined],
  ];
  for (const [method, route, params, body] of cases) {
    meter.record(classifyTuyaRequest(method, route, params, body));
  }
  await meter.flush();
  expect(meter.snapshot().attempts).toBe(7);
  expect(Object.values(meter.snapshot().byCategory)).toEqual(Array(7).fill(1));
  const saved = await fs.readFile(path.join(directory, `TuyaApiUsage.${instanceId}.json`), 'utf8');
  expect(saved).not.toContain('CANARY');
});

test('refuses poisoned, inconsistent and permissive saved state rather than silently resetting totals', async () => {
  const meter = await TuyaApiUsageMeter.open(directory, instanceId);
  meter.record('read'); await meter.flush();
  const file = path.join(directory, `TuyaApiUsage.${instanceId}.json`), state = meter.snapshot();
  await fs.writeFile(file, JSON.stringify({...state, attempts: 9}));
  await expect(TuyaApiUsageMeter.open(directory, instanceId)).rejects.toThrow('invalid');
  await fs.writeFile(file, JSON.stringify({...state, token: 'SECRET_CANARY'}));
  await expect(TuyaApiUsageMeter.open(directory, instanceId)).rejects.toThrow('invalid');
  await fs.writeFile(file, JSON.stringify(state));
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o644);
    await expect(TuyaApiUsageMeter.open(directory, instanceId)).rejects.toThrow('private');
  }
});

test('does not follow a saved-counter symlink', async () => {
  if (process.platform === 'win32') {return;}
  const target = path.join(directory, 'unrelated.json'), file = path.join(directory, `TuyaApiUsage.${instanceId}.json`);
  await fs.writeFile(target, 'UNRELATED_CANARY', {mode: 0o600});
  await fs.symlink(target, file);
  await expect(TuyaApiUsageMeter.open(directory, instanceId)).rejects.toThrow();
  expect(await fs.readFile(target, 'utf8')).toBe('UNRELATED_CANARY');
});

test('a persistence failure leaves in-memory usage available and warns once without throwing from record', async () => {
  const warn = jest.fn(), meter = await TuyaApiUsageMeter.open(directory, instanceId, warn);
  await fs.rm(directory, {recursive: true});
  await fs.writeFile(directory, 'not a directory');
  meter.record('read'); await meter.flush();
  meter.record('read'); await meter.flush();
  expect(meter.snapshot().attempts).toBe(2);
  expect(warn).toHaveBeenCalledTimes(1);
});
