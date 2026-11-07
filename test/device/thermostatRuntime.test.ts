import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import TuyaDevice from '../../src/device/TuyaDevice';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import { collectFastWarmSchedule, FASTWARM_SCHEDULE_DAYS, FastWarmScheduleEventId,
  FastWarmScheduleState } from '../../src/device/schedule/FastWarmSchedule';
import { FastWarmScheduleApplyResult, FastWarmScheduleSnapshot } from '../../src/device/schedule/FastWarmScheduleManager';
import ThermostatRuntime from '../../src/device/schedule/ThermostatRuntime';
import { ThermostatProfileId, ThermostatWeeklyProgramme } from '../../src/device/schedule/ThermostatProfiles';

function programme(temperature: number): ThermostatWeeklyProgramme {
  return { days: FASTWARM_SCHEDULE_DAYS.map(day => ({
    day,
    events: [6, 8, 17, 22].map((hour, event) => ({ event: event as FastWarmScheduleEventId, hour, minute: 0, temperature })),
  })) };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class MockScheduleTransport {
  native = new Map([['room-a', programme(18)], ['room-b', programme(18)]]);

  snapshot(id: string): FastWarmScheduleSnapshot {
    const state = collectFastWarmSchedule(this.native.get(id)!.days.map(day => ({
      packet: { dayMask: day.day, events: day.events },
    })));
    return {
      deviceId: id, startedAt: Date.now(), finishedAt: Date.now(), state, timedOut: false, errors: [],
      fingerprint: createHash('sha256').update(JSON.stringify(state.days.map(day => [day.day, day.events]))).digest('hex'),
    };
  }

  performApply = async (id: string, request: { draft: FastWarmScheduleState; expectedFingerprint: string }) => {
    const backup = this.snapshot(id);
    if (request.expectedFingerprint !== backup.fingerprint) {
      return { status: 'conflict', backup, planned: 0, applied: 0, error: 'The thermostat schedule changed. Refresh before applying.'
      } as FastWarmScheduleApplyResult;
    }
    this.native.set(id, copy({ days: request.draft.days.map(day => ({ day: day.day, events: day.events })) }));
    return { status: 'verified', backup, readback: this.snapshot(id), planned: 28, applied: 28 } as FastWarmScheduleApplyResult;
  };

  read = jest.fn(async (id: string) => this.snapshot(id));
  apply = jest.fn(this.performApply);
  activateProgramme = jest.fn(async (_id: string) => undefined);
  close = jest.fn();
}

interface Fixture {
  directory: string;
  runtime: ThermostatRuntime;
  transport: MockScheduleTransport;
  grouping: Map<string, number>;
  mode: Map<string, string>;
  apiGet: jest.Mock;
}

const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-runtime-test-'));
  const transport = new MockScheduleTransport();
  const grouping = new Map([['room-a', 0], ['room-b', 0]]);
  const mode = new Map([['room-a', 'smart'], ['room-b', 'smart']]);
  const devices = ['room-a', 'room-b'].map(id => ({
    id, name: id, online: true, product_id: 'lmtejj3f4kafi2k1',
    status: [{ code: 'temp_unit_convert', value: 'c' }, { code: 'temp_current', value: 180 }, { code: 'temp_set', value: 200 }],
  })) as unknown as TuyaDevice[];
  const apiGet = jest.fn(async (url: string) => {
    const id = url.split('/')[4];
    return { success: true, result: { properties: [
      { code: 'ControlMode', value: mode.get(id) }, { code: 'Event_Adaptive_Set', value: grouping.get(id) },
    ] } };
  });
  const manager = { devices, getDevice: (id: string) => devices.find(device => device.id === id), api: { get: apiGet } };
  transport.activateProgramme.mockImplementation(async id => { mode.set(id, 'smart'); });
  const runtime = new ThermostatRuntime(manager as unknown as TuyaDeviceManager, directory, '0123456789abcdef', { warn: jest.fn() }, transport);
  const result = { directory, runtime, transport, grouping, mode, apiGet };
  fixtures.push(result);
  await runtime.start(false);
  return result;
}

