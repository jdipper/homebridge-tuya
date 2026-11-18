/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import {createHash} from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {TuyaPlatform} from '../src/platform';
import {parseFastWarmLocalOnlyOption} from '../src/config';
import TuyaDevice from '../src/device/TuyaDevice';
import TuyaHomeDeviceManager from '../src/device/TuyaHomeDeviceManager';
import TuyaCustomDeviceManager from '../src/device/TuyaCustomDeviceManager';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaOpenMQ from '../src/core/TuyaOpenMQ';
import FastWarmLanController from '../src/device/lan/FastWarmLanController';
import FastWarmLocalOnlyAPI from '../src/device/lan/FastWarmLocalOnlyAPI';
import {FastWarmLanKeyStore} from '../src/device/lan/FastWarmLanConfiguration';
import {saveFastWarmLanMetadata} from '../src/device/lan/FastWarmLanBootstrap';
import TuyaProgrammeProvider, {programmeToFastWarm} from '../src/device/schedule/TuyaProgrammeProvider';
import * as DeviceCache from '../src/util/DeviceCache';
import {TuyaApiUsageMeter} from '../src/util/TuyaApiUsage';

jest.mock('../src/device/lan/FastWarmLanController', () => ({__esModule: true, default: jest.fn()}));
const fixtures: {root: string; platform: TuyaPlatform}[] = [];
const log = {info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn()};
const ids = ['local-a', 'local-b', 'local-c'];
const week = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day =>
  [day, [330, 510, 1020, 1320].map(startMinute => ({startMinute, targetC: 18}))]));
const inventory = () => ids.map(id => new TuyaDevice({id, uuid: 'uuid-' + id, name: 'Thermostat', room_name: 'Test room',
  product_id: 'lmtejj3f4kafi2k1', category: 'wk', online: true, owner_id: '1', schema: [],
  status: [{code: 'temp_unit_convert', value: 'c'}, {code: 'temp_current', value: 999}, {code: 'temp_set', value: 999}]}));

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(async () => {
  for (const {root, platform} of fixtures.splice(0)) {
    await platform.programmeProvider?.close(); await fs.rm(root, {recursive: true, force: true});
  }
  jest.restoreAllMocks();
});

