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
const ACK_LATENCY_MS = 100;
const NATIVE_BUSY_MS = 150;
const WRITE_INTERVAL_MS = 1000;
const success = () => ({ success: true as const, result: {}, t: Date.now(), tid: 'pacing-test' });
const setbackWeek = () => collectFastWarmSchedule(FASTWARM_SCHEDULE_DAYS.map(day => ({ packet: {
  dayMask: day, events: [
    { event: 0 as const, hour: 5, minute: 30, temperature: 12 },
    { event: 1 as const, hour: 8, minute: 30, temperature: 12 },
    { event: 2 as const, hour: 17, minute: 0, temperature: 12 },
    { event: 3 as const, hour: 22, minute: 0, temperature: 12 },
  ],
} })));
const homeWeek = (before: FastWarmScheduleState) => {
  const result = structuredClone(before);
  for (const day of result.days) {
    day.events[0].temperature = 20;
    day.events[1].temperature = 18;
    day.events[2].temperature = 20;
  }
  return result;
};

describe('FastWarm acknowledged native write pacing', () => {
  let api: TuyaOpenAPI;
  let mq: TuyaOpenMQ;
  let device: TuyaDevice;
  let manager: FastWarmScheduleManager;
  let stored: FastWarmScheduleState;
  let post: jest.SpiedFunction<TuyaOpenAPI['postOnce']>;
  let decode: jest.SpiedFunction<TuyaOpenMQ['_decodeMQMessage']>;
  let otherDevice: TuyaDevice;
  let nativeWeeks: Map<string, FastWarmScheduleState>;
  let busyUntil: Map<string, number>;
  let loseWriteAcknowledgement: boolean;
  const writes: { deviceId: string; sentAt: number; acknowledgedAt?: number; event: number; dayMask: number; accepted: boolean }[] = [];

  const emitWeek = async (deviceId = device.id) => {
    for (const day of nativeWeeks.get(deviceId)!.days) {
      decode.mockReturnValueOnce(JSON.stringify({ devId: deviceId, status: [{
        code: 'week_program', value: encodeFastWarmSchedule({ dayMask: day.day, events: day.events }), t: Date.now(),
      }] }));
      await mq._onMessage('test', Buffer.from(JSON.stringify({ protocol: 4, t: Date.now(), data: 'test' })));
    }
  };
  const propertiesSent = () => post.mock.calls.map(call => JSON.parse(call[1].properties));
  const makeManager = (writeIntervalMs?: number) => new FastWarmScheduleManager(api, mq,
    id => id === device.id ? device : id === otherDevice.id ? otherDevice : undefined, writeIntervalMs === undefined ? {} : { writeIntervalMs } as any);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    initLogger({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() });
    api = new TuyaOpenAPI(TuyaOpenAPI.Endpoints.EUROPE, 'test', 'test');
    mq = new TuyaOpenMQ(api);
    mq.config = { password: 'test' } as any;
    jest.spyOn(mq, 'isConnected').mockReturnValue(true);
    decode = jest.spyOn(mq, '_decodeMQMessage');
    device = new TuyaDevice({ id: 'thermostat', product_id: 'lmtejj3f4kafi2k1', online: true,
      schema: [], status: [{ code: 'temp_unit_convert', value: 'c' }] });
    otherDevice = new TuyaDevice({ id: 'other-thermostat', product_id: 'lmtejj3f4kafi2k1', online: true,
      schema: [], status: [{ code: 'temp_unit_convert', value: 'c' }] });
    stored = setbackWeek(); nativeWeeks = new Map([[device.id, stored], [otherDevice.id, setbackWeek()]]);
    busyUntil = new Map(); loseWriteAcknowledgement = false; writes.length = 0;
    manager = makeManager();
    post = jest.spyOn(api, 'postOnce').mockImplementation(async (_path, body) => {
      const properties = JSON.parse(body.properties), deviceId = _path.split('/')[4];
      if (properties.inquire) await emitWeek(deviceId);
      if (properties.week_program) {
        const packet = decodeFastWarmSchedule(properties.week_program);
        const sentAt = performance.now();
        const write = { deviceId, sentAt, event: packet.events[0].event as number, dayMask: packet.dayMask,
          accepted: sentAt >= (busyUntil.get(deviceId) ?? -Infinity), acknowledgedAt: undefined as number | undefined };
        writes.push(write);
        // Tuya acknowledges sooner than this simulated thermostat can accept its
        // next packet. Without pacing, Wake and Return stick but Leave is lost.
        if (write.accepted) {
          for (const day of nativeWeeks.get(deviceId)!.days.filter(item => item.day & packet.dayMask)) {
            for (const event of packet.events) day.events[event.event] = { ...event };
          }
          busyUntil.set(deviceId, sentAt + NATIVE_BUSY_MS);
        }
        await new Promise(resolve => setTimeout(resolve, ACK_LATENCY_MS));
        if (loseWriteAcknowledgement) throw new Error('HTTP acknowledgement lost');
        write.acknowledgedAt = performance.now();
      }
      return success();
    });
  });

  afterEach(() => {
    manager.close();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('paces the three grouped event packets after each acknowledgement and verifies all 28 periods', async () => {
    const baseline = await manager.read(device.id), draft = homeWeek(baseline.state);
    const pending = manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    expect(writes).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(WRITE_INTERVAL_MS - 1);
    expect(writes).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS + WRITE_INTERVAL_MS);
    expect(writes).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    const result = await pending;
    expect(result).toMatchObject({ status: 'verified', applied: 3, planned: 3, verificationReads: 1 });
    expect(result.readback!.state).toEqual(draft);
    expect(writes.map(write => [write.event, write.dayMask, write.accepted])).toEqual([
      [0, 127, true], [1, 127, true], [2, 127, true],
    ]);
    expect(writes[1].sentAt - writes[0].acknowledgedAt!).toBe(WRITE_INTERVAL_MS);
    expect(writes[2].sentAt - writes[1].acknowledgedAt!).toBe(WRITE_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(6); // Baseline, fresh backup, three packets, one complete readback.
    expect(propertiesSent().every(properties => Object.keys(properties).every(key => ['inquire', 'week_program'].includes(key)))).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the unpaced control reproduces the missed middle Leave event and never retries writes', async () => {
    manager.close(); manager = makeManager(0);
    const baseline = await manager.read(device.id), draft = homeWeek(baseline.state);
    const pending = manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result).toMatchObject({ status: 'unverified', applied: 3, planned: 3, verificationReads: 3, unknownOutcome: true });
    expect(writes.map(write => write.accepted)).toEqual([true, false, true]);
    expect(result.readback!.state.days.every(day => day.events[0].temperature === 20
      && day.events[1].temperature === 12 && day.events[2].temperature === 20)).toBe(true);
    expect(result.error).toContain('7 differing periods (Monday Leave, Tuesday Leave, Wednesday Leave');
    expect(writes).toHaveLength(3);
    expect(post).toHaveBeenCalledTimes(8);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a first single-packet correction has no pacing delay or extra inquiry', async () => {
    const baseline = await manager.read(device.id), draft = structuredClone(baseline.state);
    draft.days.forEach(day => { day.events[1].temperature = 18; });
    const pending = manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1); expect(writes[0].sentAt).toBe(0);
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    const result = await pending;
    expect(result).toMatchObject({ status: 'verified', applied: 1, planned: 1, verificationReads: 1 });
    expect(performance.now()).toBe(ACK_LATENCY_MS);
    expect(post).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('retains the per-device gap across separate applies despite a forward wall-clock jump', async () => {
    const baseline = await manager.read(device.id), firstDraft = structuredClone(baseline.state);
    firstDraft.days.forEach(day => { day.events[0].temperature = 20; });
    const firstPending = manager.apply(device.id, { draft: firstDraft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    const first = await firstPending;
    jest.setSystemTime(NOW + 60 * 60 * 1000);
    const nextDraft = structuredClone(firstDraft); nextDraft.days.forEach(day => { day.events[1].temperature = 18; });
    const nextPending = manager.apply(device.id, { draft: nextDraft, expectedFingerprint: first.readback!.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(WRITE_INTERVAL_MS - 1);
    expect(writes).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);
    expect(writes[1].sentAt - writes[0].acknowledgedAt!).toBe(WRITE_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    expect((await nextPending).status).toBe('verified');
    expect(post).toHaveBeenCalledTimes(7);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('one thermostat cooldown does not delay a different thermostat first packet', async () => {
    const baseline = await manager.read(device.id), otherBaseline = await manager.read(otherDevice.id);
    const firstDraft = structuredClone(baseline.state), otherDraft = structuredClone(otherBaseline.state);
    firstDraft.days.forEach(day => { day.events[0].temperature = 20; });
    otherDraft.days.forEach(day => { day.events[1].temperature = 18; });
    const firstPending = manager.apply(device.id, { draft: firstDraft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    expect((await firstPending).status).toBe('verified');
    const otherPending = manager.apply(otherDevice.id, { draft: otherDraft, expectedFingerprint: otherBaseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ deviceId: otherDevice.id, sentAt: ACK_LATENCY_MS, accepted: true });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    expect((await otherPending).status).toBe('verified');
    expect(post).toHaveBeenCalledTimes(8);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('waits for a prior packet cooldown before running the fresh pre-write control guard', async () => {
    const baseline = await manager.read(device.id), firstDraft = structuredClone(baseline.state);
    firstDraft.days.forEach(day => { day.events[0].temperature = 20; });
    const firstPending = manager.apply(device.id, { draft: firstDraft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    const first = await firstPending;
    const nextDraft = structuredClone(firstDraft); nextDraft.days.forEach(day => { day.events[1].temperature = 18; });
    const guard = jest.fn(async () => { expect(performance.now()).toBe(ACK_LATENCY_MS + WRITE_INTERVAL_MS); });
    const nextPending = manager.apply(device.id, { draft: nextDraft, expectedFingerprint: first.readback!.fingerprint!,
      writeMode: 'grouped-events', beforeWrite: guard });
    await jest.advanceTimersByTimeAsync(WRITE_INTERVAL_MS - 1);
    expect(guard).not.toHaveBeenCalled(); expect(writes).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(guard).toHaveBeenCalledTimes(1); expect(writes).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    expect((await nextPending).status).toBe('verified');
    expect(post).toHaveBeenCalledTimes(7);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['close', 'offline'] as const)('stops unsent packets if the manager becomes %s during pacing', async kind => {
    const baseline = await manager.read(device.id), draft = homeWeek(baseline.state);
    const pending = manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    expect(writes).toHaveLength(1);
    if (kind === 'close') manager.close(); else device.online = false;
    await jest.advanceTimersByTimeAsync(WRITE_INTERVAL_MS);
    const result = await pending;
    expect(result.status).toBe('partial'); expect(result.applied).toBe(1);
    expect(result.error).toContain(kind === 'close' ? 'closed' : 'offline');
    expect(result.unknownOutcome).toBe(false);
    expect(writes).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['connection replacement', 'availability invalidation'] as const)(
    'a %s wakes the pacing wait and stops remaining packets even if the device is online', async kind => {
      const baseline = await manager.read(device.id), draft = homeWeek(baseline.state);
      const pending = manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
      await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
      expect(writes).toHaveLength(1);
      if (kind === 'connection replacement') mq._onConnect(); else manager.invalidateAutomatic(device.id);
      await jest.advanceTimersByTimeAsync(0);
      const result = await pending;
      expect(result).toMatchObject({ status: 'partial', applied: 1, planned: 3, unknownOutcome: false, verificationReads: 1 });
      expect(result.error).toContain('connection changed');
      expect(writes).toHaveLength(1);
      expect(performance.now()).toBe(ACK_LATENCY_MS);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test('a superseding automatic selection cancels unsent packets during the pacing gap', async () => {
    const prepared = await manager.prepareAutomatic(device.id), draft = homeWeek(prepared.backup.state);
    let current = true;
    const pending = manager.applyAutomatic(device.id, { token: prepared.token, draft, writeMode: 'grouped-events',
      beforeApply: async () => undefined, isCurrent: () => current });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    expect(writes).toHaveLength(1);
    current = false;
    await jest.advanceTimersByTimeAsync(WRITE_INTERVAL_MS);
    const result = await pending;
    expect(result).toMatchObject({ status: 'partial', applied: 1, planned: 3, superseded: true, unknownOutcome: false, verificationReads: 1 });
    expect(writes).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an uncertain acknowledgement stops the sequence without retry or pacing the unsent packets', async () => {
    const baseline = await manager.read(device.id), draft = homeWeek(baseline.state);
    loseWriteAcknowledgement = true;
    const pending = manager.apply(device.id, { draft, expectedFingerprint: baseline.fingerprint!, writeMode: 'grouped-events' });
    await jest.advanceTimersByTimeAsync(ACK_LATENCY_MS);
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', planned: 3, applied: 0, unknownOutcome: true, verificationReads: 1,
      error: 'HTTP acknowledgement lost' });
    expect(writes).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
  });
});