async function idle(runtime: ThermostatRuntime) {
  // Include the operation map because status can become verified just before its persistence finishes.
  const internal = runtime as unknown as { running: Map<string, Promise<void>> };
  for (let attempts = 0; attempts < 1000; attempts++) {
    const busy = runtime.view().thermostats.some(device => device.sync.status === 'reading' || device.sync.status === 'applying');
    if (!busy && internal.running.size === 0) {
      return;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Thermostat runtime did not finish its mocked operation.');
}

function room(runtime: ThermostatRuntime, id = 'room-a') {
  return runtime.view().thermostats.find(device => device.id === id)!;
}

async function save(runtime: ThermostatRuntime, profile: ThermostatProfileId, temperature: number, enabled?: boolean, deviceId = 'room-a') {
  return runtime.handle('/profiles/save', { deviceId, profile, schedule: programme(temperature), ...(enabled === undefined ? {} : { enabled }) });
}

async function configure(runtime: ThermostatRuntime, automatic = false) {
  await save(runtime, 'home', 20);
  await save(runtime, 'away', 16);
  await save(runtime, 'holiday', 10, automatic);
  await runtime.handle('/schedules/read', { deviceIds: ['room-a'] });
  await idle(runtime);
}

async function preview(runtime: ThermostatRuntime, profile: ThermostatProfileId = 'home') {
  const result = await runtime.handle('/schedules/apply', { preview: true, deviceIds: ['room-a'], profile });
  return (result as unknown as { preview: { id: string; devices: { id: string; profile: string; changes: number }[] } }).preview;
}

afterEach(async () => {
  jest.restoreAllMocks();
  for (const item of fixtures.splice(0)) {
    await item.runtime.close();
    await fs.rm(item.directory, { recursive: true, force: true });
  }
});

describe('thermostat runtime explicit manual operations', () => {
  test('startup, saving profiles, reading and previewing never apply or activate a programme', async () => {
    const { runtime, transport } = await fixture();
    expect(transport.read).not.toHaveBeenCalled();
    await configure(runtime);
    const plan = await preview(runtime);
    expect(plan.devices).toEqual([{ id: 'room-a', name: 'room-a', profile: 'home', changes: 28 }]);
    expect(transport.apply).not.toHaveBeenCalled();
    expect(transport.activateProgramme).not.toHaveBeenCalled();
    expect(room(runtime).enabled).toBe(false);
  });

  test('manual application requires a valid preview and works without presence enrollment', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime);
    await expect(runtime.handle('/schedules/apply', { deviceIds: ['room-a'], profile: 'home' })).rejects.toThrow('Preview');
    await expect(runtime.handle('/schedules/apply', { previewId: 'invented' })).rejects.toThrow('Preview');
    const plan = await preview(runtime);
    await runtime.handle('/schedules/apply', { previewId: plan.id });
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(transport.activateProgramme).toHaveBeenCalledWith('room-a');
    expect(room(runtime).sync.confirmedProfile).toBe('home');
    expect(room(runtime).enabled).toBe(false);
    expect(runtime.view().presence.home).toBeNull();
    await expect(runtime.handle('/schedules/apply', { previewId: plan.id })).rejects.toThrow('Preview');
  });

  test('preview token binds the exact devices and profile instead of trusting replacement request fields', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime);
    const plan = await preview(runtime, 'home');
    await runtime.handle('/schedules/apply', { previewId: plan.id, deviceIds: ['room-b'], profile: 'away' });
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(transport.apply.mock.calls[0][0]).toBe('room-a');
    expect(transport.apply.mock.calls[0][1].draft.days[0].events[0].temperature).toBe(20);
    expect(transport.native.get('room-b')).toEqual(programme(18));
  });

  test('editing a saved programme invalidates its existing preview', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime);
    const plan = await preview(runtime);
    await save(runtime, 'home', 21);
    await expect(runtime.handle('/schedules/apply', { previewId: plan.id })).rejects.toThrow('changed after preview');
    expect(transport.apply).not.toHaveBeenCalled();
  });

  test('an external thermostat edit causes a conflict without activation or retry', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime);
    const plan = await preview(runtime);
    transport.native.set('room-a', programme(17));
    await runtime.handle('/schedules/apply', { previewId: plan.id });
    await idle(runtime);
    expect(room(runtime).sync.status).toBe('conflict');
    expect(room(runtime).sync.error).toContain('schedule changed');
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(transport.activateProgramme).not.toHaveBeenCalled();
    expect(transport.native.get('room-a')).toEqual(programme(17));
  });

  test('a grouping change after preview is rechecked before any schedule write', async () => {
    const { runtime, transport, grouping } = await fixture();
    await configure(runtime);
    const plan = await preview(runtime);
    grouping.set('room-a', 1);
    await runtime.handle('/schedules/apply', { previewId: plan.id });
    await idle(runtime);
    expect(transport.apply).not.toHaveBeenCalled();
    expect(room(runtime).sync.status).toBe('failed');
    expect(room(runtime).sync.error).toContain('seven-day');
  });

  test('a persistence failure before writes does not strand an in-flight operation', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime);
    const plan = await preview(runtime);
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Profile disk full'));
    await runtime.handle('/schedules/apply', { previewId: plan.id });
    await idle(runtime);
    expect(transport.apply).not.toHaveBeenCalled();
    expect(runtime.state.devices['room-a'].inFlight).toBeNull();
    expect(room(runtime).sync.status).toBe('failed');
  });
});

