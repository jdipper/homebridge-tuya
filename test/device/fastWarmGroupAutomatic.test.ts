/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs/promises';
import path from 'path';
import EventEmitter from 'events';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import TuyaProgrammeProvider, { programmeToFastWarm } from '../../src/device/schedule/TuyaProgrammeProvider';
import FastWarmScheduleManager from '../../src/device/schedule/FastWarmScheduleManager';
import FastWarmGroupCommandBroker, { FastWarmGroupCommandRejected } from '../../src/device/schedule/FastWarmGroupCommandBroker';
import { decodeFastWarmSchedule, encodeFastWarmSchedule } from '../../src/device/schedule/FastWarmSchedule';
import { classifyTuyaRequest } from '../../src/util/TuyaApiUsage';

const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ids = Array.from({length: 6}, (_, index) => 'group-room-' + index);
const group = {groupId: '1234567890123456789', deviceIds: ids};
const week = (leave = 16) => Object.fromEntries(names.map(day => [day,
  [360, 510, 1020, 1320].map((startMinute, event) => ({startMinute, targetC: event === 1 ? leave : event === 3 ? 12 : 20})),
]));
const fixtures: {provider: TuyaProgrammeProvider; root: string}[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const data of fixtures.splice(0)) {
    await data.provider.close(); await fs.rm(data.root, {recursive: true, force: true});
  }
});

