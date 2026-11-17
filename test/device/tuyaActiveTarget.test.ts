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
const week = (targetC = 20) => Object.fromEntries(days.map(day => [day,
  [360, 510, 1020, 1320].map(startMinute => ({startMinute, targetC})),
]));
const context = {timeZone: 'Europe/London'};
const fixtures: {provider: TuyaProgrammeProvider; root: string}[] = [];
afterEach(async () => {
  for (const data of fixtures.splice(0)) {await data.provider.close(); await fs.rm(data.root, {recursive: true, force: true});}
  jest.restoreAllMocks();
});
async function fixture(options: {nativeC?: number; target?: number; omitTarget?: boolean; unknownTarget?: boolean; ignoreTarget?: boolean; staleReads?: number; mqttTargetBeforeShadow?: boolean} = {}) {
  let now = Date.parse('2026-11-17T17:30:00Z'); jest.spyOn(Date, 'now').mockImplementation(() => now);
  const root = await fs.mkdtemp('/private/tmp/fw-target-'), persist = path.join(root, 'persist'); await fs.mkdir(persist, {mode: 0o700});
  const device = {id: 'test-target-room', name: 'Thermostat', online: true, product_id: 'lmtejj3f4kafi2k1',
    status: [{code: 'temp_unit_convert', value: 'c'}, {code: 'temp_current', value: 180}, {code: 'temp_set', value: 200}]} as unknown as TuyaDevice;
  let native = programmeToFastWarm(week(options.nativeC ?? 20)), mode = 'smart', grouping = 0, target = options.target ?? 200;
  let targetAt = now - 10000, pendingTarget: number | undefined, staleReads = options.staleReads ?? 0, connected = true;
  const rawListeners = new Set<any>(), connections = new Set<any>();
  const raw = (status: object[]) => {for (const listener of rawListeners) listener('test', 4, {devId: device.id, status}, now);};
  const mq: any = {addRawMessageListener: (listener: any) => rawListeners.add(listener), removeRawMessageListener: (listener: any) => rawListeners.delete(listener),
    addConnectionListener: (listener: any) => connections.add(listener), removeConnectionListener: (listener: any) => connections.delete(listener), isConnected: () => connected};
  const calls: {kind: string; properties?: any}[] = []; let controlsHook: (() => void) | undefined;
  let targetHook: ((guard: () => boolean) => Promise<boolean>) | undefined, waitHook: ((ms: number) => void) | undefined;
  const api: any = {
    request: jest.fn(async () => {
      calls.push({kind: 'controls'}); controlsHook?.();
      let observed = target;
      if (pendingTarget !== undefined) {
        if (staleReads-- > 0) observed = target;
        else {target = pendingTarget; pendingTarget = undefined; targetAt = now; observed = target;}
      }
      return {success: true, result: {properties: [{code: 'ControlMode', value: mode}, {code: 'Event_Adaptive_Set', value: grouping},
        ...(options.omitTarget ? [] : [{code: 'SetTemp', value: observed, time: targetAt}])]}};
    }),
    postOnce: jest.fn(async (_route: string, body: any, command: any) => {
      const properties = JSON.parse(body.properties);
      if (Object.hasOwn(properties, 'SetTemp')) {
        const first = command.shouldProceed(); if (!first) return {success: false, code: -1};
        if (targetHook && !await targetHook(command.shouldProceed)) return {success: false, code: -1};
        if (!command.shouldProceed()) return {success: false, code: -1};
        calls.push({kind: 'target', properties});
        if (!options.ignoreTarget) pendingTarget = properties.SetTemp;
        if (options.mqttTargetBeforeShadow) {
          device.status.find(status => status.code === 'temp_set')!.value = properties.SetTemp;
          manager.emit(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, device, [{code: 'temp_set', value: properties.SetTemp, t: now}]);
        }
        if (options.unknownTarget) throw new Error('Target write timed out after dispatch');
        return {success: true};
      }
      calls.push({kind: properties.inquire ? 'inquiry' : 'programme', properties});
      if (properties.inquire) {
        for (const day of native.days) raw([{code: 'week_program', value: encodeFastWarmSchedule({dayMask: day.day, events: day.events}), t: now}]);
      } else if (properties.ControlMode) {
        mode = properties.ControlMode;
        if (mode === 'smart') {target = 200; targetAt = ++now;}
        raw([{code: 'ControlMode', value: mode}]);
      } else if (properties.week_program) {
        const packet = decodeFastWarmSchedule(properties.week_program);
        for (const day of native.days.filter(day => day.day & packet.dayMask)) for (const event of packet.events) day.events[event.event] = {...event};
      }
      return {success: true};
    }),
  };
  const manager: any = Object.assign(new EventEmitter(), {api, mq, devices: [device], getDevice: () => device,
    getTemperatureObservation: () => undefined});
  const schedules = new FastWarmScheduleManager(api, mq, () => device, {readTimeoutMs: 10, verificationDelayMs: 0, writeIntervalMs: 0});
  const provider = new TuyaProgrammeProvider(manager, persist, '0123456789abcdef', schedules,
    {programmeWriteModes: [{deviceId: device.id, mode: 'grouped-events'}]});
  jest.spyOn(provider as any, 'targetWait').mockImplementation(async (_id, ms) => {now += Number(ms); waitHook?.(Number(ms));});
  fixtures.push({provider, root});
  const call = (route: string, body: object = {}) => provider.handle(route, body as Record<string, unknown>) as Promise<any>;
  const prepare = async (desired = week(12)) => (await call('/provider/prepare-automatic',
    {deviceId: device.id, programme: desired, requireScheduled: true, activeTarget: context})).preview;
  return {root, provider, api, calls, call, prepare, device, manager,
    target: (value: number) => {target = value; targetAt = ++now;},
    nativeTarget: () => target,
    emitTarget: (value: number) => {
      target = value; targetAt = ++now;
      device.status.find(status => status.code === 'temp_set')!.value = value;
      manager.emit(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, device, [{code: 'temp_set', value, t: targetAt}]);
    },
    rawControl: (status: object) => raw([status]),
    programmeEdit: () => {
      native.days[0].events[3].temperature = 21;
      raw([{code: 'week_program', value: encodeFastWarmSchedule({dayMask: 1, events: [native.days[0].events[3]]}), t: ++now}]);
    },
    now: (value: number) => {now = value;}, advance: (ms: number) => {now += ms;},
    mode: (value: string) => {mode = value; raw([{code: 'ControlMode', value}]);},
    onControls: (hook: () => void) => {controlsHook = hook;}, onTarget: (hook: (guard: () => boolean) => Promise<boolean>) => {targetHook = hook;},
    onWait: (hook: (ms: number) => void) => {waitHook = hook;},
    availability: (online: boolean) => {device.online = online; manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device);},
    connection: (value: boolean) => {connected = value; for (const listener of connections) listener({connected: value});},
  };
}

