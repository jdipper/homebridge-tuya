/* eslint-disable @typescript-eslint/no-explicit-any */
import {createHash} from 'crypto';
import EventEmitter from 'events';
import fs from 'fs/promises';
import path from 'path';
import TuyaDevice from '../../src/device/TuyaDevice';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import TuyaProgrammeProvider, {programmeToFastWarm} from '../../src/device/schedule/TuyaProgrammeProvider';
import FastWarmScheduleManager from '../../src/device/schedule/FastWarmScheduleManager';
import {decodeFastWarmSchedule, encodeFastWarmSchedule} from '../../src/device/schedule/FastWarmSchedule';
import {FastWarmLanTransport} from '../../src/device/lan/FastWarmLanTransport';

const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const week = (targetC = 18) => Object.fromEntries(names.map(day => [day,
  [330, 510, 1020, 1320].map(startMinute => ({startMinute, targetC})),
]));
const context = {timeZone: 'Europe/London'};
const fixtures: {provider: TuyaProgrammeProvider; root: string}[] = [];
afterEach(async () => {
  for (const data of fixtures.splice(0)) {
    await data.provider.close(); await fs.rm(data.root, {recursive: true, force: true});
  }
  jest.restoreAllMocks();
});

async function fixture(options: {ignoreTarget?: boolean; unknownProgramme?: boolean; unknownTarget?: boolean;
  notSent?: boolean; staleWeek?: boolean; partialWeek?: boolean;} = {}) {
  let now = Date.parse('2026-11-17T19:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const root = await fs.mkdtemp('/private/tmp/fw-lan-integration-'), persist = path.join(root, 'persist');
  await fs.mkdir(persist, {mode: 0o700});
  const device = {id: 'local-room', name: 'Thermostat', room_name: 'Fixture Room', online: false,
    product_id: 'lmtejj3f4kafi2k1', status: [{code: 'temp_unit_convert', value: 'f'},
      {code: 'temp_current', value: 185}, {code: 'temp_set', value: 180}]} as unknown as TuyaDevice;
  const cloudRaw = new Set<any>(), cloudConnections = new Set<any>();
  const mq: any = {isConnected: () => false,
    addRawMessageListener: (fn: any) => cloudRaw.add(fn), removeRawMessageListener: (fn: any) => cloudRaw.delete(fn),
    addConnectionListener: (fn: any) => cloudConnections.add(fn), removeConnectionListener: (fn: any) => cloudConnections.delete(fn)};
  const api: any = {request: jest.fn(async () => {
    throw Error('Cloud read forbidden in LAN fixture');
  }),
  postOnce: jest.fn(async () => {
    throw Error('Cloud write forbidden in LAN fixture');
  })};
  const native = programmeToFastWarm(week());
  let target = 180, generation = 1, connected = true;
  const liveControls: Record<string, unknown> = {ControlMode: 'smart', Event_Adaptive_Set: 0, TemperUnitChange: false, power1: true};
  const rawListeners = new Set<any>(), connections = new Set<any>();
  const raw = (status: object[]) => {
    // Mirror the manager's accepted LAN status cache before the provider receives the same report.
    for (const item of status as {code: string; value: any}[]) {
      const code = {ControlMode: 'mode', Event_Adaptive_Set: 'Event_Adaptive_Set', TemperUnitChange: 'temp_unit_convert',
        power1: 'switch', SetTemp: 'temp_set'}[item.code];
      if (!code) {
        continue;
      }
      const value = item.code === 'TemperUnitChange' ? (item.value ? 'f' : 'c') : item.value;
      const previous = device.status.find(entry => entry.code === code);
      if (previous) {
        previous.value = value;
      } else {
        device.status.push({code, value});
      }
    }
    for (const fn of rawListeners) {
      fn('local', 4, {devId: device.id, status, source: 'lan'}, now);
    }
  };
  const controls = () => [
    {code: 'ControlMode', dp_id: 103, value: liveControls.ControlMode},
    {code: 'Event_Adaptive_Set', dp_id: 110, value: liveControls.Event_Adaptive_Set},
    {code: 'SetTemp', dp_id: 102, value: target},
    {code: 'TemperUnitChange', dp_id: 107, value: liveControls.TemperUnitChange},
    {code: 'power1', dp_id: 101, value: liveControls.power1},
  ];
  const lan = {
    has: (id: string) => id === device.id,
    isConnected: () => connected, generation: () => generation,
    addRawMessageListener: (fn: any) => rawListeners.add(fn), removeRawMessageListener: (fn: any) => rawListeners.delete(fn),
    addConnectionListener: (fn: any) => connections.add(fn), removeConnectionListener: (fn: any) => connections.delete(fn),
    close: jest.fn(),
    readProperties: jest.fn(async () => {
      const properties = controls(); raw(properties); return {properties, receivedAt: now, generation};
    }),
    readSchedule: jest.fn(async () => {
      for (const day of native.days) {
        raw([{code: 'week_program', dp_id: 119,
          value: encodeFastWarmSchedule({dayMask: day.day, events: day.events})}]);
      }
      const state = structuredClone(native);
      if (options.partialWeek) {
        state.days[6].events.pop(); state.days[6].complete = false; state.complete = false; state.missing = [{day: 64, event: 3}];
      }
      const at = options.staleWeek ? now - 60000 : now;
      return {startedAt: at, finishedAt: at, state, timedOut: false, errors: [],
        fingerprint: createHash('sha256').update(JSON.stringify(state.days.map(day => [day.day, day.events]))).digest('hex')};
    }),
    issueOnce: jest.fn(async (_id: string, properties: any, command: any) => {
      if (command?.shouldProceed?.() === false || options.notSent) {
        throw Object.assign(Error('Native dispatch blocked'), {writeAttempted: false});
      }
      if (typeof properties.week_program === 'string') {
        const packet = decodeFastWarmSchedule(properties.week_program);
        for (const day of native.days.filter(item => item.day & packet.dayMask)) {
          for (const event of packet.events) {
            day.events[event.event] = {...event};
          }
        }
        raw([{code: 'week_program', dp_id: 119, value: properties.week_program}]);
        if (options.unknownProgramme) {
          throw Object.assign(Error('LAN socket lost after send'), {writeAttempted: true});
        }
      } else if (typeof properties.SetTemp === 'number') {
        if (!options.ignoreTarget) {
          target = properties.SetTemp; raw([{code: 'SetTemp', dp_id: 102, value: target}]);
        }
        if (options.unknownTarget) {
          throw Object.assign(Error('LAN target reply lost'), {writeAttempted: true});
        }
      } else {
        throw Error('Unexpected native control');
      }
    }),
  };
  const manager: any = Object.assign(new EventEmitter(), {devices: [device], api, mq, fastWarmLan: lan,
    getDevice: (id: string) => id === device.id ? device : undefined,
    getTemperatureObservation: () => ({value: 185, receivedAt: now, source: 'lan'})});
  const schedules = new FastWarmScheduleManager(api, mq, () => device,
    {localTransport: lan as FastWarmLanTransport, writeIntervalMs: 0, verificationDelayMs: 0, readTimeoutMs: 50});
  const provider = new TuyaProgrammeProvider(manager as TuyaDeviceManager, persist, '0123456789abcdef', schedules,
    {programmeWriteModes: [{deviceId: device.id, mode: 'grouped-events'}]});
  jest.spyOn(provider as any, 'targetWait').mockImplementation(async (_id, ms) => {
    now += Number(ms);
  });
  fixtures.push({provider, root});
  const call = (route: string, body: object = {}) => provider.handle(route, body as Record<string, unknown>) as Promise<any>;
  const prepare = async (desired = week(19), activeTarget = false) => (await call('/provider/prepare-automatic',
    {deviceId: device.id, programme: desired, requireScheduled: true, ...(activeTarget ? {activeTarget: context} : {})})).preview;
  return {root, provider, schedules, manager, device, lan, api, call, prepare, native: () => native,
    localControls: (changes: Record<string, unknown>) => {
      now++;
      Object.assign(liveControls, changes);
      const dps = {ControlMode: 103, Event_Adaptive_Set: 110, TemperUnitChange: 107, power1: 101};
      raw(Object.entries(changes).map(([code, value]) => ({code, value, dp_id: dps[code]})));
    },
    cloudEvent: () => {
      for (const fn of cloudConnections) {
        fn({connected: false, recoveryRequired: true});
      }
      for (const fn of cloudRaw) {
        fn('cloud', 4, {devId: device.id, status: [{code: 'ControlMode', value: 'hold'},
          {code: 'SetTemp', value: 250}, {code: 'week_program', value: encodeFastWarmSchedule({dayMask: 1,
            events: [{event: 1, hour: 8, minute: 30, temperature: 25}]})}]}, now);
      }
      manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device);
    },
    localConnection: (value: boolean) => {
      connected = value; generation++;
      for (const fn of connections) {
        fn({deviceId: device.id, connected, generation});
      }
    },
  };
}

