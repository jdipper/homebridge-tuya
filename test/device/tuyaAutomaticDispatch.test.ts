/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import EventEmitter from 'events';
import TuyaOpenAPI from '../../src/core/TuyaOpenAPI';
import TuyaDevice from '../../src/device/TuyaDevice';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import TuyaProgrammeProvider, {programmeToFastWarm} from '../../src/device/schedule/TuyaProgrammeProvider';
import FastWarmScheduleManager from '../../src/device/schedule/FastWarmScheduleManager';
import {decodeFastWarmSchedule, encodeFastWarmSchedule} from '../../src/device/schedule/FastWarmSchedule';
import {initLogger} from '../../src/util/Logger';

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const programme = (leave = 16, sleep = 12) => Object.fromEntries(weekdays.map(day => [day,
  [360, 510, 1020, 1320].map((startMinute, event) => ({startMinute, targetC: event === 1 ? leave : event === 3 ? sleep : 20})),
]));
const live: {root: string; provider: TuyaProgrammeProvider}[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const fixture of live.splice(0)) {
    await fixture.provider.close(); await fs.rm(fixture.root, {recursive: true, force: true});
  }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
async function fixture(blockAuth = true) {
  initLogger({info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn()});
  const root = await fs.mkdtemp('/private/tmp/fastwarm-wire-'); await fs.mkdir(path.join(root, 'persist'), {mode: 0o700});
  const api = new TuyaOpenAPI('https://example.invalid', 'fixture-client', 'fixture-key');
  const device = {id: 'owned-wire-room', name: 'Thermostat', online: true, product_id: 'lmtejj3f4kafi2k1',
    status: [{code: 'temp_unit_convert', value: 'c'}, {code: 'temp_set', value: 200}]} as unknown as TuyaDevice;
  const native = programmeToFastWarm(programme());
  const connections = new Set<any>(); let connected = true, raw: any, controlReads = 0, blocked = false;
  const mq: any = {isConnected: () => connected, addRawMessageListener: (listener: any) => {raw = listener;},
    removeRawMessageListener: () => undefined, addConnectionListener: (listener: any) => connections.add(listener),
    removeConnectionListener: (listener: any) => connections.delete(listener)};
  const entered = deferred(), release = deferred();
  jest.spyOn(api, '_refreshAccessTokenIfNeed').mockImplementation(async route => {
    if (blockAuth && !blocked && controlReads === 1 && route.endsWith('/shadow/properties/issue')) {
      blocked = true; entered.resolve(); await release.promise;
    }
  });
  const sent: {path: string; method: string; properties?: any}[] = [];
  const emit = (packet: any) => raw('test', 4, {devId: device.id, status: [{code: 'week_program',
    value: encodeFastWarmSchedule(packet), t: Date.now()}]}, Date.now());
  const send = jest.spyOn(https, 'request').mockImplementation(((options: any, callback: any) => {
    let body = '';
    const request: any = new EventEmitter(); request.write = (chunk: string) => {body += chunk;};
    request.destroy = (error: Error) => request.emit('error', error);
    request.end = () => queueMicrotask(() => {
      const properties = body ? JSON.parse(JSON.parse(body).properties) : undefined;
      sent.push({path: options.path, method: options.method, properties});
      let result: any = {};
      if (options.method === 'get') {
        controlReads++; result = {properties: [{code: 'ControlMode', value: 'smart'}, {code: 'Event_Adaptive_Set', value: 0}]};
      } else if (properties?.inquire) {
        for (const day of native.days) emit({dayMask: day.day, events: day.events});
      } else if (properties?.week_program) {
        const packet = decodeFastWarmSchedule(properties.week_program);
        for (const day of native.days.filter(day => day.day & packet.dayMask)) {
          for (const event of packet.events) day.events[event.event] = {...event};
        }
        // Device acknowledgements can echo our first packet before its HTTP ACK.
        emit(packet);
      }
      const response: any = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => undefined;
      callback(response); response.emit('data', JSON.stringify({success: true, result, t: Date.now(), tid: 'fixture'})); response.emit('end');
    });
    return request;
  }) as typeof https.request);
  const manager: any = Object.assign(new EventEmitter(), {api, mq, devices: [device], getDevice: () => device,
    getTemperatureObservation: () => undefined});
  const schedules = new FastWarmScheduleManager(api, mq, () => device, {readTimeoutMs: 30, verificationDelayMs: 0});
  const provider = new TuyaProgrammeProvider(manager, path.join(root, 'persist'), '0123456789abcdef', schedules,
    {programmeWriteModes: [{deviceId: device.id, mode: 'grouped-events'}]});
  live.push({root, provider});
  const call = (route: string, body: object) => provider.handle(route, body as Record<string, unknown>) as Promise<any>;
  return {api, send, sent, native, entered, release,
    prepare: async (desired = programme(12)) => (await call('/provider/prepare-automatic',
      {deviceId: device.id, programme: desired, requireScheduled: true})).preview,
    apply: (token: string) => call('/provider/apply-automatic', {token}),
    edit: () => {native.days[1].events[1].temperature = 18; emit({dayMask: 2, events: [native.days[1].events[1]]});},
    gap: () => {for (const value of [false, true]) {connected = value;
      for (const listener of connections) listener({connected: value, recoveryRequired: true});}},
    offline: () => {device.online = false; manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device);
      native.days[1].events[1].temperature = 18;
      device.online = true; manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device);},
  };
}

test.each(['native edit', 'broker gap', 'device offline interval', 'lease expiry'])(
  '%s during authentication cancels the first native upload at the real HTTP dispatch boundary', async kind => {
    const data = await fixture(), preview = await data.prepare();
    const pending = data.apply(preview.token); await data.entered.promise;
    if (kind === 'native edit') data.edit();
    else if (kind === 'broker gap') data.gap();
    else if (kind === 'device offline interval') data.offline();
    else {const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now + 11000);}
    data.release.resolve();
    const result = (await pending).result;
    expect(result).toMatchObject({status: 'not-applied', writeAttempted: false});
    expect(data.sent.filter(request => request.properties?.week_program)).toHaveLength(0);
    expect(data.sent.every(request => request.method !== 'post' || request.properties?.inquire === true)).toBe(true);
    if (kind === 'native edit' || kind === 'device offline interval') expect(data.native.days[1].events[1].temperature).toBe(18);
    await expect(data.apply(preview.token)).rejects.toThrow('consumed');
    expect(data.sent.filter(request => request.properties?.week_program)).toHaveLength(0);
  });

test('our first packet echo does not invalidate subsequent packets in the same verified operation', async () => {
  const data = await fixture(false), preview = await data.prepare(programme(12, 10));
  const result = (await data.apply(preview.token)).result;
  expect(result).toMatchObject({status: 'confirmed', writeAttempted: true});
  expect(data.sent.filter(request => request.properties?.week_program)).toHaveLength(2);
  expect(data.sent).toHaveLength(6);
  expect(data.native).toEqual(programmeToFastWarm(programme(12, 10)));
});
