/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs/promises';
import path from 'path';
import TuyaOpenAPI from '../../src/core/TuyaOpenAPI';
import TuyaOpenMQ from '../../src/core/TuyaOpenMQ';
import TuyaDevice from '../../src/device/TuyaDevice';
import {initLogger} from '../../src/util/Logger';
import {classifyTuyaRequest, TuyaRequestUsage} from '../../src/util/TuyaApiUsage';
import {readFastWarmLanMetadata, saveFastWarmLanMetadata} from '../../src/device/lan/FastWarmLanBootstrap';
import {refreshFastWarmCloudMetadata} from '../../src/device/lan/FastWarmCloudMetadataRefresh';

const INSTANCE = '0123456789abcdef', PRODUCT = 'lmtejj3f4kafi2k1';
const LOGIN = '/v1.0/iot-01/associated-users/actions/authorized-login';
const roots: string[] = [];
const ok = (result: unknown): any => ({success: true, result, t: Date.now(), tid: 'fixture'});
const fail = (): any => ({success: false, result: null, code: 500, msg: 'PRIVATE-UPSTREAM-CANARY', t: Date.now(), tid: ''});
const standard = [
  {code: 'switch', type: 'Boolean', mode: 'rw', property: {}},
  {code: 'temp_set', type: 'Integer', mode: 'rw', property: {min: 41, max: 1040, step: 1, scale: 1, unit: ''}},
  {code: 'temp_unit_convert', type: 'Enum', mode: 'rw', property: {range: ['c', 'f']}},
];
const measured = {code: 'temp_current', type: 'Integer', mode: 'ro', property: {min: 0, max: 1130, step: 5, scale: 1, unit: 'C'}};
const device = (id: string) => new TuyaDevice({id, uuid: 'uuid-' + id, name: 'Old ' + id, product_id: PRODUCT,
  product_name: 'ET-63', category: 'wk', owner_id: '100', room_id: '10', room_name: 'Old room', online: false,
  schema: structuredClone([...standard, measured]) as any,
  status: [{code: 'switch', value: true}, {code: 'temp_set', value: 180}, {code: 'temp_current', value: 175}]});
const specification = () => ({status: standard.map(({code, type, property}) => ({code, type, values: JSON.stringify(property)})),
  functions: standard.map(({code, type, property}) => ({code, type, values: JSON.stringify(property)}))});

async function fixture() {
  const root = await fs.mkdtemp('/private/tmp/fw-explicit-refresh-'); roots.push(root);
  const persist = path.join(root, 'persist'), file = path.join(persist, `FastWarmLocalMetadata.${INSTANCE}.json`);
  await saveFastWarmLanMetadata(persist, INSTANCE, [device('selected'), device('untouched')]);
  const before = await fs.readFile(file), previous = await readFastWarmLanMetadata(persist, INSTANCE);
  const options: any = {projectType: '2', endpoint: 'https://openapi.tuyaeu.com', countryCode: 44,
    accessId: 'PRIVATE-ACCESS-ID', accessKey: 'PRIVATE-ACCESS-KEY', username: 'PRIVATE-USERNAME',
    password: 'PRIVATE-PASSWORD', appSchema: 'smartlife', debug: true, forceIPv4: false};
  const routes = new Map<string, any>([
    ['/v1.0/users/fixture-user/homes', ok([{home_id: 100}])],
    ['/v1.0/homes/100/devices', ok([{...device('selected'), name: 'New selected', online: true, status: [],
      local_key: 'MUST-NOT-CACHE', ip: '192.168.1.40'}, {...device('unselected-new'), name: 'Do not add'}])],
    ['/v1.0/devices/selected/specifications', ok(specification())],
    ['/v1.0/homes/100/rooms', ok({rooms: [{room_id: 20, name: '  New Room  '}, {room_id: 30, name: 'Empty Room'}]})],
    ['/v1.0/homes/100/rooms/20/devices', ok([{id: 'selected'}])],
    ['/v1.0/homes/100/rooms/30/devices', ok([])],
  ]);
  let meter: TuyaRequestUsage | undefined;
  const api = {tokenInfo: {uid: 'fixture-user'}, setUsageMeter: jest.fn(value => { meter = value; }),
    homeLogin: jest.fn(async () => { meter?.record('authentication'); return ok({}); }),
    request: jest.fn(async (method: string, requestPath: string, _params?, _body?, requestOptions?) => {
      if (requestOptions.shouldProceed() === false) return fail();
      meter?.record(classifyTuyaRequest(method, requestPath));
      const value = routes.get(requestPath);
      if (!value) throw Error('Unexpected request ' + requestPath);
      return structuredClone(value);
    })};
  const request = {persistPath: persist, instanceId: INSTANCE, options, deviceIds: ['selected']};
  const createAPI = jest.fn(() => api);
  return {root, persist, file, before, previous, options, request, api, createAPI, routes};
}

afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true});
});

test('explicit refresh updates only selected names/rooms, preserves vetted schema/status and unrelated devices, and meters seven reads', async () => {
  const f = await fixture(), mq = jest.spyOn(TuyaOpenMQ.prototype, 'start');
  const result = await refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI});
  expect(result).toEqual({refreshed: true, restartRequired: true, deviceCount: 1});
  const restored = await readFastWarmLanMetadata(f.persist, INSTANCE);
  expect(restored.map(value => value.id)).toEqual(['selected', 'untouched']);
  expect(restored[0]).toMatchObject({name: 'New selected', room_id: '20', room_name: 'New Room', online: false});
  expect(restored[0].schema).toEqual(f.previous[0].schema);
  expect(restored[0].status).toEqual(f.previous[0].status);
  expect(restored[1]).toEqual(f.previous[1]);
  expect(f.previous[0].name).toBe('Old selected');
  const text = await fs.readFile(f.file, 'utf8');
  for (const secret of ['PRIVATE-', 'MUST-NOT-CACHE', '192.168.', 'local_key', 'online']) expect(text).not.toContain(secret);
  const usage = JSON.parse(await fs.readFile(path.join(f.persist, `TuyaApiUsage.${INSTANCE}.json`), 'utf8'));
  expect(usage.attempts).toBe(7); expect(usage.byCategory.authentication).toBe(1); expect(usage.byCategory.read).toBe(6);
  expect(f.api.request).toHaveBeenCalledTimes(6);
  for (const [method, route, params, body, policy] of f.api.request.mock.calls) {
    expect(method).toBe('get'); expect(params).toBeNull(); expect(body).toBeNull();
    expect(policy).toMatchObject({attempts: 1, timeoutMs: 5000});
    expect(route).not.toMatch(/token|local-key|shadow|commands|access-config|issue/);
  }
  expect(mq).not.toHaveBeenCalled();
});

test.each([
  ['custom project', (f: any) => { f.options.projectType = '1'; }],
  ['untrusted endpoint', (f: any) => { f.options.endpoint = 'https://untrusted.invalid'; }],
  ['unknown selected ID', (f: any) => { f.request.deviceIds = ['new-device']; }],
  ['duplicate selection', (f: any) => { f.request.deviceIds = ['selected', 'selected']; }],
  ['empty selection', (f: any) => { f.request.deviceIds = []; }],
])('failed preflight %s performs no API request and retains exact cache bytes', async (_label, mutate) => {
  const f = await fixture(); mutate(f);
  await expect(refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI})).rejects.toThrow('FastWarm cloud metadata refresh failed.');
  expect(f.createAPI).not.toHaveBeenCalled(); expect(f.api.homeLogin).not.toHaveBeenCalled();
  expect(await fs.readFile(f.file)).toEqual(f.before);
  expect(await fs.readdir(f.persist)).toEqual([path.basename(f.file)]);
});