async function fixture(options: {partialInquiry?: string; groupAck?: unknown; networkWriteError?: boolean} = {}) {
  const root = await fs.mkdtemp('/private/tmp/fastwarm-group-');
  const persist = path.join(root, 'persist'); await fs.mkdir(persist, {mode: 0o700});
  const devices = ids.map(id => ({id, name: id, online: true, product_id: 'lmtejj3f4kafi2k1', status: [
    {code: 'temp_unit_convert', value: 'c'}, {code: 'temp_current', value: 180}, {code: 'temp_set', value: 200},
  ]}));
  const native = new Map(ids.map(id => [id, programmeToFastWarm(week())]));
  const listeners = new Set<any>();
  const listener = (...args: any[]) => {for (const value of listeners) value(...args);};
  let connected = true, controlsHook: ((id: string) => void) | undefined;
  let members: any = {page_no: 1, page_size: 20, count: 6,
    data_list: ids.map(device_id => ({device_id, group_id: group.groupId}))};
  let schema: any = [{code: 'inquire', type: 'bool'}, {code: 'week_program', type: 'raw', type_desc: '{"maxlen":128}'}];
  let metadataHook: (() => void) | undefined, postAuthHook: (() => void) | undefined;
  const calls: {kind: string; id?: string; properties?: any}[] = [];
  const emit = (id: string) => {
    for (const day of native.get(id)!.days) listener('test', 4, {devId: id, status: [{code: 'week_program',
      value: encodeFastWarmSchedule({dayMask: day.day, events: day.events}), t: Date.now()}]}, Date.now());
  };
  const write = (id: string, raw: string) => {
    const packet = decodeFastWarmSchedule(raw);
    for (const day of native.get(id)!.days.filter(day => day.day & packet.dayMask)) {
      for (const event of packet.events) day.events[event.event] = {...event};
    }
  };
  const connections = new Set<any>();
  const mq: any = {addRawMessageListener: (value: any) => listeners.add(value), removeRawMessageListener: (value: any) => listeners.delete(value),
    addConnectionListener: (value: any) => connections.add(value), removeConnectionListener: (value: any) => connections.delete(value),
    isConnected: () => connected};
  const api: any = {
    request: jest.fn(async (_method: string, route: string, params: any, _body: any, requestOptions: any) => {
      expect(requestOptions).toMatchObject({attempts: 1});
      if (route.endsWith('/devices')) {calls.push({kind: 'members'}); metadataHook?.(); return {success: true, result: members};}
      if (route === `/v2.1/cloud/thing/group/${group.groupId}/properties`) {
        calls.push({kind: 'schema'}); return {success: true, result: schema};
      }
      const id = route.split('/')[4]; calls.push({kind: 'controls', id}); controlsHook?.(id);
      expect(params.codes).toBe('ControlMode,Event_Adaptive_Set,SetTemp');
      return {success: true, result: {properties: [{code: 'ControlMode', value: 'smart'}, {code: 'Event_Adaptive_Set', value: 0}]}};
    }),
    postOnce: jest.fn(async (route: string, body: any, requestOptions: any) => {
      if (requestOptions.shouldProceed?.() === false) return {success: false, code: 'cancelled'};
      postAuthHook?.();
      if (requestOptions.shouldProceed?.() === false) return {success: false, code: 'cancelled'};
      const properties = JSON.parse(body.properties), grouped = route.includes('/group/');
      const id = grouped ? undefined : route.split('/')[4];
      calls.push({kind: (grouped ? 'group-' : '') + (properties.inquire ? 'inquiry' : 'write'), id, properties});
      const recipients = grouped ? ids : [id!];
      if (properties.inquire) {
        for (const target of recipients) if (target !== options.partialInquiry) emit(target);
      } else {
        const journals = await fs.readdir(path.join(root, 'heating-operations', 'tuya-0123456789abcdef'));
        expect(journals.length).toBeGreaterThanOrEqual(recipients.length);
        for (const target of recipients) write(target, properties.week_program);
        if (grouped && options.networkWriteError) throw new Error('Unknown group network outcome');
      }
      return grouped && !properties.inquire && options.groupAck !== undefined ? options.groupAck
        : {success: true, result: grouped ? {result: true} : {}};
    }),
  };
  const manager: any = Object.assign(new EventEmitter(), {api, mq, devices, getDevice: (id: string) => devices.find(device => device.id === id),
    getTemperatureObservation: () => undefined});
  const schedules = new FastWarmScheduleManager(api, mq, id => manager.getDevice(id),
    {readTimeoutMs: 1500, verificationDelayMs: 0, programmeGroups: [group]});
  const provider = new TuyaProgrammeProvider(manager, persist, '0123456789abcdef', schedules,
    {programmeWriteModes: ids.map(deviceId => ({deviceId, mode: 'grouped-events'})), programmeGroups: [group]});
  fixtures.push({provider, root});
  const call = (route: string, body: object) => provider.handle(route, body as Record<string, unknown>) as Promise<any>;
  const prepare = (selected = ids, desired = (_id: string) => week(12)) => Promise.all(selected.map(deviceId => call('/provider/prepare-automatic',
    {deviceId, programme: desired(deviceId), requireScheduled: true}).then(value => value.preview)));
  const apply = (previews: any[]) => Promise.all(previews.map(value => call('/provider/apply-automatic', {token: value.token}).then(value => value.result)));
  return {provider, schedules, api, calls, native, devices, call, prepare, apply,
    members: (value: any) => {members = value;}, schema: (value: any) => {schema = value;},
    onMetadata: (hook: () => void) => {metadataHook = hook;}, onControls: (hook: (id: string) => void) => {controlsHook = hook;},
    onPostAuth: (hook: () => void) => {postAuthHook = hook;},
    info: (id: string) => manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, devices.find(value => value.id === id)),
    connection: (value: boolean, recoveryRequired = true) => {connected = value;
      for (const callback of connections) callback({connected: value, recoveryRequired});}};
}

test('six owned automatic operations use three group commands and 19 cold calls, with six independently complete readbacks', async () => {
  const data = await fixture(), prepared = await data.prepare(), results = await data.apply(prepared);
  expect(results).toHaveLength(6);
  for (const result of results) expect(result).toMatchObject({status: 'confirmed', writeAttempted: true,
    readback: {programme: week(12), scheduled: true}});
  expect(data.calls).toHaveLength(19);
  expect(data.calls.filter(call => call.kind === 'group-write')).toHaveLength(1);
  expect(data.calls.filter(call => call.kind === 'group-inquiry')).toHaveLength(2);
  expect(data.calls.filter(call => call.kind === 'members')).toHaveLength(3);
  expect(data.calls.filter(call => call.kind === 'schema')).toHaveLength(1);
  expect(data.calls.some(call => call.properties?.ControlMode || call.properties?.switch !== undefined)).toBe(false);
});