test('LAN programme and coherent controls remain available with cloud offline and stale cloud units', async () => {
  const data = await fixture();
  const reply = await data.call('/provider/read', {deviceId: data.device.id});
  expect(reply.zone).toMatchObject({online: true, measuredC: 18.5, targetC: 18, scheduled: true,
    programme: week(), programmeWriteMode: 'single-events', temperatureSource: 'lan'});
  expect(data.api.request).not.toHaveBeenCalled(); expect(data.api.postOnce).not.toHaveBeenCalled();
});

test.each([
  {changes: {ControlMode: 'hold'}, expected: {mode: 'hold', scheduled: false}},
  {changes: {Event_Adaptive_Set: 1}, expected: {mode: 'smart', scheduled: false}},
  {changes: {TemperUnitChange: true}, expected: {measuredC: null, targetC: null}},
])('accepted local control changes supersede a cached settings read without manufacturing fresh target proof: %o', async entry => {
  const data = await fixture();
  const before = (await data.call('/provider/read', {deviceId: data.device.id})).zone;
  expect(before).toMatchObject({mode: 'smart', scheduled: true, targetC: 18, targetReadAt: expect.any(Number)});
  const reads = data.lan.readProperties.mock.calls.length;
  data.localControls(entry.changes);
  const after = (await data.call('/provider/list')).zones[0];
  expect(after).toMatchObject(entry.expected);
  expect(after).not.toHaveProperty('targetReadAt');
  expect(data.lan.readProperties).toHaveBeenCalledTimes(reads);
  expect(data.lan.issueOnce).not.toHaveBeenCalled();
  expect(data.api.request).not.toHaveBeenCalled(); expect(data.api.postOnce).not.toHaveBeenCalled();
});

