/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import fs from 'fs/promises';
import path from 'path';
import {TuyaPlatform} from '../src/platform';
import TuyaDevice from '../src/device/TuyaDevice';
import TuyaHomeDeviceManager from '../src/device/TuyaHomeDeviceManager';
import TuyaProgrammeProvider from '../src/device/schedule/TuyaProgrammeProvider';
import FastWarmLanController from '../src/device/lan/FastWarmLanController';
import FastWarmLanBootstrapAPI from '../src/device/lan/FastWarmLanBootstrapAPI';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import {FastWarmLanKeyStore} from '../src/device/lan/FastWarmLanConfiguration';
import {readFastWarmLanMetadata, saveFastWarmLanMetadata} from '../src/device/lan/FastWarmLanBootstrap';
import * as DeviceCache from '../src/util/DeviceCache';
import {initLogger} from '../src/util/Logger';

jest.mock('../src/device/TuyaHomeDeviceManager', () => ({__esModule: true, default: jest.fn()}));
jest.mock('../src/device/lan/FastWarmLanController', () => ({__esModule: true, default: jest.fn()}));
jest.mock('../src/device/lan/FastWarmLanConfiguration', () => {
  const actual = jest.requireActual('../src/device/lan/FastWarmLanConfiguration');
  return {...actual, FastWarmLanKeyStore: jest.fn()};
});
jest.mock('../src/device/schedule/TuyaProgrammeProvider', () => {
  const actual = jest.requireActual('../src/device/schedule/TuyaProgrammeProvider');
  return {__esModule: true, default: Object.assign(jest.fn(), {instanceId: actual.default.instanceId})};
});

const roots: string[] = [];
const log = {info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn()};
const selected = {deviceId: 'a', address: '192.168.1.10', version: '3.5'};
const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
function devices() {
  return ids.map(id => new TuyaDevice({id, uuid: 'uuid-' + id, name: 'Thermostat', category: 'wk', owner_id: '1',
    room_name: 'Test Room ' + id, product_id: 'lmtejj3f4kafi2k1', product_name: 'ET-63', online: true,
    schema: [{code: 'temp_set', mode: 'rw', type: 'Integer', property: {min: 50, max: 400, scale: 1, step: 5, unit: ''}}] as any,
    status: [{code: 'temp_set', value: 180}, {code: 'temp_unit_convert', value: 'c'}]}));
}

beforeEach(() => {jest.clearAllMocks(); initLogger(log as any);});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true});
});