test('changed programme aligns its active target once while retaining all 28 periods and Smart mode', async () => {
  const data = await fixture(), preview = await data.prepare();
  expect(preview.activeTarget).toEqual(context);
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', writeAttempted: true, readback: {programme: week(12), targetC: 12, targetReadAt: expect.any(Number), mode: 'smart'}});
  expect(data.calls.filter(call => call.kind === 'target')).toEqual([{kind: 'target', properties: {SetTemp: 120}}]);
  expect(data.calls.some(call => call.properties?.ControlMode || call.properties?.switch)).toBe(false);
  const names = await fs.readdir(path.join(data.root, 'heating-operations/tuya-0123456789abcdef'));
  const journal = JSON.parse(await fs.readFile(path.join(data.root, 'heating-operations/tuya-0123456789abcdef', names[0]), 'utf8'));
  expect(journal).toMatchObject({state: 'finished', activeTargetIntent: {timeZone: 'Europe/London', targetC: 12}, result: {status: 'confirmed'}});
});

test('a matching week with the wrong current target has a durable target-only operation', async () => {
  const data = await fixture({nativeC: 12}), preview = await data.prepare();
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', writeAttempted: true, readback: {targetC: 12}});
  expect(data.calls.filter(call => call.kind === 'programme')).toHaveLength(0);
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
  const names = await fs.readdir(path.join(data.root, 'heating-operations/tuya-0123456789abcdef'));
  expect(JSON.parse(await fs.readFile(path.join(data.root, 'heating-operations/tuya-0123456789abcdef', names[0]), 'utf8')))
    .toMatchObject({planned: 0, backup: {state: programmeToFastWarm(week(12))}, activeTargetIntent: {targetC: 12}});
});

test('matching week and native target retain the minimal inquiry and control-read path', async () => {
  const data = await fixture({nativeC: 12, target: 120}), preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'confirmed', writeAttempted: false, readback: {targetC: 12, targetReadAt: expect.any(Number)}});
  expect(data.calls.map(call => call.kind)).toEqual(['inquiry', 'controls']);
});