test('an accepted local power change invalidates the old verified target without manufacturing a replacement read', async () => {
  const data = await fixture();
  await data.call('/provider/read', {deviceId: data.device.id});
  expect((await data.call('/provider/list')).zones[0]).toHaveProperty('targetReadAt');
  const reads = data.lan.readProperties.mock.calls.length;
  data.localControls({power1: false});
  expect((await data.call('/provider/list')).zones[0]).not.toHaveProperty('targetReadAt');
  expect(data.device.status.find(item => item.code === 'switch')?.value).toBe(false);
  expect(data.lan.readProperties).toHaveBeenCalledTimes(reads);
  expect(data.lan.issueOnce).not.toHaveBeenCalled(); expect(data.api.postOnce).not.toHaveBeenCalled();
});

test('LAN automatic changes force single-event packets while preserving complete-week proof and durable backups', async () => {
  const data = await fixture(), desired = week(); desired.sunday[1].targetC = 18.5;
  const preview = await data.prepare(desired);
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', writeAttempted: true, readback: {programme: desired}});
  const writes = data.lan.issueOnce.mock.calls.filter(call => call[1].week_program);
  expect(writes).toHaveLength(1); expect(decodeFastWarmSchedule(writes[0][1].week_program)).toEqual({dayMask: 64,
    events: [{event: 1, hour: 8, minute: 30, temperature: 18.5}]});
  const directory = path.join(data.root, 'heating-operations/tuya-0123456789abcdef');
  const [name] = await fs.readdir(directory);
  expect(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')))
    .toMatchObject({state: 'finished', backup: {state: programmeToFastWarm(week())}});
  expect(data.api.request).not.toHaveBeenCalled(); expect(data.api.postOnce).not.toHaveBeenCalled();
});

test('same-value untimestamped LAN status reports and cloud connection changes do not invalidate an owned local baseline', async () => {
  const data = await fixture(), preview = await data.prepare(week(), true);
  data.cloudEvent();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'confirmed', writeAttempted: false, readback: {targetC: 18}});
  expect(data.lan.issueOnce).not.toHaveBeenCalled(); expect(data.api.request).not.toHaveBeenCalled();
});