test.each([
  ['missing device', '/v1.0/homes/100/devices', () => ok([])],
  ['wrong product', '/v1.0/homes/100/devices', () => ok([{...device('selected'), product_id: 'other'}])],
  ['changed UUID', '/v1.0/homes/100/devices', () => ok([{...device('selected'), uuid: 'different'}])],
  ['home inventory error', '/v1.0/homes/100/devices', fail],
  ['specification error', '/v1.0/devices/selected/specifications', fail],
  ['empty specification', '/v1.0/devices/selected/specifications', () => ok({status: [], functions: []})],
  ['malformed schema JSON', '/v1.0/devices/selected/specifications', () => ok({status: [{code: 'switch', type: 'Boolean', values: '{broken'}], functions: []})],
  ['changed essential schema', '/v1.0/devices/selected/specifications', () => { const v = specification(); v.functions[1].type = 'String'; return ok(v); }],
  ['room list error', '/v1.0/homes/100/rooms', fail],
  ['room list malformed', '/v1.0/homes/100/rooms', () => ok({rooms: null})],
  ['room membership error', '/v1.0/homes/100/rooms/30/devices', fail],
  ['duplicate room membership', '/v1.0/homes/100/rooms/30/devices', () => ok([{id: 'selected'}])],
])('%s cannot replace any cache bytes with partial or empty metadata', async (_label, route, response) => {
  const f = await fixture(); f.routes.set(route, response());
  await expect(refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI})).rejects.toThrow('FastWarm cloud metadata refresh failed.');
  expect(await fs.readFile(f.file)).toEqual(f.before);
  const relevant = f.api.request.mock.calls.filter(call => call[1] === route);
  expect(relevant).toHaveLength(1);
  const usage = JSON.parse(await fs.readFile(path.join(f.persist, `TuyaApiUsage.${INSTANCE}.json`), 'utf8'));
  expect(usage.attempts).toBe(1 + f.api.request.mock.calls.length);
});

test('a failed explicit login is counted once without a retry or any discovery GET', async () => {
  const f = await fixture();
  f.api.homeLogin.mockImplementation(async () => {
    f.api.setUsageMeter.mock.calls[0][0].record('authentication');
    throw Error('PRIVATE-PASSWORD PRIVATE-ACCESS-KEY');
  });
  let error: unknown;
  try { await refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI}); } catch (failure) { error = failure; }
  expect(String(error)).toBe('Error: FastWarm cloud metadata refresh failed.');
  expect(f.api.homeLogin).toHaveBeenCalledTimes(1); expect(f.api.request).not.toHaveBeenCalled();
  expect(await fs.readFile(f.file)).toEqual(f.before);
  const usage = JSON.parse(await fs.readFile(path.join(f.persist, `TuyaApiUsage.${INSTANCE}.json`), 'utf8'));
  expect(usage.attempts).toBe(1); expect(usage.byCategory.authentication).toBe(1);
});

test('the total deadline stops discovery without another request or a cache replacement', async () => {
  const f = await fixture(), original = f.api.request.getMockImplementation()!;
  let now = 1800000000000;
  f.api.request.mockImplementation(async (...args) => { const response = await original(...args); now += 60001; return response; });
  await expect(refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI, now: () => now})).rejects.toThrow();
  expect(f.api.request).toHaveBeenCalledTimes(1); expect(await fs.readFile(f.file)).toEqual(f.before);
});

test('a proven complete empty room list clears only the selected room assignment', async () => {
  const f = await fixture(); f.routes.set('/v1.0/homes/100/rooms', ok({rooms: []}));
  await refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI});
  const restored = await readFastWarmLanMetadata(f.persist, INSTANCE);
  expect(restored[0].room_name).toBeUndefined(); expect(restored[0].room_id).toBeUndefined();
  expect(restored[1].room_name).toBe('Old room');
});