describe('presence and Holiday programme application', () => {
  test('automatic selection requires all three programmes and explicit device enrollment', async () => {
    const { runtime, transport } = await fixture();
    await expect(save(runtime, 'home', 20, true)).rejects.toThrow('Home, Away and Holiday');
    expect(room(runtime).profiles).toEqual({});
    await configure(runtime, false);
    await runtime.handle('/presence', { home: true });
    await idle(runtime);
    expect(transport.apply).not.toHaveBeenCalled();
    await save(runtime, 'holiday', 10, true);
    expect(transport.apply).not.toHaveBeenCalled();
    await runtime.handle('/presence', { home: false });
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(room(runtime).sync.confirmedProfile).toBe('away');
  });

  test('Holiday wins during an ongoing Home application and ending Holiday uses the latest occupancy', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    const gate = deferred<void>();
    const started = deferred<void>();
    transport.apply.mockImplementationOnce(async (id, request) => {
      started.resolve();
      await gate.promise;
      return transport.performApply(id, request);
    });
    await runtime.handle('/presence', { home: true });
    await started.promise;
    await runtime.handle('/holiday', { active: true });
    await runtime.handle('/presence', { home: false });
    expect(room(runtime).sync.requestedProfile).toBe('holiday');
    expect(runtime.view().presence.home).toBe(false);
    gate.resolve();
    await idle(runtime);
    expect(transport.apply.mock.calls.map(call => call[1].draft.days[0].events[0].temperature)).toEqual([20, 10]);
    expect(room(runtime).sync.confirmedProfile).toBe('holiday');
    await runtime.handle('/holiday', { active: false });
    await idle(runtime);
    expect(transport.apply.mock.calls.map(call => call[1].draft.days[0].events[0].temperature)).toEqual([20, 10, 16]);
    expect(room(runtime).sync.confirmedProfile).toBe('away');
  });

  test('rapid intent changes coalesce to the last requested programme after the running operation', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    const gate = deferred<void>();
    const started = deferred<void>();
    transport.apply.mockImplementationOnce(async (id, request) => {
      started.resolve();
      await gate.promise;
      return transport.performApply(id, request);
    });
    await runtime.handle('/presence', { home: true });
    await started.promise;
    await runtime.handle('/presence', { home: false });
    await runtime.handle('/holiday', { active: true });
    await runtime.handle('/holiday', { active: false });
    gate.resolve();
    await idle(runtime);
    expect(transport.apply.mock.calls.map(call => call[1].draft.days[0].events[0].temperature)).toEqual([20, 16]);
    expect(room(runtime).sync.confirmedProfile).toBe('away');
  });

  test('partial failure clears queued intent and does not retry automatically', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    const gate = deferred<void>();
    const started = deferred<void>();
    transport.apply.mockImplementationOnce(async (id, _request) => {
      started.resolve();
      await gate.promise;
      const backup = transport.snapshot(id);
      const partial = programme(18);
      partial.days[0].events[0].temperature = 20;
      transport.native.set(id, partial);
      return { status: 'partial', backup, readback: transport.snapshot(id), planned: 28, applied: 1,
        error: 'Internet disconnected after one event' };
    });
    await runtime.handle('/presence', { home: true });
    await started.promise;
    await runtime.handle('/presence', { home: false });
    gate.resolve();
    await idle(runtime);
    expect(room(runtime).sync.status).toBe('partial');
    expect(room(runtime).sync.requestedProfile).toBe('away');
    expect(room(runtime).sync.confirmedProfile).toBeNull();
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(transport.activateProgramme).not.toHaveBeenCalled();
    await runtime.handle('/presence', { home: false });
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
  });

  test('saving a newer template during application leaves its unapplied changes visible', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    const gate = deferred<void>();
    const started = deferred<void>();
    transport.apply.mockImplementationOnce(async (id, request) => {
      started.resolve();
      await gate.promise;
      return transport.performApply(id, request);
    });
    await runtime.handle('/presence', { home: true });
    await started.promise;
    await save(runtime, 'home', 21);
    gate.resolve();
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(runtime.state.devices['room-a'].confirmedProgramme).toEqual(programme(20));
    expect(room(runtime).profiles.home).toEqual(programme(21));
    expect(room(runtime).sync.status).toBe('pending');
  });

  test('ending Holiday with unknown occupancy is rejected before choosing a fallback profile', async () => {
    const { runtime } = await fixture();
    await configure(runtime, true);
    await runtime.handle('/holiday', { active: true });
    await idle(runtime);
    expect(runtime.view().presence.home).toBeNull();
    await expect(runtime.handle('/holiday', { active: false })).rejects.toThrow('whether anyone is home');
    expect(runtime.view().holiday.active).toBe(true);
  });
});

