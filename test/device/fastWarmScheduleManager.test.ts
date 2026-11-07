/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import TuyaOpenAPI from '../../src/core/TuyaOpenAPI';
import TuyaOpenMQ from '../../src/core/TuyaOpenMQ';
import TuyaDevice from '../../src/device/TuyaDevice';
import FastWarmScheduleManager from '../../src/device/schedule/FastWarmScheduleManager';
import {
  collectFastWarmSchedule, decodeFastWarmSchedule, encodeFastWarmSchedule, FASTWARM_SCHEDULE_DAYS, FastWarmScheduleState,
} from '../../src/device/schedule/FastWarmSchedule';
import { initLogger } from '../../src/util/Logger';

const NOW = 1794025076000;
const success = () => ({ success: true as const, result: {}, t: Date.now(), tid: 'test' });
const week = () => collectFastWarmSchedule(FASTWARM_SCHEDULE_DAYS.map((day, index) => ({ packet: {
  dayMask: day,
  events: [
    { event: 0 as const, hour: 6, minute: 0, temperature: 20 + index * 0.5 },
    { event: 1 as const, hour: 8, minute: 30, temperature: 16 },
    { event: 2 as const, hour: 17, minute: 0, temperature: 21 },
    { event: 3 as const, hour: 22, minute: 0, temperature: 12 },
  ],
} })));