test('LAN active target alignment uses one native command and a fresh local status proof with no cloud fallback', async () => {
  const data = await fixture(), preview = await data.prepare(week(19), true);
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', writeAttempted: true,
    readback: {programme: week(19), targetC: 19, mode: 'smart', targetReadAt: expect.any(Number)}});
  expect(data.lan.issueOnce.mock.calls.filter(call => call[1].SetTemp)).toHaveLength(1);
  expect(data.api.request).not.toHaveBeenCalled(); expect(data.api.postOnce).not.toHaveBeenCalled();
});

test.each([{ignoreTarget: true}, {unknownTarget: true}])('unconfirmed LAN targets are never replayed: %o', async options => {
  const data = await fixture(options), preview = await data.prepare(week(19), true);
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'unknown', writeAttempted: true});
  expect(data.lan.issueOnce.mock.calls.filter(call => call[1].SetTemp)).toHaveLength(1);
  expect(data.api.postOnce).not.toHaveBeenCalled();
});

test.each([{staleWeek: true}, {partialWeek: true}])('incomplete or stale LAN baselines are rejected: %o', async options => {
  const data = await fixture(options);
  await expect(data.prepare()).rejects.toThrow('complete fresh');
  expect(data.lan.issueOnce).not.toHaveBeenCalled(); expect(data.api.request).not.toHaveBeenCalled();
});

test('local connection generations invalidate the owned baseline independently of cloud availability', async () => {
  const data = await fixture(), preview = await data.prepare();
  data.localConnection(false); data.localConnection(true);
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.lan.issueOnce).not.toHaveBeenCalled(); expect(data.api.postOnce).not.toHaveBeenCalled();
});

test('an uncertain local programme dispatch is never replayed or sent through cloud', async () => {
  const data = await fixture({unknownProgramme: true}), preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'unknown', writeAttempted: true});
  expect(data.lan.issueOnce.mock.calls.filter(call => call[1].week_program)).toHaveLength(1);
  expect(data.api.postOnce).not.toHaveBeenCalled();
});

test('a known local pre-dispatch rejection reports no write attempt and never falls back', async () => {
  const data = await fixture({notSent: true}), preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'not-applied', writeAttempted: false});
  expect(data.lan.issueOnce).toHaveBeenCalledTimes(1); expect(data.api.postOnce).not.toHaveBeenCalled();
});

test.each([true, false])('cloud groups are disabled only when a member selects LAN: mixed=%s', async mixed => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'], raw = new Set<any>();
  const mq: any = {isConnected: () => true, addRawMessageListener: (fn: any) => raw.add(fn),
    removeRawMessageListener: (fn: any) => raw.delete(fn),
    addConnectionListener: jest.fn(), removeConnectionListener: jest.fn()};
  const api: any = {request: jest.fn(async (_method: string, route: string) => ({success: true,
    result: route.endsWith('/devices') ? {page_no: 1, page_size: 20, count: 6,
      data_list: ids.map(device_id => ({group_id: '123', device_id}))}
      : [{code: 'inquire', type: 'bool'}, {code: 'week_program', type: 'raw', type_desc: '{"maxlen":128}'}]})),
  postOnce: jest.fn(async () => ({success: true, result: {result: true}}))};
  const local: any = {has: (id: string) => mixed && id === 'a', isConnected: () => true,
    addRawMessageListener: jest.fn(), removeRawMessageListener: jest.fn(), addConnectionListener: jest.fn(),
    removeConnectionListener: jest.fn(), issueOnce: jest.fn(async () => undefined)};
  const devices = ids.map(id => new TuyaDevice({id, product_id: 'lmtejj3f4kafi2k1', online: true,
    schema: [], status: [{code: 'temp_unit_convert', value: 'c'}]}));
  const schedules = new FastWarmScheduleManager(api, mq, id => devices.find(device => device.id === id),
    {localTransport: local, programmeGroups: [{groupId: '123', deviceIds: ids}]});
  try {
    await Promise.all(ids.map(id => (schedules as any).issue(id, {inquire: true}, undefined, true)));
    if (mixed) {
      expect(api.postOnce).toHaveBeenCalledTimes(5); expect(local.issueOnce).toHaveBeenCalledTimes(1);
      expect(api.postOnce.mock.calls.every((call: any[]) => !call[0].includes('/group/'))).toBe(true);
      expect(api.request).not.toHaveBeenCalled();
    } else {
      expect(api.postOnce).toHaveBeenCalledTimes(1); expect(api.postOnce.mock.calls[0][0]).toContain('/group/123/properties');
      expect(local.issueOnce).not.toHaveBeenCalled();
    }
  } finally {
    schedules.close();
  }
});
