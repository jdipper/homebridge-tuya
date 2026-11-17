import { createHash } from 'crypto';
import EventEmitter from 'events';
import TuyaDevice from '../../src/device/TuyaDevice';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import TuyaProgrammeProvider, { programmeToFastWarm } from '../../src/device/schedule/TuyaProgrammeProvider';
import { FastWarmScheduleApplyRequest, FastWarmScheduleApplyResult, FastWarmScheduleSnapshot } from '../../src/device/schedule/FastWarmScheduleManager';

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const week = (targetC = 18) => Object.fromEntries(weekdays.map(day => [day, [360, 480, 1020, 1320]
  .map(startMinute => ({ startMinute, targetC }))]));
type Reply = { preview?: { token: string }; zone?: { programme?: unknown; scheduled: boolean }; result?: {
  status: string; writeAttempted: boolean;
}; zones?: { measuredC: number; roomName: string; temperatureReceivedAt: number; observations: {
  id: string; at: number; sourceAt?: number; currentTemperature?: number; targetTemperature?: number; online: boolean;
}[] }[] };

function fixture(options = {}) {
  let native = programmeToFastWarm(week());
  let mode = 'smart';
  let grouping = 0;
  const device = { id: 'room-a', name: 'Thermostat', room_name: 'Kitchen', online: true,
    product_id: 'lmtejj3f4kafi2k1', status: [{ code: 'temp_unit_convert', value: 'c' },
      { code: 'temp_current', value: 181 }, { code: 'temp_set', value: 200 }] } as unknown as TuyaDevice;
  const snapshot = (): FastWarmScheduleSnapshot => ({ deviceId: device.id, state: native,
    startedAt: Date.now(), finishedAt: Date.now(), errors: [], timedOut: false,
    fingerprint: createHash('sha256').update(JSON.stringify(native.days.map(day => [day.day, day.events]))).digest('hex'),
  });
  const api = { request: jest.fn(async () => ({ success: true, result: { properties: [
    { code: 'ControlMode', value: mode }, { code: 'Event_Adaptive_Set', value: grouping },
  ] } })) };
  const manager = Object.assign(new EventEmitter(), {
    devices: [device], api, getDevice: (id: string) => manager.devices.find(item => item.id === id),
    getTemperatureObservation: () => ({ receivedAt: 1760000000000, reportedAt: 1759999999000, source: 'mqtt' }),
    refreshDeviceRooms: jest.fn(async () => undefined),
  });
  const transport = {
    read: jest.fn(async () => snapshot()),
    apply: jest.fn(async (_id: string, request: FastWarmScheduleApplyRequest) => {
      const backup = snapshot();
      if (request.expectedFingerprint !== backup.fingerprint) {
        return { status: 'conflict', backup, planned: 0, applied: 0 } as FastWarmScheduleApplyResult;
      }
      const changed = JSON.stringify(native) !== JSON.stringify(request.draft);
      if (!changed) { return { status: 'no_changes', backup, planned: 0, applied: 0 } as FastWarmScheduleApplyResult; }
      try { await request.beforeWrite?.(); } catch (error) {
        return { status: 'conflict', backup, planned: 28, applied: 0, error: String(error) } as FastWarmScheduleApplyResult;
      }
      native = request.draft;
      return { status: 'verified', backup, readback: snapshot(), planned: 28, applied: 28 } as FastWarmScheduleApplyResult;
    }),
    activateProgramme: jest.fn(async () => { mode = 'smart'; }), close: jest.fn(),
  };
  const provider = new TuyaProgrammeProvider(manager as unknown as TuyaDeviceManager, '/tmp/unused', '0123456789abcdef', transport, options);
  const call = async (route: string, body: Record<string, unknown> = {}) => await provider.handle(route, body) as Reply;
  const prepare = async (programme: unknown = week(19)) => (await call('/provider/prepare', { deviceId: device.id, programme })).preview!.token;
  return { provider, transport, call, prepare, device, api, manager, setMode: (value: string) => { mode = value; },
    getNative: () => structuredClone(native), setGrouping: (value: number) => { grouping = value; }, setNative: (value: unknown) => { native = programmeToFastWarm(value); } };
}

test('lists accepted temperature observations and room metadata without schedule inquiry or heating writes', async () => {
  const data = fixture();
  const result = await data.call('/provider/list');
  expect(result.zones![0]).toMatchObject({ measuredC: 18.1, roomName: 'Kitchen', temperatureReceivedAt: 1760000000000 });
  expect(data.transport.read).not.toHaveBeenCalled();
  expect(data.transport.apply).not.toHaveBeenCalled();
  expect(data.api.request).not.toHaveBeenCalled();
});

