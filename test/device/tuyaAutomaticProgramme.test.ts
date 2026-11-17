/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs/promises';
import path from 'path';
import EventEmitter from 'events';
import TuyaDevice from '../../src/device/TuyaDevice';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import TuyaProgrammeProvider, { programmeToFastWarm } from '../../src/device/schedule/TuyaProgrammeProvider';
import FastWarmScheduleManager from '../../src/device/schedule/FastWarmScheduleManager';
import { decodeFastWarmSchedule, encodeFastWarmSchedule } from '../../src/device/schedule/FastWarmSchedule';

const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const week = (leave = 16) => Object.fromEntries(days.map(day => [day,
  [360, 510, 1020, 1320].map((startMinute, event) => ({startMinute, targetC: event === 1 ? leave : event === 3 ? 12 : 20})),
]));
const fixtures: {provider: TuyaProgrammeProvider; root: string}[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const data of fixtures.splice(0)) {
    await data.provider.close();
    await fs.rm(data.root, {recursive: true, force: true});
  }
});

async function fixture(options: {unknownWrite?: boolean; partial?: boolean} = {}) {
  const root = await fs.mkdtemp('/private/tmp/fastwarm-owned-');
  const persist = path.join(root, 'persist'); await fs.mkdir(persist, {mode: 0o700});
  const device = {id: 'test-owned-room', name: 'Thermostat', online: true, product_id: 'lmtejj3f4kafi2k1',
    status: [{code: 'temp_unit_convert', value: 'c'}, {code: 'temp_current', value: 180}, {code: 'temp_set', value: 200}]} as unknown as TuyaDevice;
  let native = programmeToFastWarm(week()), mode = 'smart', grouping = 0, connected = true;
  let raw: any;
  const connections = new Set<any>();
  const mq: any = {addRawMessageListener: (listener: any) => {raw = listener;}, removeRawMessageListener: () => undefined,
    addConnectionListener: (listener: any) => connections.add(listener), removeConnectionListener: (listener: any) => connections.delete(listener),
    isConnected: () => connected};
  const calls: {kind: string; properties?: any}[] = [];
  let controlsHook: (() => void) | undefined;
  const journals = () => path.join(root, 'heating-operations', 'tuya-0123456789abcdef');
  let persistedBeforeWrite: any;
  const api: any = {
    request: jest.fn(async () => {
      calls.push({kind: 'controls'}); controlsHook?.();
      return {success: true, result: {properties: [{code: 'ControlMode', value: mode}, {code: 'Event_Adaptive_Set', value: grouping}]}};
    }),
    postOnce: jest.fn(async (_route: string, body: any) => {
      const properties = JSON.parse(body.properties); calls.push({kind: properties.inquire ? 'inquiry' : 'write', properties});
      if (properties.inquire) {
        for (const day of options.partial ? native.days.slice(0, 1) : native.days) {
          raw('test', 4, {devId: device.id, status: [{code: 'week_program',
            value: encodeFastWarmSchedule({dayMask: day.day, events: day.events}), t: Date.now()}]}, Date.now());
        }
      } else if (properties.week_program) {
        const [name] = await fs.readdir(journals());
        persistedBeforeWrite = JSON.parse(await fs.readFile(path.join(journals(), name), 'utf8'));
        const packet = decodeFastWarmSchedule(properties.week_program);
        for (const day of native.days.filter(day => day.day & packet.dayMask)) {
          for (const event of packet.events) day.events[event.event] = {...event};
        }
        if (options.unknownWrite) throw new Error('request timed out after dispatch');
      }
      return {success: true, result: {}};
    }),
  };
  const manager: any = Object.assign(new EventEmitter(), {api, mq, devices: [device], getDevice: () => device,
    getTemperatureObservation: () => undefined});
  const schedules = new FastWarmScheduleManager(api, mq, () => device, {readTimeoutMs: 10, verificationDelayMs: 0});
  const provider = new TuyaProgrammeProvider(manager as TuyaDeviceManager, persist, '0123456789abcdef', schedules,
    {programmeWriteModes: [{deviceId: device.id, mode: 'grouped-events'}]});
  fixtures.push({provider, root});
  const call = (route: string, body: object = {}) => provider.handle(route, body as Record<string, unknown>) as Promise<any>;
  const prepare = async (desired = week(12)) => (await call('/provider/prepare-automatic',
    {deviceId: device.id, programme: desired, requireScheduled: true})).preview;
  return {root, persist, provider, schedules, api, calls, call, prepare, device, journals,
    native: () => native, persistedBeforeWrite: () => persistedBeforeWrite,
    mode: (value: string) => {mode = value;}, grouping: (value: number) => {grouping = value;},
    onControls: (hook: () => void) => {controlsHook = hook;},
    emitEdit: (reportedAt = Date.now()) => {
      native.days[1].events[3].temperature = 12.5;
      raw('test', 4, {devId: device.id, status: [{code: 'week_program', value: encodeFastWarmSchedule({dayMask: 2,
        events: [native.days[1].events[3]]}), t: reportedAt}]}, reportedAt);
    },
    availability: (value: boolean) => {
      device.online = value; manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device);
    },
    connection: (value: boolean) => {connected = value; for (const listener of connections) listener({connected: value, recoveryRequired: !value});},
  };
}