describe('runtime persistence', () => {
  test('a failed intent persistence cannot erase a concurrently committed Holiday request', async () => {
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('First intent could not be persisted'));
    const home = runtime.handle('/presence', { home: true });
    const holiday = runtime.handle('/holiday', { active: true });
    await expect(home).rejects.toThrow('could not be persisted');
    await holiday;
    await idle(runtime);
    expect(runtime.view().holiday.active).toBe(true);
    // The rejected occupancy change must not become part of the successful request either.
    expect(runtime.view().presence.home).toBeNull();
    expect(transport.apply.mock.calls.map(call => call[1].draft.days[0].events[0].temperature)).toEqual([10]);
  });

  test('restarting preserves saved programmes and intent without scheduling cloud operations', async () => {
    const original = await fixture();
    await configure(original.runtime, true);
    await original.runtime.handle('/presence', { home: true });
    await idle(original.runtime);
    expect(room(original.runtime).sync.confirmedProfile).toBe('home');
    await original.runtime.close();
    const transport = new MockScheduleTransport();
    const runtime = new ThermostatRuntime(original.runtime.manager, original.directory, '0123456789abcdef', { warn: jest.fn() }, transport);
    fixtures.push({ ...original, runtime, transport });
    await runtime.start(false);
    expect(runtime.view().presence.home).toBe(true);
    expect(room(runtime).enabled).toBe(true);
    expect(room(runtime).profiles.home).toEqual(programme(20));
    expect(room(runtime).sync.confirmedProfile).toBeNull();
    expect(room(runtime).sync.status).toBe('idle');
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.apply).not.toHaveBeenCalled();
    expect(transport.activateProgramme).not.toHaveBeenCalled();
  });
});