test('rejects invalid, incomplete, out-of-order or unsupported programmes before network operations', async () => {
  for (const programme of [{ monday: [] }, { ...week(), monday: [] },
    { ...week(), monday: [360, 480, 480, 1320].map(startMinute => ({ startMinute, targetC: 18 })) }, week(40.5)]) {
    const data = fixture();
    await expect(data.prepare(programme)).rejects.toThrow();
    expect(data.transport.read).not.toHaveBeenCalled();
    expect(data.api.request).not.toHaveBeenCalled();
  }
});

test('a read returns all native periods and verified Scheduled mode without heating writes', async () => {
  const data = fixture();
  const reply = await data.call('/provider/read', { deviceId: 'room-a' });
  expect(reply.zone).toMatchObject({ programme: week(), scheduled: true });
  expect(data.transport.apply).not.toHaveBeenCalled();
});

test('preparation reads a fresh baseline and applies its token only once', async () => {
  const data = fixture();
  const token = await data.prepare();
  expect(data.transport.read).toHaveBeenCalledTimes(1);
  expect(data.transport.apply).not.toHaveBeenCalled();
  const reply = await data.call('/provider/apply', { token });
  expect(reply.result).toMatchObject({ status: 'confirmed', writeAttempted: true, readback: { programme: week(19), scheduled: true } });
  expect(data.transport.apply).toHaveBeenCalledTimes(1);
  await expect(data.call('/provider/apply', { token })).rejects.toThrow('fresh programme preview');
  expect(data.transport.apply).toHaveBeenCalledTimes(1);
});

test('an expected baseline conflict prevents creating a preview', async () => {
  const data = fixture();
  await expect(data.call('/provider/prepare', { deviceId: 'room-a', programme: week(19), expectedFingerprint: '0'.repeat(64) }))
    .rejects.toThrow('changed');
  expect(data.transport.apply).not.toHaveBeenCalled();
});

test('a programme changed after preview is not written or activated', async () => {
  const data = fixture();
  const token = await data.prepare();
  data.setNative(week(17));
  const reply = await data.call('/provider/apply', { token });
  expect(reply.result).toMatchObject({ status: 'conflict', writeAttempted: false });
  expect(data.transport.activateProgramme).not.toHaveBeenCalled();
});

test('changed Hold mode or grouping after preview blocks all schedule and mode writes', async () => {
  const data = fixture();
  const token = await data.prepare();
  data.setMode('hold');
  const reply = await data.call('/provider/apply', { token });
  expect(reply.result).toMatchObject({ status: 'conflict', writeAttempted: false });
  expect(data.transport.apply).toHaveBeenCalledTimes(1);
  expect(data.getNative()).toEqual(programmeToFastWarm(week()));
  expect(data.transport.activateProgramme).not.toHaveBeenCalled();
});

test('five-minute preview expiry is checked again after the provider queue', async () => {
  const data = fixture();
  const token = await data.prepare();
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
  try {
    expect((await data.call('/provider/apply', { token })).result).toMatchObject({ status: 'not-applied', writeAttempted: false });
    expect(data.transport.apply).not.toHaveBeenCalled();
  } finally { now.mockRestore(); }
});

test('unconfirmed/unknown application never activates Scheduled mode or automatically retries', async () => {
  const data = fixture();
  const token = await data.prepare();
  data.transport.apply.mockImplementationOnce(async () => ({ status: 'unverified', backup: await data.transport.read(),
    planned: 28, applied: 28, unknownOutcome: true }));
  expect((await data.call('/provider/apply', { token })).result).toMatchObject({ status: 'unknown', writeAttempted: true });
  expect(data.transport.apply).toHaveBeenCalledTimes(1);
  expect(data.transport.activateProgramme).not.toHaveBeenCalled();
});

test('a final readback mismatch cannot be reported as confirmed', async () => {
  const data = fixture();
  const token = await data.prepare();
  const originalApply = data.transport.apply.getMockImplementation()!;
  data.transport.apply.mockImplementationOnce(async (...args) => {
    const result = await originalApply(...args);
    return { ...result, readback: { ...result.readback!, state: programmeToFastWarm(week(16)) } };
  });
  expect((await data.call('/provider/apply', { token })).result).toMatchObject({ status: 'unconfirmed' });
});

test('writes require a supported online Celsius thermostat with seven-day programming', async () => {
  const data = fixture(); data.setGrouping(1);
  await expect(data.prepare()).rejects.toThrow('seven-day');
  data.device.online = false;
  await expect(data.prepare()).rejects.toThrow('online');
  await expect(data.call('/provider/read', { deviceId: 'other' })).rejects.toThrow('supported');
  expect(data.transport.apply).not.toHaveBeenCalled();
});