async function fixture(options: {cache?: 'missing' | 'bad' | 'incomplete'; missingKey?: boolean; selected?: any[]; flag?: any;
  custom?: boolean; hiddenFlag?: boolean; inheritedFlag?: boolean; getterFlag?: boolean;} = {}) {
  const root = await fs.mkdtemp('/private/tmp/fw-local-only-'), persist = path.join(root, 'persist');
  const config: any = {name: 'Local fixture bridge',
    cameras: [{deviceId: 'stale-camera', rtspUrl: 'rtsp://example.invalid/live'}], options: {
      projectType: options.custom ? '1' : '2', endpoint: 'https://openapi.tuyaeu.com', accessId: 'fixture-id', accessKey: 'fixture-secret',
      countryCode: 44, username: 'fixture-user', password: 'fixture-password', appSchema: 'smartlife',
      forceIPv4: false, generateWeatherAccessory: true,
      fastWarmLocalOnly: options.flag === undefined ? true : options.flag,
      fastWarmLocalDevices: options.selected ?? ids.map((deviceId, i) =>
        ({deviceId, address: `192.168.1.${10 + i}`, version: '3.5'}))}};
  const getter = jest.fn(() => {
    throw Error('Never log this getter secret');
  });
  if (options.hiddenFlag) {
    Object.defineProperty(config.options, 'fastWarmLocalOnly', {value: true, enumerable: false});
  }
  if (options.inheritedFlag) {
    delete config.options.fastWarmLocalOnly; Object.setPrototypeOf(config.options, {fastWarmLocalOnly: true});
  }
  if (options.getterFlag) {
    Object.defineProperty(config.options, 'fastWarmLocalOnly', {get: getter, enumerable: true});
  }
  const instance = TuyaProgrammeProvider.instanceId({projectType: config.options.projectType, endpoint: config.options.endpoint,
    accessId: config.options.accessId, username: config.options.username, bridge: config.name});
  await fs.mkdir(persist, {mode: 0o700});
  if (options.cache !== 'missing') {
    await saveFastWarmLanMetadata(persist, instance, inventory().filter(device => options.cache !== 'incomplete' || device.id !== ids[2]));
  }
  if (options.cache === 'bad') {
    await fs.writeFile(path.join(persist, `FastWarmLocalMetadata.${instance}.json`), 'invalid JSON', {mode: 0o600});
  }
  const store = new FastWarmLanKeyStore(persist, instance);
  for (const id of ids) {
    if (!options.missingKey || id !== ids[2]) {
      await store.set(id, 'abcdefghijklmnop');
    }
  }
  const cloudRequest = jest.spyOn(TuyaOpenAPI.prototype, 'request').mockRejectedValue(Error('Cloud forbidden in local-only test'));
  const homeLogin = jest.spyOn(TuyaOpenAPI.prototype, 'homeLogin');
  const token = jest.spyOn(TuyaOpenAPI.prototype, 'getToken');
  const mqStart = jest.spyOn(TuyaOpenMQ.prototype, 'start');
  const mqConnect = jest.spyOn(TuyaOpenMQ.prototype, '_connect');
  const usage = jest.spyOn(TuyaApiUsageMeter, 'open');
  const diagnostic = jest.spyOn(DeviceCache, 'writeDeviceCache');
  const startErrors: unknown[] = [], start = TuyaProgrammeProvider.prototype.start;
  jest.spyOn(TuyaProgrammeProvider.prototype, 'start').mockImplementation(async function(this: TuyaProgrammeProvider) {
    try {
      await start.call(this);
    } catch (error) {
      startErrors.push(error); throw error;
    }
  });
  const home = jest.spyOn(TuyaHomeDeviceManager.prototype, 'getHomeList');
  const custom = jest.spyOn(TuyaCustomDeviceManager.prototype, 'getAssetList');
  const beforeOnline: boolean[][] = [], listeners = new Set<any>(), connections = new Set<any>(), connected = new Set<string>();
  let target = 180;
  const controls = () => [{code: 'RoomTemper', dp_id: 105, value: 195}, {code: 'SetTemp', dp_id: 102, value: target},
    {code: 'ControlMode', dp_id: 103, value: 'smart'}, {code: 'Event_Adaptive_Set', dp_id: 110, value: 0},
    {code: 'TemperUnitChange', dp_id: 107, value: false}, {code: 'power1', dp_id: 101, value: true}];
  const raw = (id: string) => {
    for (const fn of listeners) {
      fn('local', 4, {devId: id, source: 'lan', status: controls()}, Date.now());
    }
  };
  const native = programmeToFastWarm(week);
  let controller: any;
  jest.mocked(FastWarmLanController).mockImplementation((selected, keys) => {
    controller = {has: (id: string) => selected.some(device => device.deviceId === id),
      isConnected: (id: string) => connected.has(id), generation: () => 1,
      addRawMessageListener: (fn: any) => listeners.add(fn), removeRawMessageListener: (fn: any) => listeners.delete(fn),
      addConnectionListener: (fn: any) => connections.add(fn), removeConnectionListener: (fn: any) => connections.delete(fn),
      close: jest.fn(),
      start: jest.fn(async (devices: TuyaDevice[]) => {
        beforeOnline.push(devices.map(device => device.online));
        for (const device of devices) {
          if (keys.has(device.id)) {
            connected.add(device.id); for (const fn of connections) {
              fn({deviceId: device.id, connected: true, generation: 1});
            } raw(device.id);
          }
        }
      }),
      readProperties: jest.fn(async (id: string, codes: string[]) => {
        if (!connected.has(id)) {
          throw Error('LAN unavailable');
        } raw(id);
        return {properties: controls().filter(property => codes.includes(property.code)), receivedAt: Date.now(), generation: 1};
      }),
      readSchedule: jest.fn(async (id: string) => {
        if (!connected.has(id)) {
          throw Error('LAN unavailable');
        } return {startedAt: Date.now(), finishedAt: Date.now(),
          state: structuredClone(native),
          fingerprint: createHash('sha256').update(JSON.stringify(native.days.map(day => [day.day, day.events]))).digest('hex'),
          timedOut: false, errors: []};
      }),
      issueOnce: jest.fn(async (id: string, properties: any, guard: any) => {
        if (!connected.has(id) || guard?.shouldProceed?.() === false) {
          throw Error('Blocked LAN write');
        }
        if (properties.SetTemp !== undefined) {
          target = properties.SetTemp;
        } raw(id);
      }),
    }; return controller;
  });
  const events = new EventEmitter();
  const api: any = Object.assign(events, {hap: {Service: {}, Characteristic: {}, uuid: {generate: (value: string) => 'uuid:' + value}},
    user: {persistPath: () => persist}, unregisterPlatformAccessories: jest.fn()});
  const accessory = jest.spyOn(TuyaPlatform.prototype, 'addAccessory').mockImplementation(() => undefined);
  const platform = new TuyaPlatform(log as any, config, api); fixtures.push({root, platform});
  platform.configureAccessory({UUID: 'unrelated-cached-accessory', displayName: 'Existing accessory'} as any);
  return {root, persist, instance, config, platform, api, events, getter, controller: () => controller, beforeOnline, accessory,
    cloudRequest, homeLogin, token, mqStart, mqConnect, usage, diagnostic, home, custom, startErrors};
}