async function fixture(options: {local?: any; login?: 'auth-fail' | 'network-fail' | 'success';
  discoveryFails?: boolean; cache?: boolean; selectedNotInCache?: boolean} = {}) {
  const root = await fs.mkdtemp('/private/tmp/fw-platform-local-'); roots.push(root);
  const persist = path.join(root, 'persist');
  const configuration: any = {name: 'Test bridge', options: {projectType: '2', endpoint: 'https://openapi.tuyaeu.com',
    accessId: 'test-access', accessKey: 'test-key', countryCode: 44, username: 'test-user', password: 'test-password',
    appSchema: 'smartlife', forceIPv4: false, generateWeatherAccessory: false,
    fastWarmLocalDevices: options.local === undefined ? [selected] : options.local}};
  const instanceId = TuyaProgrammeProvider.instanceId({projectType: '2', endpoint: configuration.options.endpoint,
    accessId: 'test-access', username: 'test-user', bridge: 'Test bridge'});
  if (options.cache !== false) {
    await saveFastWarmLanMetadata(persist, instanceId, devices().filter(device => !options.selectedNotInCache || device.id !== 'a'));
  }
  const order: string[] = [];
  const managers: any[] = [];
  jest.mocked(TuyaHomeDeviceManager).mockImplementation((api: any) => {
    const manager: any = Object.assign(new EventEmitter(), {api, devices: [], ownerIDs: [],
      mq: {start: jest.fn(), stop: jest.fn()},
      setFastWarmLan: jest.fn((controller: any) => {order.push('attach-local'); manager.fastWarmLan = controller;}),
      getHomeList: jest.fn(async () => {
        order.push('cloud-discovery');
        if (options.discoveryFails) throw Error('Simulated cloud discovery unavailable');
        return {success: true, result: [{home_id: 1, name: 'Test Home'}]};
      }),
      updateDevices: jest.fn(async () => {manager.devices = devices(); return manager.devices;}),
      getSceneList: jest.fn(async () => []),
      updateInfraredRemotes: jest.fn(async () => undefined),
    });
    managers.push(manager); return manager;
  });
  const provider = {start: jest.fn(async () => {order.push('provider-start');}), close: jest.fn(async () => undefined)};
  jest.mocked(TuyaProgrammeProvider).mockImplementation(() => provider as any);
  let controller: any;
  jest.mocked(FastWarmLanController).mockImplementation((configuration: any[], keys: Map<string, string>) => {
    controller = {has: (id: string) => configuration.some(value => value.deviceId === id),
      start: jest.fn(async (inventory: TuyaDevice[]) => {
        order.push('local-start');
        for (const device of inventory) if (controller.has(device.id) && keys.has(device.id)) device.online = true;
      }), close: jest.fn()};
    return controller;
  });
  const keyRead = jest.fn(async () => 'abcdefghijklmnop');
  jest.mocked(FastWarmLanKeyStore).mockImplementation(() => ({read: keyRead} as any));
  const login = jest.spyOn(TuyaOpenAPI.prototype, 'homeLogin').mockImplementation(async function(this: TuyaOpenAPI) {
    order.push('cloud-login');
    if (options.login === 'network-fail') throw Error('Simulated cloud network unavailable');
    if (options.login !== 'success') return {success: false, code: 2401, msg: 'Unavailable', result: null, t: 0, tid: ''} as any;
    this.tokenInfo.uid = 'test-user-id';
    return {success: true, result: {}, t: 0, tid: ''} as any;
  });
  jest.spyOn(TuyaPlatform.prototype as any, 'attachUsageMeter').mockResolvedValue(undefined);
  const diagnostic = jest.spyOn(DeviceCache, 'writeDeviceCache').mockResolvedValue(undefined);
  const accessory = jest.spyOn(TuyaPlatform.prototype, 'addAccessory').mockImplementation(() => {order.push('accessory');});
  const api: any = {hap: {Service: {}, Characteristic: {}, uuid: {generate: (value: string) => 'uuid:' + value}},
    user: {persistPath: () => persist}, on: jest.fn(), registerPlatformAccessories: jest.fn(), unregisterPlatformAccessories: jest.fn()};
  const platform = new TuyaPlatform(log as any, configuration, api);
  const unknown = {UUID: 'cached-non-fastwarm-device', displayName: 'Existing unrelated accessory'};
  platform.configureAccessory(unknown as any);
  return {root, persist, platform, api, managers, controller: () => controller, provider, order, keyRead, login,
    diagnostic, accessory, unknown, instanceId, configuration};
}

test.each(['auth-fail', 'network-fail'] as const)('cold local startup survives %s using the same manager and cached device identities', async login => {
  const data = await fixture({login});
  await data.platform.initDevices();
  expect(data.managers).toHaveLength(1); expect(data.platform.deviceManager).toBe(data.managers[0]);
  expect(data.managers[0].api).toBeInstanceOf(FastWarmLanBootstrapAPI);
  expect(data.platform.deviceManager!.devices.map(device => device.id)).toEqual(ids);
  expect(data.platform.deviceManager!.devices.map(device => device.online)).toEqual([true, false, false, false, false, false]);
  expect(data.platform.deviceManager!.devices[0].uuid).toBe('uuid-a');
  expect(data.controller().start).toHaveBeenCalledTimes(1);
  expect(data.order.indexOf('attach-local')).toBeLessThan(data.order.indexOf('cloud-login'));
  expect(data.order.indexOf('local-start')).toBeLessThan(data.order.indexOf('accessory'));
  expect(data.order.indexOf('local-start')).toBeLessThan(data.order.indexOf('provider-start'));
  expect(data.accessory.mock.calls.map(call => call[0].id)).toEqual(ids);
  expect(data.managers[0].updateInfraredRemotes).not.toHaveBeenCalled();
  expect(data.diagnostic).not.toHaveBeenCalled();
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(data.platform.programmeProvider).toBe(data.provider);
});