test('closing the device provider never schedules policy work and blocks future operations', async () => {
  const data = fixture();
  await data.provider.close();
  expect(data.transport.close).toHaveBeenCalledTimes(1);
  await expect(data.call('/provider/list')).rejects.toThrow('shutting down');
});

test('preserves bursts of accepted current/target/availability observations without inventing startup samples', async () => {
  const data = fixture();
  expect((await data.call('/provider/list')).zones![0].observations).toEqual([]);
  const now = Date.now();
  for (let index = 0; index < 3; index++) {
    data.manager.emit(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, data.device,
      { receivedAt: now - 10 + index, reportedAt: now - 1000 + index, value: 180 + index, source: 'mqtt' });
  }
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    // Different targets arriving in one millisecond remain distinct genuine events.
    data.manager.emit(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, data.device, [{ code: 'temp_set', value: 195, t: now - 500 }]);
    data.manager.emit(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, data.device, [{ code: 'temp_set', value: 200, t: now - 400 }]);
    data.manager.emit(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, data.device, [{ code: 'temp_current', value: 999 }]);
    data.device.online = false;
    data.manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, data.device);
    data.manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, data.device); // No transition; no extra point.
    data.device.online = true;
    data.manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, data.device);
    const points = (await data.call('/provider/list')).zones![0].observations;
    expect(points).toHaveLength(7);
    expect(points.slice(0, 3).map(point => point.currentTemperature)).toEqual([18, 18.1, 18.2]);
    expect(points.slice(3, 5)).toMatchObject([
      { at: now, sourceAt: now - 500, targetTemperature: 19.5, online: true },
      { at: now, sourceAt: now - 400, targetTemperature: 20, online: true },
    ]);
    expect(points.slice(5).map(({ id, ...point }) => point)).toEqual([{ at: now, online: false }, { at: now, online: true }]);
    expect(new Set(points.map(point => point.id)).size).toBe(7);
    expect(points.every(point => /^[a-f0-9-]{36}$/.test(point.id))).toBe(true);
    // Polling neither consumes events nor creates duplicates or synthetic points.
    expect((await data.call('/provider/list')).zones![0].observations).toEqual(points);
    points[0].currentTemperature = 99;
    expect((await data.call('/provider/list')).zones![0].observations[0].currentTemperature).toBe(18);
  } finally { clock.mockRestore(); await data.provider.close(); }
});

test('bounds observation rings to 200 per room and 2000 in total', async () => {
  const data = fixture();
  const now = Date.now();
  for (let zone = 0; zone < 11; zone++) {
    const device = zone === 0 ? data.device : { ...data.device, id: `room-${zone}` } as TuyaDevice;
    if (zone !== 0) { data.manager.devices.push(device); }
    for (let sample = 0; sample < 210; sample++) {
      data.manager.emit(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, device,
        { receivedAt: now - 10_000 + zone * 210 + sample, value: 180 + sample % 20, source: 'mqtt' });
    }
  }
  const zones = (await data.call('/provider/list')).zones!;
  expect(zones.every(zone => zone.observations.length <= 200)).toBe(true);
  expect(zones.reduce((total, zone) => total + zone.observations.length, 0)).toBe(2000);
  expect(zones.at(-1)!.observations[0].at).toBe(now - 10_000 + 10 * 210 + 10);
  await data.provider.close();
});

test('observation listeners are removed on shutdown and unknown/invalid events cannot populate rings', async () => {
  const data = fixture();
  for (const event of [TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION,
    TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, TuyaDeviceManager.Events.DEVICE_INFO_UPDATE]) {
    expect(data.manager.listenerCount(event)).toBe(1);
  }
  data.manager.emit(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, data.device,
    { receivedAt: Date.now(), value: Infinity, source: 'mqtt' });
  data.manager.emit(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, { ...data.device, id: 'unknown' },
    { receivedAt: Date.now(), value: 180, source: 'mqtt' });
  expect((await data.call('/provider/list')).zones![0].observations).toEqual([]);
  await data.provider.close();
  for (const event of [TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION,
    TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, TuyaDeviceManager.Events.DEVICE_INFO_UPDATE]) {
    expect(data.manager.listenerCount(event)).toBe(0);
  }
});