test('owned automatic one-packet selection costs five requests and persists the full backup before its sole write', async () => {
  const data = await fixture(), preview = await data.prepare();
  expect(data.calls.map(call => call.kind)).toEqual(['inquiry']);
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', writeAttempted: true, readback: {programme: week(12), scheduled: true}});
  expect(data.calls.map(call => call.kind)).toEqual(['inquiry', 'controls', 'write', 'inquiry', 'controls']);
  expect(data.persistedBeforeWrite()).toMatchObject({state: 'in-flight', writeOutcome: 'not-recorded-until-finished', desired: week(12), planned: 1,
    backup: {state: programmeToFastWarm(week()), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)}});
  expect(data.persistedBeforeWrite()).not.toHaveProperty('writeAttempted');
  const [name] = await fs.readdir(data.journals());
  expect((await fs.stat(path.join(data.journals(), name))).mode & 0o077).toBe(0);
  expect((await fs.stat(data.journals())).mode & 0o077).toBe(0);
  expect(await fs.readdir(data.persist)).toEqual([]);
  expect(data.calls.some(call => call.properties?.ControlMode || call.properties?.switch !== undefined)).toBe(false);
});

test('an unchanged automatic programme uses one native inquiry and one fresh control read, with no heating write', async () => {
  const data = await fixture(), preview = await data.prepare(week());
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', writeAttempted: false});
  expect(data.calls.map(call => call.kind)).toEqual(['inquiry', 'controls']);
});

test('provider reads cannot overtake the fresh automatic baseline; discard releases the queue without writing', async () => {
  const data = await fixture(), preview = await data.prepare();
  let finished = false;
  const pending = data.call('/provider/read', {deviceId: data.device.id}).then(() => {finished = true;});
  await new Promise(resolve => setImmediate(resolve)); expect(finished).toBe(false);
  await data.call('/provider/discard', {token: preview.token}); await pending;
  expect(finished).toBe(true); expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
});

test('an automatic apply token can be consumed only once, including while its command is running', async () => {
  const data = await fixture(), preview = await data.prepare();
  const first = data.call('/provider/apply-automatic', {token: preview.token});
  await expect(data.call('/provider/apply-automatic', {token: preview.token})).rejects.toThrow('consumed');
  expect((await first).result.status).toBe('confirmed');
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(1);
});

test.each(['hold', 'auto'])('a fresh %s mode is never cancelled by an automatic programme selection', async mode => {
  const data = await fixture(), preview = await data.prepare(); data.mode(mode);
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
  expect(data.native()).toEqual(programmeToFastWarm(week()));
});