test('read-only native verification returns fresh target rather than the manager stale cache', async () => {
  const data = await fixture({target: 120});
  expect(data.device.status.find(status => status.code === 'temp_set')!.value).toBe(200);
  const reply = await data.call('/provider/read', {deviceId: data.device.id});
  expect(reply.zone).toMatchObject({targetC: 12, targetReadAt: expect.any(Number)});
  expect(data.calls.some(call => call.kind === 'target' || call.kind === 'programme')).toBe(false);
});

test('missing native target blocks programme writes before upload', async () => {
  const data = await fixture({omitTarget: true}), preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.some(call => ['programme', 'target'].includes(call.kind))).toBe(false);
});

test('an external target edit during the programme upload is retained without a correction', async () => {
  const data = await fixture(), preview = await data.prepare(); let reads = 0;
  data.onControls(() => {if (++reads === 2) data.target(195);});
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'conflict', readback: {targetC: 19.5}});
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(0);
});

test('a target command that times out is never replayed or marked confirmed', async () => {
  const data = await fixture({unknownTarget: true}), preview = await data.prepare();
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'unknown', writeAttempted: true});
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
  await expect(data.call('/provider/apply-automatic', {token: preview.token})).rejects.toThrow('consumed');
});

test('acknowledgement without adoption remains unknown after bounded reads and one target post', async () => {
  const data = await fixture({ignoreTarget: true}), preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'unknown', writeAttempted: true, readback: {targetC: 20}});
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
  expect(data.calls.filter(call => call.kind === 'controls')).toHaveLength(5);
});

test('delayed target adoption converges using read-only checks without another target post', async () => {
  const data = await fixture({staleReads: 1}), preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result.status).toBe('confirmed');
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
  expect(data.calls.filter(call => call.kind === 'controls')).toHaveLength(4);
});

test.each(['cancellation', 'mode', 'availability', 'connection', 'period', 'target', 'programme'])('the actual authenticated dispatch guard blocks a later %s change', async kind => {
  const data = await fixture(), preview = await data.prepare();
  data.onTarget(async guard => {
    if (kind === 'cancellation') await data.call('/provider/cancel-automatic', {token: preview.token});
    if (kind === 'mode') data.mode('hold');
    if (kind === 'availability') {data.availability(false); data.availability(true);}
    if (kind === 'connection') {data.connection(false); data.connection(true);}
    if (kind === 'target') data.emitTarget(195);
    if (kind === 'programme') data.programmeEdit();
    if (kind === 'period') data.now(Date.parse('2026-11-17T22:00:01Z'));
    return guard();
  });
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result.status).toBe('conflict');
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(0);
  if (kind === 'cancellation') expect(result.superseded).toBe(true);
});

test('near a natural boundary, one bounded wait and fresh read can confirm native adoption without a target write', async () => {
  const data = await fixture();
  data.now(Date.parse('2026-11-17T21:59:50Z'));
  const preview = await data.prepare();
  data.onWait(milliseconds => {if (milliseconds > 1000) data.target(120);});
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result.status).toBe('confirmed');
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(0);
  expect(data.calls.filter(call => call.kind === 'controls')).toHaveLength(3);
});

test('invalid activation contexts are rejected before any baseline inquiry', async () => {
  const data = await fixture();
  await expect(data.call('/provider/prepare-automatic', {deviceId: data.device.id, programme: week(12), requireScheduled: true,
    activeTarget: {timeZone: 'bad'}})).rejects.toThrow('time zone');
  expect(data.calls).toEqual([]);
});


test('own MQTT before a stale shadow GET cannot mutate the protected target-only baseline', async () => {
  const data = await fixture({nativeC: 12, staleReads: 1, mqttTargetBeforeShadow: true}), preview = await data.prepare();
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result)
    .toMatchObject({status: 'confirmed', readback: {targetC: 12}});
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
  expect(data.calls.filter(call => call.kind === 'controls')).toHaveLength(3);
});

test('an identical Smart report during authentication does not invalidate unchanged controls', async () => {
  const data = await fixture(), preview = await data.prepare();
  data.onTarget(async guard => {data.mode('smart'); return guard();});
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result.status).toBe('confirmed');
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
});

test('cancellation after a possible target POST with no target proof remains unknown, never known supersession', async () => {
  const data = await fixture({ignoreTarget: true}), preview = await data.prepare();
  data.onWait(() => {if (data.calls.some(call => call.kind === 'target')) void data.call('/provider/cancel-automatic', {token: preview.token});});
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'unknown', writeAttempted: true});
  expect(result.superseded).toBeUndefined();
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
});