test('explicit room refresh calls SmartLife once while background list reads remain cached', async () => {
  const data = fixture();
  await data.call('/provider/list'); await data.call('/provider/list');
  expect(data.manager.refreshDeviceRooms).not.toHaveBeenCalled();
  data.manager.refreshDeviceRooms.mockImplementationOnce(async () => { data.device.room_name = 'Dining Room'; });
  expect((await data.call('/provider/refresh')).zones![0].roomName).toBe('Dining Room');
  expect(data.manager.refreshDeviceRooms).toHaveBeenCalledTimes(1);
  expect(data.transport.read).not.toHaveBeenCalled();
  expect(data.transport.apply).not.toHaveBeenCalled();
  await data.provider.close();
});

test('automatic preparation proves Scheduled mode and rejects untyped guards before queries', async () => {
  const data = fixture();
  await expect(data.call('/provider/prepare', { deviceId: 'room-a', programme: week(19), requireScheduled: 'true' })).rejects.toThrow('explicitly');
  expect(data.transport.read).not.toHaveBeenCalled();
  data.setMode('hold');
  await expect(data.call('/provider/prepare', { deviceId: 'room-a', programme: week(19), requireScheduled: true })).rejects.toThrow('Scheduled');
  expect(data.transport.apply).not.toHaveBeenCalled();
  data.setMode('smart');
  expect((await data.call('/provider/prepare', { deviceId: 'room-a', programme: week(19), requireScheduled: true })).preview)
    .toMatchObject({ requireScheduled: true });
});

test('normal Scheduled application retains one complete manager readback and three settings reads', async () => {
  const data = fixture(); const token = await data.prepare();
  expect((await data.call('/provider/apply', { token })).result).toMatchObject({ status: 'confirmed' });
  expect(data.transport.read).toHaveBeenCalledTimes(1); // Prepare only; manager already returns the complete final week.
  expect(data.api.request).toHaveBeenCalledTimes(3); // Prepare, immediately pre-write, after full-week readback.
  expect(data.transport.apply).toHaveBeenCalledWith('room-a', expect.objectContaining({ writeMode: 'single-events' }));
});

test('a matching programme needs only preparation and final control reads, with no activation', async () => {
  const data = fixture(); const token = await data.prepare(week());
  expect((await data.call('/provider/apply', { token })).result).toMatchObject({ status: 'confirmed', writeAttempted: false });
  expect(data.api.request).toHaveBeenCalledTimes(2);
  expect(data.transport.read).toHaveBeenCalledTimes(1);
  expect(data.transport.activateProgramme).not.toHaveBeenCalled();
});

test('per-device validated modes are allowlisted and never selected by an untrusted request body', async () => {
  const data = fixture({ programmeWriteModes: [{ deviceId: 'room-a', mode: 'grouped-days' }] });
  const token = await data.prepare(); await data.call('/provider/apply', { token });
  expect(data.transport.apply).toHaveBeenCalledWith('room-a', expect.objectContaining({ writeMode: 'grouped-days' }));
  const other = fixture({ programmeWriteModes: [{ deviceId: 'room-b', mode: 'grouped-days' }] });
  const preview = await other.call('/provider/prepare', { deviceId: 'room-a', programme: week(19), writeMode: 'grouped-days' });
  await other.call('/provider/apply', { token: preview.preview!.token, writeMode: 'grouped-days' });
  expect(other.transport.apply).toHaveBeenCalledWith('room-a', expect.objectContaining({ writeMode: 'single-events' }));
  for (const modes of [[{ deviceId: 'room-a', mode: 'unknown' }], [{ deviceId: 'room-a', mode: 'whole-days' }, { deviceId: 'room-a', mode: 'grouped-days' }]]) {
    expect(() => fixture({ programmeWriteModes: modes })).toThrow('hardware-validated');
  }
});

test('manual Hold-to-Scheduled activation still receives a separate fresh week and control proof', async () => {
  const data = fixture(); data.setMode('hold'); const token = await data.prepare();
  expect((await data.call('/provider/apply', { token })).result).toMatchObject({ status: 'confirmed' });
  expect(data.transport.activateProgramme).toHaveBeenCalledTimes(1);
  expect(data.transport.read).toHaveBeenCalledTimes(2);
  expect(data.api.request).toHaveBeenCalledTimes(4);
});

test('control changes after the manager readback cannot be reported as confirmed', async () => {
  const data = fixture(); const token = await data.prepare();
  const original = data.transport.apply.getMockImplementation()!;
  data.transport.apply.mockImplementationOnce(async (...args) => {
    const result = await original(...args); data.setMode('hold'); return result;
  });
  expect((await data.call('/provider/apply', { token })).result).toMatchObject({ status: 'conflict' });
  expect(data.transport.activateProgramme).not.toHaveBeenCalled();
});