test.each([false, true])('local-only cold startup keeps identities with zero cloud initialization (custom=%s)', async custom => {
  const f = await fixture({custom}); await f.platform.initDevices();
  expect(f.platform.deviceManager!.api).toBeInstanceOf(FastWarmLocalOnlyAPI);
  expect(f.platform.deviceManager!.devices.map(device => device.id)).toEqual(ids);
  expect(f.platform.deviceManager!.devices.map(device => device.uuid)).toEqual(ids.map(id => 'uuid-' + id));
  expect(f.beforeOnline).toEqual([[false, false, false]]);
  expect(f.accessory.mock.calls.map(call => call[0].id)).toEqual(ids);
  expect(f.startErrors).toEqual([]); expect(f.platform.programmeProvider).toBeDefined();
  expect(f.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  for (const call of [f.cloudRequest, f.homeLogin, f.token, f.mqStart, f.mqConnect, f.usage, f.diagnostic, f.home, f.custom]) {
    expect(call).not.toHaveBeenCalled();
  }
  expect((f.platform as any).programmeInstanceId()).toBe(f.instance);
  await expect(fs.stat(path.join(f.persist, `TuyaApiUsage.${f.instance}.json`))).rejects.toMatchObject({code: 'ENOENT'});
});

test('normal controls and complete weekly reads use LAN while stale cloud accessories cannot connect', async () => {
  const f = await fixture(); await f.platform.initDevices();
  const result = await f.platform.programmeProvider!.handle('/provider/read', {deviceId: ids[0]}) as any;
  expect(Object.values(result.zone.programme).flat()).toHaveLength(28);
  expect(result.zone.temperatureSource).toBe('lan'); expect(result.zone.measuredC).toBe(19.5);
  expect(await f.platform.deviceManager!.sendCommands(ids[0], [{code: 'temp_set', value: 185}])).toBe(true);
  expect(f.controller().issueOnce).toHaveBeenCalledWith(ids[0], {SetTemp: 185}, expect.any(Object));
  await expect(f.platform.deviceManager!.api.post('/v1.0/stale-scene/actions/trigger', {})).rejects.toThrow('local-only');
  expect(f.cloudRequest).not.toHaveBeenCalled(); expect(f.mqStart).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled();
});

test.each(['missing', 'bad', 'incomplete'] as const)('invalid local metadata stops startup without cloud fallback: %s', async cache => {
  const f = await fixture({cache}); await f.platform.initDevices();
  expect(f.platform.deviceManager!.devices).toEqual([]); expect(f.platform.programmeProvider).toBeUndefined();
  expect(FastWarmLanController).not.toHaveBeenCalled(); expect(f.accessory).not.toHaveBeenCalled();
  expect(f.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(f.cloudRequest).not.toHaveBeenCalled(); expect(f.homeLogin).not.toHaveBeenCalled();
  expect(f.mqStart).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled();
  expect(() => f.events.emit('shutdown')).not.toThrow();
});

test('a missing private key leaves that thermostat offline without a cloud attempt', async () => {
  const f = await fixture({missingKey: true}); await f.platform.initDevices();
  const zones = (await f.platform.programmeProvider!.handle('/provider/list', {}) as any).zones;
  expect(zones.map((zone: any) => zone.online)).toEqual([true, true, false]); expect(zones[2].measuredC).toBeNull();
  await expect(f.platform.programmeProvider!.handle('/provider/read', {deviceId: ids[2]})).rejects.toThrow('local');
  expect(f.cloudRequest).not.toHaveBeenCalled(); expect(f.mqStart).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled();
});

test.each([{flag: 'true'}, {flag: null}, {selected: []},
  {selected: [{deviceId: ids[0], address: '192.168.1.10', version: '3.5', enabled: false}]},
  {hiddenFlag: true}, {inheritedFlag: true}, {getterFlag: true}])('rejects invalid local-only options: %o', async options => {
  const f = await fixture(options); expect(f.events.listenerCount('didFinishLaunching')).toBe(0);
  expect(FastWarmLanController).not.toHaveBeenCalled();
  expect(f.getter).not.toHaveBeenCalled(); expect(JSON.stringify(log.error.mock.calls)).not.toContain('getter secret');
});

test('disabled local-only flag preserves the original provider identity and cloud entry points', async () => {
  const f = await fixture({flag: false}); const home = jest.spyOn(f.platform, 'initHomeProject').mockResolvedValue(undefined);
  await f.platform.initDevices(); expect(home).toHaveBeenCalledTimes(1); expect((f.platform as any).programmeInstanceId()).toBe(f.instance);
  expect(parseFastWarmLocalOnlyOption({})).toBe(false); expect(parseFastWarmLocalOnlyOption({fastWarmLocalOnly: false})).toBe(false);
});