describe('FastWarm programme transport', () => {
  let api: TuyaOpenAPI;
  let mq: TuyaOpenMQ;
  let manager: FastWarmScheduleManager;
  let device: TuyaDevice;
  let stored: FastWarmScheduleState;
  let post: jest.SpiedFunction<TuyaOpenAPI['postOnce']>;
  let decode: jest.SpiedFunction<TuyaOpenMQ['_decodeMQMessage']>;

  const emit = async (status: unknown[], timestamp = Date.now(), deviceId = 'thermostat') => {
    decode.mockReturnValueOnce(JSON.stringify({ devId: deviceId, status }));
    await mq._onMessage('test', Buffer.from(JSON.stringify({ protocol: 4, t: timestamp, data: 'test' })));
  };
  const emitWeek = async (state = stored) => {
    for (const day of state.days) {
      await emit([{ code: 'week_program', value: encodeFastWarmSchedule({ dayMask: day.day, events: day.events }), t: Date.now() }]);
    }
  };
  const propertiesSent = () => post.mock.calls.map(call => JSON.parse(call[1].properties));
  const scheduleWrites = () => propertiesSent().filter(properties => properties.week_program);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    initLogger({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() });
    api = new TuyaOpenAPI(TuyaOpenAPI.Endpoints.EUROPE, 'test', 'test');
    mq = new TuyaOpenMQ(api);
    mq.config = { password: 'test' } as any;
    decode = jest.spyOn(mq, '_decodeMQMessage');
    device = new TuyaDevice({
      id: 'thermostat', product_id: 'lmtejj3f4kafi2k1', online: true,
      schema: [], status: [{ code: 'temp_unit_convert', value: 'c' }],
    });
    stored = week();
    manager = new FastWarmScheduleManager(api, mq, id => id === device.id ? device : undefined);
    post = jest.spyOn(api, 'postOnce').mockImplementation(async (_path, body) => {
      const properties = JSON.parse(body.properties);
      if (properties.inquire) {
        await emitWeek();
      }
      if (properties.week_program) {
        const packet = decodeFastWarmSchedule(properties.week_program);
        const day = stored.days.find(item => item.day === packet.dayMask)!;
        day.events[packet.events[0].event] = { ...packet.events[0] };
      }
      return success();
    });
  });

  afterEach(() => {
    manager.close();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('is passive until asked and subscribes before sending the inquiry', async () => {
    expect(post).not.toHaveBeenCalled();
    const snapshot = await manager.read(device.id);
    expect(snapshot.state.complete).toBe(true);
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.timedOut).toBe(false);
    expect(post).toHaveBeenCalledWith('/v2.0/cloud/thing/thermostat/shadow/properties/issue', {
      properties: '{"inquire":true}',
    }, { timeoutMs: 15000 });
    const cached = manager.getSnapshot(device.id)!;
    cached.state.days[0].events[0].temperature = 40;
    expect(manager.getSnapshot(device.id)!.state.days[0].events[0].temperature).toBe(20);
  });

  test('collects all 28 six-byte reports by day/event identity', async () => {
    post.mockImplementation(async () => {
      for (const day of [...stored.days].reverse()) {
        for (const event of [...day.events].reverse()) {
          await emit([{ dpId: 119, value: encodeFastWarmSchedule({ dayMask: day.day, events: [event] }), t: NOW }]);
        }
      }
      return success();
    });
    const snapshot = await manager.read(device.id);
    expect(snapshot.state).toEqual(stored);
    expect(snapshot.fingerprint).not.toBeNull();
  });

  test('gets original chunks before standard scalar correction can replace older day reports', async () => {
    post.mockImplementation(async () => {
      for (const [index, day] of stored.days.entries()) {
        await emit([{ code: 'week_program', value: encodeFastWarmSchedule({ dayMask: day.day, events: day.events }), t: NOW - index }],
          NOW - index);
      }
      return success();
    });
    expect((await manager.read(device.id)).state).toEqual(stored);
  });

  test.each(['dp_id', 'numeric', 'envelope-seconds'])('accepts the raw report identity/timestamp form %s', async form => {
    post.mockImplementation(async () => {
      for (const day of stored.days) {
        const raw = encodeFastWarmSchedule({ dayMask: day.day, events: day.events });
        const report = form === 'numeric' ? { '119': raw, time: NOW }
          : form === 'dp_id' ? { dp_id: 119, value: raw, time: NOW } : { code: 'week_program', value: raw };
        await emit([report], form === 'envelope-seconds' ? NOW / 1000 : NOW);
      }
      return success();
    });
    expect((await manager.read(device.id)).state.complete).toBe(true);
  });

  test.each(['milliseconds', 'seconds', 'invalid-property-fallback', 'unsafe-property-fallback'])(
    'accepts legacy timestamps or a valid frame fallback: %s', async form => {
      post.mockImplementation(async () => {
        for (const day of stored.days) {
          const time = form === 'milliseconds' ? String(NOW) : form === 'seconds' ? String(NOW / 1000)
            : form === 'invalid-property-fallback' ? 'invalid' : '99999999999999999999';
          await emit([{ code: 'week_program', value: encodeFastWarmSchedule({ dayMask: day.day, events: day.events }), t: time }]);
        }
        return success();
      });
      expect((await manager.read(device.id)).fingerprint).not.toBeNull();
    },
  );

  test('does not replace a valid stale quoted property timestamp with a fresh frame timestamp', async () => {
    post.mockImplementation(async () => {
      for (const day of stored.days) {
        await emit([{ code: 'week_program', value: encodeFastWarmSchedule({ dayMask: day.day, events: day.events }), t: String(NOW - 10000) }]);
      }
      return success();
    });
    const pending = manager.read(device.id);
    await jest.advanceTimersByTimeAsync(30000);
    const snapshot = await pending;
    expect(snapshot.state.missing).toHaveLength(28);
    expect(snapshot.fingerprint).toBeNull();
  });

  test('returns an honest partial week on timeout and ignores stale or invalid reports', async () => {
    post.mockImplementation(async () => {
      await emit([{ code: 'week_program', value: encodeFastWarmSchedule({ dayMask: 127, events: stored.days[0].events }), t: NOW - 10000 }]);
      await emit([{ dpId: 119, value: 'invalid', t: NOW }]);
      await emit([{ dpId: 124, value: encodeFastWarmSchedule({ dayMask: 127, events: stored.days[0].events }), t: NOW }]);
      await emit([{ dpId: 119, value: encodeFastWarmSchedule({ dayMask: 1, events: [stored.days[0].events[0]] }), t: NOW }]);
      return success();
    });
    const pending = manager.read(device.id);
    await jest.advanceTimersByTimeAsync(30000);
    const snapshot = await pending;
    expect(snapshot.timedOut).toBe(true);
    expect(snapshot.state.complete).toBe(false);
    expect(snapshot.state.missing).toHaveLength(27);
    expect(snapshot.fingerprint).toBeNull();
  });

  test('does not trust complete reports if the inquiry itself was rejected', async () => {
    post.mockImplementation(async () => {
      await emitWeek();
      return { success: false, result: {}, code: 1004, msg: 'rejected', t: NOW, tid: 'test' };
    });
    const snapshot = await manager.read(device.id);
    expect(snapshot.state.complete).toBe(true);
    expect(snapshot.fingerprint).toBeNull();
    expect(snapshot.errors[0]).toContain('rejected');
  });

  test('applies only changed six-byte events and verifies the whole week without changing mode/power/settings', async () => {
    const baseline = await manager.read(device.id);
    const draft = JSON.parse(JSON.stringify(baseline.state));
    draft.days[0].events[0].temperature = 21;
    const result = await manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint! });
    expect(result.status).toBe('verified');
    expect(result.applied).toBe(1);
    expect(result.planned).toBe(1);
    expect(result.backup.state.days[0].events[0].temperature).toBe(20);
    expect(result.readback!.state).toEqual(draft);
    expect(scheduleWrites()).toHaveLength(1);
    expect(Buffer.from(scheduleWrites()[0].week_program, 'base64')).toHaveLength(6);
    expect(propertiesSent().every(properties => Object.keys(properties).every(key => ['inquire', 'week_program'].includes(key)))).toBe(true);
  });

  test('rejects an external-edit conflict before any schedule write', async () => {
    const baseline = await manager.read(device.id);
    stored.days[1].events[0].temperature = 24;
    const result = await manager.apply(device.id, { draft: baseline.state, expectedFingerprint: baseline.fingerprint! });
    expect(result.status).toBe('conflict');
    expect(scheduleWrites()).toHaveLength(0);
  });

  test('skips writes for an unchanged validated draft', async () => {
    const baseline = await manager.read(device.id);
    expect((await manager.apply(device.id, { draft: baseline.state, expectedFingerprint: baseline.fingerprint! })).status).toBe('no_changes');
    expect(scheduleWrites()).toHaveLength(0);
  });

  test('aborts at the first failed write, never retries, and reads back the partial result', async () => {
    const baseline = await manager.read(device.id);
    const draft = JSON.parse(JSON.stringify(baseline.state));
    draft.days[0].events.forEach((event: any) => { event.temperature = 25; });
    const original = post.getMockImplementation()!;
    let writes = 0;
    post.mockImplementation(async (...args) => {
      if (JSON.parse(args[1].properties).week_program && ++writes === 2) {
        throw new Error('connection lost; outcome unknown');
      }
      return original(...args);
    });
    const result = await manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint! });
    expect(result.status).toBe('partial');
    expect(result.applied).toBe(1);
    expect(result.planned).toBe(4);
    expect(result.unknownOutcome).toBe(true);
    expect(scheduleWrites()).toHaveLength(2);
    expect(result.readback!.state.days[0].events[0].temperature).toBe(25);
    expect(result.readback!.state.days[0].events[1].temperature).toBe(16);
  });

  test('distinguishes acknowledged commands from verified device state', async () => {
    const baseline = await manager.read(device.id);
    const draft = JSON.parse(JSON.stringify(baseline.state));
    draft.days[0].events[0].temperature = 25;
    post.mockImplementation(async (_path, body) => {
      if (JSON.parse(body.properties).inquire) {
        await emitWeek();
      }
      return success();
    });
    const result = await manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint! });
    expect(result.status).toBe('unverified');
    expect(result.unknownOutcome).toBe(true);
    expect(scheduleWrites()).toHaveLength(1);
  });

  test('stops after an explicit command rejection without retrying or claiming an unknown network outcome', async () => {
    const baseline = await manager.read(device.id);
    const draft = JSON.parse(JSON.stringify(baseline.state));
    draft.days[0].events[0].temperature = 25;
    const original = post.getMockImplementation()!;
    post.mockImplementation(async (...args) => JSON.parse(args[1].properties).week_program
      ? { success: false, result: {}, code: 1004, msg: 'command rejected', t: NOW, tid: 'test' } : original(...args));
    const result = await manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint! });
    expect(result.status).toBe('failed');
    expect(result.applied).toBe(0);
    expect(result.unknownOutcome).toBe(false);
    expect(result.error).toContain('command rejected');
    expect(scheduleWrites()).toHaveLength(1);
  });

  test('refuses apply when a fresh complete backup cannot be collected', async () => {
    const baseline = await manager.read(device.id);
    post.mockResolvedValue(success());
    const pending = manager.apply(device.id, { draft: baseline.state, expectedFingerprint: baseline.fingerprint! });
    await jest.advanceTimersByTimeAsync(30000);
    expect((await pending).status).toBe('failed');
    expect(scheduleWrites()).toHaveLength(0);
  });

  test('validates the entire draft before making any network calls', async () => {
    const draft = week();
    draft.days[0].events[0].temperature = 41;
    await expect(manager.apply(device.id, { draft, expectedFingerprint: 'a'.repeat(64) })).rejects.toThrow('temperature');
    expect(post).not.toHaveBeenCalled();
    draft.days[0].events[0].temperature = 20;
    draft.days[0].events[1].hour = 5;
    await expect(manager.apply(device.id, { draft, expectedFingerprint: 'a'.repeat(64) })).rejects.toThrow('increase');
    expect(post).not.toHaveBeenCalled();
  });

  test.each(['offline', 'unsupported', 'fahrenheit'])('blocks %s devices without network calls', async kind => {
    if (kind === 'offline') { device.online = false; }
    if (kind === 'unsupported') { device.product_id = 'another-product'; }
    if (kind === 'fahrenheit') { device.status[0].value = 'f'; }
    await expect(manager.read(device.id)).rejects.toThrow();
    await expect(manager.activateProgramme(device.id)).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  test('serializes operations per device and releases the queue after a read finishes', async () => {
    post.mockImplementationOnce(async () => success());
    const first = manager.read(device.id);
    const second = manager.read(device.id);
    await jest.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    await emitWeek();
    expect((await first).state.complete).toBe(true);
    expect((await second).state.complete).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
  });

  test('only activates programme mode through its separate explicit action', async () => {
    await manager.activateProgramme(device.id);
    expect(propertiesSent()).toEqual([{ ControlMode: 'smart' }]);
  });

  test('unsubscribes and ends an active read when closed', async () => {
    post.mockResolvedValue(success());
    const pending = manager.read(device.id);
    await jest.advanceTimersByTimeAsync(0);
    manager.close();
    expect((await pending).errors).toEqual(['Schedule manager closed.']);
    await expect(manager.read(device.id)).rejects.toThrow('closed');
  });
});