test('cancelling a grouped cohort during authentication stops the group packet without individual-write fallback', async () => {
  const data = await fixture(), prepared = await data.prepare();
  data.onPostAuth(() => {for (const preview of prepared) void data.call('/provider/cancel-automatic', {token: preview.token});});
  const results = await data.apply(prepared);
  expect(results.every(result => result.status === 'not-applied' && !result.writeAttempted && result.superseded === true)).toBe(true);
  expect(data.calls.some(call => call.kind === 'group-write' || call.kind === 'write')).toBe(false);
  for (const native of data.native.values()) expect(native).toEqual(programmeToFastWarm(week()));
});

test('an ambiguous group network failure cannot become known supersession when a newer intent arrives', async () => {
  const data = await fixture({networkWriteError: true}), prepared = await data.prepare();
  const original = data.api.postOnce.getMockImplementation()!;
  data.api.postOnce.mockImplementation(async (...args: any[]) => {
    try {return await original(...args);}
    finally {
      if (JSON.parse(args[1].properties).week_program) {
        await Promise.all(prepared.map(preview => data.call('/provider/cancel-automatic', {token: preview.token})));
      }
    }
  });
  const results = await data.apply(prepared);
  expect(results.every(result => result.status === 'unknown' && result.writeAttempted && result.superseded !== true)).toBe(true);
  expect(data.calls.filter(call => call.kind === 'group-write')).toHaveLength(1);
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
});

test('an incomplete five-room cohort times out into individual operations before any group dispatch', async () => {
  const data = await fixture(), results = await data.apply(await data.prepare(ids.slice(0, 5)));
  expect(results.every(result => result.status === 'confirmed')).toBe(true);
  expect(data.calls).toHaveLength(25);
  expect(data.calls.some(call => call.kind.startsWith('group-') || call.kind === 'members' || call.kind === 'schema')).toBe(false);
});

test('different ready write payloads use individual writes while automatic inquiries still group', async () => {
  const data = await fixture(), prepared = await data.prepare(ids, id => week(id === ids[0] ? 12.5 : 12));
  expect((await data.apply(prepared)).every(result => result.status === 'confirmed')).toBe(true);
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(6);
  expect(data.calls.some(call => call.kind === 'group-write')).toBe(false);
  expect(data.calls.filter(call => call.kind === 'group-inquiry')).toHaveLength(2);
  expect(data.calls).toHaveLength(23);
});

test('manual read operations never join an automatic group inquiry', async () => {
  const data = await fixture();
  const result = await Promise.all(ids.map(deviceId => data.call('/provider/read', {deviceId})));
  expect(result.every(value => value.zone.fingerprint)).toBe(true);
  expect(data.calls.filter(call => call.kind === 'inquiry')).toHaveLength(6);
  expect(data.calls.some(call => call.kind.startsWith('group-'))).toBe(false);
});

test.each(['extra', 'duplicate', 'incomplete', 'wrong-group'])('unsafe %s membership blocks every grouped write', async form => {
  const data = await fixture(), prepared = await data.prepare();
  const members = {page_no: 1, page_size: 20, count: 6,
    data_list: ids.map(device_id => ({device_id, group_id: group.groupId}))};
  if (form === 'extra') members.data_list[0].device_id = 'unrequested-room';
  if (form === 'duplicate') members.data_list[0].device_id = ids[1];
  if (form === 'incomplete') members.count = 7;
  if (form === 'wrong-group') members.data_list[0].group_id = '99';
  data.members(members);
  expect((await data.apply(prepared)).every(value => value.status !== 'confirmed' && value.writeAttempted === false)).toBe(true);
  expect(data.calls.some(value => value.kind.includes('write'))).toBe(false);
  expect([...data.native.values()].every(value => JSON.stringify(value) === JSON.stringify(programmeToFastWarm(week())))).toBe(true);
});

test('missing/invalid newly refreshed group schema blocks group mutation without individual replay', async () => {
  const data = await fixture(), prepared = await data.prepare(); data.schema([{code: 'week_program', type: 'raw', type_desc: '{"maxlen":1}'}]);
  data.schedules.invalidateGroupCapabilities(ids[0]);
  expect((await data.apply(prepared)).every(value => value.status !== 'confirmed' && !value.writeAttempted)).toBe(true);
  expect(data.calls.some(value => value.kind.includes('write'))).toBe(false);
});