test('a cancelled acknowledged target may be known superseded only after fresh exact target proof', async () => {
  const data = await fixture({staleReads: 1}), preview = await data.prepare();
  data.onWait(() => {if (data.calls.some(call => call.kind === 'target')) void data.call('/provider/cancel-automatic', {token: preview.token});});
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'conflict', writeAttempted: true, superseded: true, readback: {targetC: 12}});
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
});

test('cancellation with a failed target verification read cannot prove supersession', async () => {
  const data = await fixture(), preview = await data.prepare();
  const original = data.api.request.getMockImplementation()!;
  data.api.request.mockImplementation(async (...args: any[]) => {
    if (data.calls.some(call => call.kind === 'target')) {
      await data.call('/provider/cancel-automatic', {token: preview.token});
      throw new Error('Shadow target read timed out');
    }
    return original(...args);
  });
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'unknown', writeAttempted: true}); expect(result.superseded).toBeUndefined();
});


test('a newer physical target received during a stale final settings GET cannot be overwritten', async () => {
  const data = await fixture(), preview = await data.prepare(); let reads = 0;
  const original = data.api.request.getMockImplementation()!;
  data.api.request.mockImplementation(async (...args: any[]) => {
    const reply = await original(...args);
    if (++reads === 2) data.emitTarget(195);
    return reply;
  });
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result.status).not.toBe('confirmed');
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(0);
  expect(data.nativeTarget()).toBe(195);
});

test('an own target report during a stale verification GET converges through a new read only', async () => {
  const data = await fixture({staleReads: 1}), preview = await data.prepare();
  const original = data.api.request.getMockImplementation()!; let injected = false;
  data.api.request.mockImplementation(async (...args: any[]) => {
    const reply = await original(...args);
    if (!injected && data.calls.some(call => call.kind === 'target')) {injected = true; data.emitTarget(120);}
    return reply;
  });
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', readback: {targetC: 12}});
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
});

test.each([{dpId: 110, value: 1}, {dp_id: '110', value: 1}, {'110': 1}])('raw native grouping edit %j stops authenticated target dispatch', async status => {
  const data = await fixture(), preview = await data.prepare();
  data.onTarget(async guard => {data.rawControl(status); return guard();});
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result.status).toBe('conflict');
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(0);
});

test('a reviewed manual programme applies and verifies its current target with the same timezone contract', async () => {
  const data = await fixture();
  const {preview} = await data.call('/provider/prepare', {deviceId: data.device.id, programme: week(12), activeTarget: context});
  expect(preview).toMatchObject({activeTarget: context, changesRequired: true});
  expect((await data.call('/provider/apply', {token: preview.token})).result)
    .toMatchObject({status: 'confirmed', readback: {programme: week(12), targetC: 12, targetReadAt: expect.any(Number)}});
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
});

test('a manual preview reports a required correction even when only its current target differs', async () => {
  const data = await fixture({nativeC: 12});
  const {preview} = await data.call('/provider/prepare', {deviceId: data.device.id, programme: week(12), activeTarget: context});
  expect(preview.changesRequired).toBe(true);
  expect((await data.call('/provider/apply', {token: preview.token})).result.status).toBe('confirmed');
  expect(data.calls.filter(call => call.kind === 'programme')).toHaveLength(0);
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
});

test('a target edited after manual preview is preserved without programme or target writes', async () => {
  const data = await fixture();
  const {preview} = await data.call('/provider/prepare', {deviceId: data.device.id, programme: week(12), activeTarget: context});
  data.emitTarget(195);
  expect((await data.call('/provider/apply', {token: preview.token})).result)
    .toMatchObject({status: 'conflict', writeAttempted: false});
  expect(data.calls.some(call => ['programme', 'target'].includes(call.kind))).toBe(false);
});


test('a later Fahrenheit unit cannot expose a cached native Celsius target or fresh target proof', async () => {
  const data = await fixture({target: 120});
  await data.call('/provider/read', {deviceId: data.device.id});
  data.device.status.find(status => status.code === 'temp_unit_convert')!.value = 'f';
  const reply = await data.call('/provider/list');
  expect(reply.zones[0].targetC).toBeNull(); expect(reply.zones[0].targetReadAt).toBeUndefined();
});