test('same-instance explicit refreshes serialize; a failed first action is never replayed', async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.api.homeLogin.mockImplementationOnce(async () => { await held; return fail(); });
  const first = refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI});
  const firstFailure = expect(first).rejects.toThrow('FastWarm cloud metadata refresh failed.');
  while (f.api.homeLogin.mock.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const second = refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI});
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.createAPI).toHaveBeenCalledTimes(1);
  release(); await firstFailure;
  await expect(second).resolves.toMatchObject({refreshed: true});
  expect(f.createAPI).toHaveBeenCalledTimes(2); expect(f.api.homeLogin).toHaveBeenCalledTimes(2);
});

test('an external metadata edit during discovery prevents the final commit', async () => {
  const f = await fixture(), original = f.api.request.getMockImplementation()!;
  f.api.request.mockImplementation(async (...args) => {
    const response = await original(...args);
    if (args[1].endsWith('/rooms/30/devices')) {
      const newer = await readFastWarmLanMetadata(f.persist, INSTANCE); newer[1].name = 'External change';
      await saveFastWarmLanMetadata(f.persist, INSTANCE, newer);
    }
    return response;
  });
  await expect(refreshFastWarmCloudMetadata(f.request, {createAPI: f.createAPI})).rejects.toThrow();
  const restored = await readFastWarmLanMetadata(f.persist, INSTANCE);
  expect(restored[0].name).toBe('Old selected'); expect(restored[1].name).toBe('External change');
});

test('production API uses a silent isolated logger, one-attempt request deadlines and only approved routes', async () => {
  const f = await fixture(), log = {info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()};
  initLogger(log);
  let client: any;
  const transport = jest.spyOn(TuyaOpenAPI.prototype, 'request').mockImplementation(async function(this: any,
    method, route, params, body, policy) {
    client = this;
    expect(policy).toMatchObject({attempts: 1, timeoutMs: expect.any(Number)});
    expect(policy!.timeoutMs).toBeLessThanOrEqual(5000);
    this.usageMeter.record(classifyTuyaRequest(method, route));
    if (route === LOGIN) return ok({access_token: 'PRIVATE-TOKEN', refresh_token: 'PRIVATE-REFRESH', uid: 'fixture-user', expire_time: 3600});
    return structuredClone(f.routes.get(route));
  });
  await refreshFastWarmCloudMetadata(f.request);
  expect(transport).toHaveBeenCalledTimes(7);
  expect(Object.values(log).every(value => value.mock.calls.length === 0)).toBe(true);
  const usage = JSON.parse(await fs.readFile(path.join(f.persist, `TuyaApiUsage.${INSTANCE}.json`), 'utf8'));
  expect(usage.attempts).toBe(7);
  for (const [method, route] of [['post', '/v1.0/devices/selected/commands'], ['get', '/v1.0/devices/selected'],
    ['get', '/v1.0/token'], ['get', '/v1.0/iot-03/open-hub/access-config'], ['get', '/v2.0/cloud/thing/selected/shadow/properties']]) {
    await expect(client.request(method, route)).rejects.toThrow();
  }
  expect(transport).toHaveBeenCalledTimes(7);
  client.tokenInfo.expire = 0;
  await expect(client._refreshAccessTokenIfNeed('/v1.0/homes/100/devices')).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(7);
});

test('an unexpected login platform URL cannot receive a follow-up request or credentials', async () => {
  const f = await fixture();
  const transport = jest.spyOn(TuyaOpenAPI.prototype, 'request').mockImplementation(async function(this: any, method, route) {
    this.usageMeter.record(classifyTuyaRequest(method, route));
    return ok({access_token: 'PRIVATE-TOKEN', refresh_token: 'PRIVATE-REFRESH', uid: 'fixture-user', expire_time: 3600,
      platform_url: 'https://untrusted.invalid'});
  });
  await expect(refreshFastWarmCloudMetadata(f.request)).rejects.toThrow('FastWarm cloud metadata refresh failed.');
  expect(transport).toHaveBeenCalledTimes(1); expect(await fs.readFile(f.file)).toEqual(f.before);
  const usage = JSON.parse(await fs.readFile(path.join(f.persist, `TuyaApiUsage.${INSTANCE}.json`), 'utf8'));
  expect(usage.attempts).toBe(1);
});