test('external native edits arriving during the held baseline invalidate it before any programme write', async () => {
  const data = await fixture(), preview = await data.prepare(); data.emitEdit();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
  expect(data.native().days[1].events[3].temperature).toBe(12.5);
});

test('an external edit during the fresh control guard is caught before upload and never rolled back', async () => {
  const data = await fixture(), preview = await data.prepare(); data.onControls(data.emitEdit);
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
  expect(data.native().days[1].events[3].temperature).toBe(12.5);
});

test('any message connection gap invalidates a baseline even after the connection recovers', async () => {
  const data = await fixture(), preview = await data.prepare(); data.connection(false); data.connection(true);
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
});

test('a timed-out write remains unknown despite matching diagnostic native readback and is not retried', async () => {
  const data = await fixture({unknownWrite: true}), preview = await data.prepare();
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'unknown', writeAttempted: true});
  expect(data.native()).toEqual(programmeToFastWarm(week(12)));
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(1);
  await expect(data.call('/provider/apply-automatic', {token: preview.token})).rejects.toThrow('consumed');
});

test('incomplete fresh baseline returns no preview and sends neither control nor programme commands', async () => {
  const data = await fixture({partial: true});
  await expect(data.prepare()).rejects.toThrow('complete fresh');
  expect(data.calls.map(call => call.kind)).toEqual(['inquiry']);
});

test('expiry and an intervening manager read cannot authorize a stale owned baseline', async () => {
  const data = await fixture(), preview = await data.prepare();
  await data.schedules.read(data.device.id);
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  const second = await data.prepare(), original = Date.now;
  jest.spyOn(Date, 'now').mockImplementation(() => original() + 20000);
  await expect(data.call('/provider/apply-automatic', {token: second.token})).rejects.toThrow('expired');
  await data.call('/provider/discard', {token: second.token});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
});

test('unsupported automatic request fields and missing Scheduled requirement fail before any cloud request', async () => {
  const data = await fixture();
  for (const body of [{deviceId: data.device.id, programme: week(12)},
    {deviceId: data.device.id, programme: week(12), requireScheduled: false},
    {deviceId: data.device.id, programme: week(12), requireScheduled: true, force: true}]) {
    await expect(data.call('/provider/prepare-automatic', body)).rejects.toThrow('Scheduled');
  }
  expect(data.calls).toEqual([]);
});


test('a delayed external edit after the baseline remains authoritative throughout the fresh control await', async () => {
  const data = await fixture(), preview = await data.prepare(), reportedAt = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(reportedAt + 4000);
  data.onControls(() => data.emitEdit(reportedAt));
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
});

test('a Hold appearing after upload remains active and prevents confirmation without a mode command', async () => {
  const data = await fixture(), preview = await data.prepare(); let reads = 0;
  data.onControls(() => {if (++reads === 2) data.mode('hold');});
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: true, readback: {mode: 'hold', scheduled: false}});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(1);
  expect(data.calls.some(call => call.properties?.ControlMode)).toBe(false);
});

test('an untrusted operation-journal parent is rejected before any control or programme request', async () => {
  const data = await fixture(), other = path.join(data.root, 'other'); await fs.mkdir(other, {mode: 0o700});
  await fs.symlink(other, path.join(data.root, 'heating-operations'));
  const preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'not-applied', writeAttempted: false});
  expect(data.calls.map(call => call.kind)).toEqual(['inquiry']);
  expect(await fs.readdir(other)).toEqual([]);
});


test('a thermostat offline/online interval invalidates the held week even with the same broker and no programme report', async () => {
  const data = await fixture(), preview = await data.prepare();
  data.availability(false);
  data.native().days[1].events[3].temperature = 13;
  data.availability(true);
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.filter(call => call.kind === 'write')).toHaveLength(0);
  expect(data.native().days[1].events[3].temperature).toBe(13);
});