test('an explicit manual Hold resume aligns against its freshly recalled Smart target', async () => {
  const data = await fixture({target: 220}); data.mode('hold');
  const {preview} = await data.call('/provider/prepare', {deviceId: data.device.id, programme: week(12), activeTarget: context});
  const result = (await data.call('/provider/apply', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', readback: {mode: 'smart', programme: week(12), targetC: 12}});
  expect(data.calls.filter(call => call.properties?.ControlMode)).toHaveLength(1);
  expect(data.calls.filter(call => call.kind === 'target')).toEqual([{kind: 'target', properties: {SetTemp: 120}}]);
});


test.each([4000, 6000, 8000])('a native target report arriving %ims after ACK gets one authoritative GET without replay', async latency => {
  const data = await fixture({ignoreTarget: true}), preview = await data.prepare();
  let delayed = false;
  const waits: number[] = [];
  data.onWait(milliseconds => {
    waits.push(milliseconds);
    if (!delayed && data.calls.some(call => call.kind === 'target') && milliseconds >= latency) {
      delayed = true; data.advance(latency - milliseconds); data.emitTarget(120);
    }
  });
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result).toMatchObject({status: 'confirmed', readback: {targetC: 12}});
  expect(waits).toContain(10000);
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
  expect(data.calls.filter(call => call.kind === 'controls')).toHaveLength(3);
});

test('an already accepted post-submit native target hint uses a short settling delay', async () => {
  const data = await fixture({mqttTargetBeforeShadow: true}), preview = await data.prepare();
  const waits: number[] = []; data.onWait(milliseconds => waits.push(milliseconds));
  expect((await data.call('/provider/apply-automatic', {token: preview.token})).result.status).toBe('confirmed');
  expect(waits).toContain(250); expect(waits).not.toContain(10000);
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(1);
});

test('a stale accepted hint from before submission does not shorten the local device wait', async () => {
  const data = await fixture(); data.emitTarget(120); data.advance(5000);
  const waits: number[] = []; data.onWait(milliseconds => waits.push(milliseconds));
  await (data.provider as any).waitForTargetHint(data.device.id, 12, Date.now());
  expect(waits).toEqual([10000]);
});

test.each(['cancellation', 'offline', 'close'])('%s wakes the real target-hint wait without a heating command', async action => {
  const data = await fixture(), preview = await data.prepare();
  (data.provider as any).targetWait.mockRestore();
  const waiting = (data.provider as any).waitForTargetHint(data.device.id, 12, Date.now());
  await new Promise(resolve => setImmediate(resolve));
  if (action === 'cancellation') await data.call('/provider/cancel-automatic', {token: preview.token});
  if (action === 'offline') data.availability(false);
  if (action === 'close') await data.provider.close();
  const result = await Promise.race([waiting.then(() => 'woken'), new Promise(resolve => setTimeout(() => resolve('not-woken'), 200))]);
  expect(result).toBe('woken');
  expect(data.calls.some(call => call.kind === 'target' || call.kind === 'programme')).toBe(false);
});


test.each([false, true])('a newer manual target accepted before a stale GET is preserved (missing shadow source: %s)', async missingSource => {
  const data = await fixture(), preview = await data.prepare();
  const originalRead = data.api.request.getMockImplementation()!, originalPost = data.api.postOnce.getMockImplementation()!;
  let baseline: any, reads = 0, injected = false;
  data.api.request.mockImplementation(async (...args: any[]) => {
    if (++reads === 1) {baseline = await originalRead(...args); return baseline;}
    const stale = structuredClone(baseline);
    if (missingSource) delete stale.result.properties.find((property: any) => property.code === 'SetTemp').time;
    return stale;
  });
  data.api.postOnce.mockImplementation(async (...args: any[]) => {
    const result = await originalPost(...args);
    if (!injected && JSON.parse(args[1].properties).week_program) {injected = true; data.emitTarget(195);}
    return result;
  });
  const result = (await data.call('/provider/apply-automatic', {token: preview.token})).result;
  expect(result.status).not.toBe('confirmed');
  expect(data.calls.filter(call => call.kind === 'target')).toHaveLength(0);
  expect(data.nativeTarget()).toBe(195);
});

test('matching accepted native and shadow target values permit fresh proof with coarse source timestamps', async () => {
  const data = await fixture({target: 120}); data.emitTarget(120);
  const original = data.api.request.getMockImplementation()!;
  data.api.request.mockImplementation(async (...args: any[]) => {
    const reply = await original(...args); reply.result.properties.find((property: any) => property.code === 'SetTemp').time -= 1000;
    return reply;
  });
  expect((await data.call('/provider/read', {deviceId: data.device.id})).zone)
    .toMatchObject({targetC: 12, targetReadAt: expect.any(Number)});
});