test('network failure during post-login discovery uses the saved thermostat inventory without retiring unknown accessories', async () => {
  const data = await fixture({login: 'success', discoveryFails: true});
  await data.platform.initDevices();
  expect(data.platform.deviceManager).toBe(data.managers[0]);
  expect(data.platform.deviceManager!.devices.map(device => device.id)).toEqual(ids);
  expect(data.platform.deviceManager!.devices.filter(device => device.online).map(device => device.id)).toEqual(['a']);
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(data.diagnostic).not.toHaveBeenCalled();
});

test.each([{cache: false}, {selectedNotInCache: true}])('missing enrollment metadata cannot manufacture a local device: %o', async options => {
  const data = await fixture({...options, login: 'network-fail'});
  await data.platform.initDevices();
  expect(data.platform.deviceManager!.devices).toEqual([]);
  expect(data.controller().start).not.toHaveBeenCalled();
  expect(data.provider.start).not.toHaveBeenCalled();
  expect(data.accessory).not.toHaveBeenCalled();
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
});

test('healthy startup saves metadata and retains normal cloud discovery and cache cleanup', async () => {
  const data = await fixture({login: 'success', cache: false});
  await data.platform.initDevices();
  expect((await readFastWarmLanMetadata(data.persist, data.instanceId)).map(device => device.id)).toEqual(ids);
  expect(data.managers[0].updateDevices).toHaveBeenCalledTimes(1);
  expect(data.managers[0].updateInfraredRemotes).toHaveBeenCalledTimes(1);
  expect(data.diagnostic).toHaveBeenCalledTimes(1);
  expect(data.api.unregisterPlatformAccessories).toHaveBeenCalledWith('@jdipper/homebridge-tuya', 'TuyaPlatform', [data.unknown]);
});

test.each([{local: []}, {local: [{...selected, enabled: false}]}])('disabled or absent local selection preserves the ordinary cloud startup: %o', async ({local}) => {
  const data = await fixture({local, login: 'success', cache: false});
  await data.platform.initDevices();
  expect(data.managers[0].api).toBeInstanceOf(TuyaOpenAPI);
  expect(data.managers[0].api).not.toBeInstanceOf(FastWarmLanBootstrapAPI);
  expect(FastWarmLanKeyStore).not.toHaveBeenCalled(); expect(FastWarmLanController).not.toHaveBeenCalled();
  expect(data.platform.deviceManager!.devices.map(device => device.online)).toEqual([true, true, true, true, true, true]);
  expect(data.diagnostic).toHaveBeenCalledTimes(1);
  expect(data.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
});

test.each([{local: [{...selected, localKey: 'never-log-this-secret'}]}, {local: [{...selected, address: '8.8.8.8'}]}])(
  'rejects inline credentials and public LAN destinations before startup: %o', async ({local}) => {
    const data = await fixture({local, cache: false});
    expect(data.api.on).not.toHaveBeenCalled();
    expect(data.managers).toHaveLength(0); expect(FastWarmLanController).not.toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('never-log-this-secret');
  },
);

test('changing local transport selection does not alter the provider or existing accessory identity', async () => {
  const data = await fixture({cache: false});
  const enabled = (data.platform as any).programmeInstanceId();
  data.platform.options.fastWarmLocalDevices = [];
  const disabled = (data.platform as any).programmeInstanceId();
  expect(enabled).toBe(disabled); expect(enabled).toBe(data.instanceId);
});

test('only LAN bootstrap receives bounded defaults, then normal explicit cloud request options resume', async () => {
  const request = jest.spyOn(TuyaOpenAPI.prototype, 'request').mockResolvedValue({success: true, result: {}, t: 0, tid: ''});
  const api = new FastWarmLanBootstrapAPI('https://openapi.tuyaeu.com', 'test-access', 'test-key');
  await api.request('get', '/startup');
  expect(request.mock.calls[0][4]).toEqual({attempts: 1, timeoutMs: 10000});
  await api.request('get', '/startup-shorter', null, null, {timeoutMs: 500});
  expect(request.mock.calls[1][4]).toEqual({attempts: 1, timeoutMs: 500});
  api.finishBootstrap();
  await api.request('get', '/normal');
  expect(request.mock.calls[2][4]).toEqual({});
  await api.request('get', '/normal-explicit', null, null, {attempts: 2, timeoutMs: 20000});
  expect(request.mock.calls[3][4]).toEqual({attempts: 2, timeoutMs: 20000});
});