test('every member guard is rechecked after group metadata and after authentication', async () => {
  const data = await fixture(), prepared = await data.prepare();
  data.onPostAuth(() => {data.devices[5].online = false;});
  const result = await data.apply(prepared);
  expect(result.every(value => value.status !== 'confirmed')).toBe(true);
  expect(data.calls.some(value => value.kind.includes('write'))).toBe(false);
});

test('one offline member during group validation prevents the write for all members', async () => {
  const data = await fixture(), prepared = await data.prepare(); data.onMetadata(() => {data.devices[2].online = false;});
  expect((await data.apply(prepared)).every(value => value.status !== 'confirmed')).toBe(true);
  expect(data.calls.some(value => value.kind.includes('write'))).toBe(false);
});

test('a metadata network failure occurs before any group write and cannot become an individual replay', async () => {
  const data = await fixture(), prepared = await data.prepare();
  data.onMetadata(() => {throw new Error('metadata network failure');});
  expect((await data.apply(prepared)).every(value => value.status !== 'confirmed' && !value.writeAttempted)).toBe(true);
  expect(data.calls.some(value => value.kind.includes('write'))).toBe(false);
});

test('one invalidated owned baseline after authentication blocks the shared command for all six', async () => {
  const data = await fixture(), prepared = await data.prepare();
  data.onPostAuth(() => data.schedules.invalidateAutomatic(ids[5]));
  expect((await data.apply(prepared)).every(value => value.status !== 'confirmed')).toBe(true);
  expect(data.calls.some(value => value.kind.includes('write'))).toBe(false);
});

test.each([{success: false}, {success: true, result: {result: false}}, {success: true, result: {}}])(
  'failed group acknowledgement is ambiguous and is never individually replayed: %j', async groupAck => {
    const data = await fixture({groupAck}), prepared = await data.prepare(), results = await data.apply(prepared);
    expect(results.every(result => result.status === 'unknown' && result.writeAttempted)).toBe(true);
    expect(data.calls.filter(value => value.kind === 'group-write')).toHaveLength(1);
    expect(data.calls.filter(value => value.kind === 'write')).toHaveLength(0);
  },
);

test('an ambiguous group network failure is not replayed even when readback matches', async () => {
  const data = await fixture({networkWriteError: true}), prepared = await data.prepare(), results = await data.apply(prepared);
  expect(results.every(result => result.status === 'unknown' && result.writeAttempted)).toBe(true);
  expect(data.calls.filter(value => value.kind === 'group-write')).toHaveLength(1);
  expect(data.calls.filter(value => value.kind === 'write')).toHaveLength(0);
});

test('a group inquiry missing one member cannot establish that member baseline or enable a write', async () => {
  const data = await fixture({partialInquiry: ids[3]});
  const results = await Promise.allSettled(ids.map(deviceId => data.call('/provider/prepare-automatic',
    {deviceId, programme: week(12), requireScheduled: true})));
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(5);
  expect(results[3].status).toBe('rejected');
  expect(data.calls.some(value => value.kind.includes('write'))).toBe(false);
});

test('hardware-unvalidated complete-day packets stay on individual routes', async () => {
  const api: any = {request: jest.fn(), postOnce: jest.fn()}, broker = new FastWarmGroupCommandBroker(api, [group]);
  const individual = jest.fn(async () => undefined);
  const raw = encodeFastWarmSchedule({dayMask: 127, events: programmeToFastWarm(week()).days[0].events});
  await Promise.all(ids.map(id => broker.send(id, {week_program: raw}, () => true, individual)));
  expect(individual).toHaveBeenCalledTimes(6); expect(api.postOnce).not.toHaveBeenCalled(); broker.close();
});

test('close cancels a partial waiting cohort without sending an individual command', async () => {
  const api: any = {request: jest.fn(), postOnce: jest.fn()}, broker = new FastWarmGroupCommandBroker(api, [group]);
  const individual = jest.fn(async () => undefined), pending = broker.send(ids[0], {inquire: true}, () => true, individual);
  broker.close(); await expect(pending).rejects.toThrow('closed'); expect(individual).not.toHaveBeenCalled();
});

test('changed owned guards abort fallback before an individual dispatch', async () => {
  const api: any = {request: jest.fn(), postOnce: jest.fn()}, broker = new FastWarmGroupCommandBroker(api, [group], 100, 1);
  const individual = jest.fn(async () => undefined);
  await expect(broker.send(ids[0], {inquire: true}, () => false, individual)).rejects.toBeInstanceOf(FastWarmGroupCommandRejected);
  expect(individual).not.toHaveBeenCalled(); broker.close();
});

test('group programme calls are metered as programme attempts without storing group identifiers', () => {
  expect(classifyTuyaRequest('post', `/v2.1/cloud/thing/group/${group.groupId}/properties`, null,
    {properties: '{"week_program":"test"}'})).toBe('programme');
  expect(classifyTuyaRequest('post', `/v2.1/cloud/thing/group/${group.groupId}/properties`, null,
    {properties: '{"inquire":true}'})).toBe('control');
  expect(classifyTuyaRequest('post', `/v2.1/cloud/thing/group/${group.groupId}/properties/extra`, null,
    {properties: '{"week_program":"test"}'})).toBe('control');
});

test('a subsequent common programme uses 18 warm calls and still checks membership before all three group posts', async () => {
  const data = await fixture();
  expect((await data.apply(await data.prepare())).every(value => value.status === 'confirmed')).toBe(true);
  const before = data.calls.length;
  expect((await data.apply(await data.prepare(ids, () => week(16)))).every(value => value.status === 'confirmed')).toBe(true);
  const next = data.calls.slice(before);
  expect(next).toHaveLength(18); expect(next.filter(value => value.kind === 'members')).toHaveLength(3);
  expect(next.filter(value => value.kind === 'controls')).toHaveLength(12);
  expect(next.filter(value => value.kind === 'schema')).toHaveLength(0);
});

test('subsequent differing programmes use 22 warm calls with all individual controls and complete readbacks retained', async () => {
  const data = await fixture();
  expect((await data.apply(await data.prepare(ids, id => week(id === ids[0] ? 12.5 : 12)))).every(value => value.status === 'confirmed')).toBe(true);
  const before = data.calls.length;
  expect((await data.apply(await data.prepare(ids, id => week(18 + ids.indexOf(id) / 2)))).every(value => value.status === 'confirmed')).toBe(true);
  const next = data.calls.slice(before);
  expect(next).toHaveLength(22); expect(next.filter(value => value.kind === 'members')).toHaveLength(2);
  expect(next.filter(value => value.kind === 'controls')).toHaveLength(12);
  expect(next.filter(value => value.kind === 'write')).toHaveLength(6);
  expect(next.filter(value => value.kind === 'schema')).toHaveLength(0);
});

test.each(['unexpected gap', 'availability', 'device info'])('%s resets cached capabilities before the next automatic selection', async kind => {
  const data = await fixture(); await data.apply(await data.prepare());
  if (kind === 'unexpected gap') {data.connection(false); data.connection(true);}
  else if (kind === 'availability') data.schedules.invalidateAutomatic(ids[0]);
  else data.info(ids[0]);
  const before = data.calls.length;
  expect((await data.apply(await data.prepare(ids, () => week(16)))).every(value => value.status === 'confirmed')).toBe(true);
  expect(data.calls.slice(before).filter(value => value.kind === 'schema')).toHaveLength(1);
});

test('a short planned credential rotation retains stable capabilities while preserving fresh native controls', async () => {
  const data = await fixture(); await data.apply(await data.prepare()); data.connection(true, false);
  const before = data.calls.length;
  expect((await data.apply(await data.prepare(ids, () => week(16)))).every(value => value.status === 'confirmed')).toBe(true);
  const next = data.calls.slice(before);
  expect(next).toHaveLength(18); expect(next.filter(value => value.kind === 'controls')).toHaveLength(12);
});
