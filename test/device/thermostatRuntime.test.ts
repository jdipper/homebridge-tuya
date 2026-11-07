import { createHash } from 'crypto';
import EventEmitter from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import TuyaDevice from '../../src/device/TuyaDevice';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import { collectFastWarmSchedule, FASTWARM_SCHEDULE_DAYS, FastWarmScheduleEventId,
  FastWarmScheduleState } from '../../src/device/schedule/FastWarmSchedule';
import { FastWarmScheduleApplyResult, FastWarmScheduleSnapshot } from '../../src/device/schedule/FastWarmScheduleManager';
import ThermostatRuntime from '../../src/device/schedule/ThermostatRuntime';
import { FastWarmOverrideBaseline } from '../../src/device/schedule/FastWarmOverrideTransport';
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

class MockOverrideTransport {
  preview = jest.fn(async (_id: string): Promise<FastWarmOverrideBaseline> => ({ mode: 'smart', temperature: 20, power: true, unit: 'c' }));
  startOverride = jest.fn(async (_id: string, _request: unknown) => undefined);
  resumeOverride = jest.fn(async (_id: string, _request: unknown) => undefined);
}

interface Fixture {
  directory: string;
  runtime: ThermostatRuntime;
  transport: MockScheduleTransport;
  grouping: Map<string, number>;
  mode: Map<string, string>;
  apiGet: jest.Mock;
  overrideTransport: MockOverrideTransport;
}

const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-runtime-test-'));
  const transport = new MockScheduleTransport();
  const overrideTransport = new MockOverrideTransport();
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
  const manager = Object.assign(new EventEmitter(), { devices, getDevice: (id: string) => devices.find(device => device.id === id), api: { get: apiGet, request: (_method: string, url: string) => apiGet(url) } });
  transport.activateProgramme.mockImplementation(async id => { mode.set(id, 'smart'); });
  const runtime = new ThermostatRuntime(manager as unknown as TuyaDeviceManager, directory, '0123456789abcdef', { warn: jest.fn() }, transport, overrideTransport);
  const result = { directory, runtime, transport, grouping, mode, apiGet, overrideTransport };
  fixtures.push(result);
  await runtime.start(false);
  return result;
}

async function idle(runtime: ThermostatRuntime) {
  // Include the operation map because status can become verified just before its persistence finishes.
  const internal = runtime as unknown as {
    running: Map<string, Promise<void>>; stateTransactions: Promise<void>; policyOperation: Promise<void>;
  };
  for (let attempts = 0; attempts < 1000; attempts++) {
    await internal.policyOperation;
    await internal.stateTransactions;
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
  jest.useRealTimers();
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
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
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
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
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
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
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
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
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
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
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
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
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
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
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


describe('bridge-owned controls and timers', () => {
  function fakeClock() {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12), doNotFake: ['setImmediate', 'nextTick'] });
  }

  test('default Away grace and guest hold retain actual occupancy separately', async () => {
    fakeClock();
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    expect(runtime.view().presence.awayDelayMinutes).toBe(30);
    await runtime.handle('/controls/settings', { awayDelayMinutes: 30 });
    await runtime.handle('/presence', { home: true });
    await idle(runtime);
    await runtime.handle('/presence', { home: false });
    expect(runtime.view().presence.home).toBe(false);
    expect(runtime.view().presence.effectiveHome).toBe(true);
    jest.advanceTimersByTime(30 * 60000 - 1);
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    await runtime.handle('/presence/hold', { until: Date.now() + 3600000 });
    jest.advanceTimersByTime(1);
    await idle(runtime);
    expect(runtime.view().presence.effectiveHome).toBe(true);
    jest.advanceTimersByTime(3600000);
    await idle(runtime);
    expect(runtime.view().presence.effectiveHome).toBe(false);
    expect(room(runtime).sync.confirmedProfile).toBe('away');
    expect(transport.apply).toHaveBeenCalledTimes(2);
  });

  test('arrival cancels a pending departure and unknown presence remains unknown after guest hold', async () => {
    fakeClock();
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    await runtime.handle('/controls/settings', { awayDelayMinutes: 30 });
    await runtime.handle('/presence', { home: true });
    await idle(runtime);
    await runtime.handle('/presence', { home: false });
    await runtime.handle('/presence', { home: true });
    expect(runtime.view().presence.pendingAwayAt).toBeNull();
    jest.advanceTimersByTime(3600000);
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    const second = await fixture();
    await configure(second.runtime, true);
    await second.runtime.handle('/presence/hold', { until: Date.now() + 1000 });
    await idle(second.runtime);
    jest.advanceTimersByTime(1000);
    await idle(second.runtime);
    expect(second.runtime.view().presence.home).toBeNull();
    expect(second.runtime.view().presence.effectiveHome).toBeNull();
    expect(second.transport.apply).toHaveBeenCalledTimes(1);
  });

  test('Holiday preheat uses Home while keeping Holiday visible, then returns to latest actual occupancy', async () => {
    fakeClock();
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
    await runtime.handle('/presence', { home: false });
    await idle(runtime);
    await runtime.handle('/holiday', { active: true, returnAt: Date.now() + 3600000, preheatMinutes: 30 });
    await idle(runtime);
    jest.advanceTimersByTime(1800000);
    await idle(runtime);
    expect(runtime.view().holiday.active).toBe(true);
    expect(runtime.view().holiday.preheating).toBe(true);
    expect(room(runtime).sync.confirmedProfile).toBe('home');
    jest.advanceTimersByTime(1800000);
    await idle(runtime);
    expect(runtime.view().holiday.active).toBe(false);
    expect(room(runtime).sync.confirmedProfile).toBe('away');
    expect(transport.apply.mock.calls.map(call => call[1].draft.days[0].events[0].temperature)).toEqual([16, 10, 20, 16]);
  });

  test('overdue policy restored after restart requires review and sends no startup command', async () => {
    fakeClock();
    const original = await fixture();
    await configure(original.runtime, true);
    await original.runtime.handle('/controls/settings', { awayDelayMinutes: 30 });
    await original.runtime.handle('/presence', { home: true });
    await idle(original.runtime);
    await original.runtime.handle('/presence', { home: false });
    await original.runtime.close();
    jest.advanceTimersByTime(3600000);
    const transport = new MockScheduleTransport();
    const runtime = new ThermostatRuntime(original.runtime.manager, original.directory, '0123456789abcdef', { warn: jest.fn() }, transport);
    fixtures.push({ ...original, runtime, transport });
    await runtime.start(false);
    expect(runtime.view().controls.recoveryRequired).toContain('while Homebridge was stopped');
    expect(transport.apply).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3600000);
    await idle(runtime);
    expect(transport.apply).not.toHaveBeenCalled();
    await expect(runtime.handle('/controls/recover', {})).rejects.toThrow('explicitly confirm');
  });
});

describe('temporary overrides', () => {
  function fakeClock() {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12), doNotFake: ['setImmediate', 'nextTick'] });
  }

  async function review(runtime: ThermostatRuntime, temperature = 23) {
    const response = await runtime.handle('/overrides/preview', { deviceId: 'room-a', temperature, endsAt: Date.now() + 3600000 });
    return (response as unknown as { overridePreview: { id: string } }).overridePreview;
  }

  test('preview is immutable, start needs explicit host-expiry consent and expiry resumes exactly once', async () => {
    fakeClock();
    const { runtime, overrideTransport } = await fixture();
    const plan = await review(runtime);
    expect(overrideTransport.startOverride).not.toHaveBeenCalled();
    await expect(runtime.handle('/overrides/start', { previewId: plan.id })).rejects.toThrow('Explicitly accept');
    await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true, temperature: 30 });
    await idle(runtime);
    expect(overrideTransport.startOverride).toHaveBeenCalledWith('room-a', expect.objectContaining({ temperature: 23 }));
    expect(room(runtime).override?.status).toBe('active');
    jest.advanceTimersByTime(3600000);
    await idle(runtime);
    expect(overrideTransport.resumeOverride).toHaveBeenCalledTimes(1);
    expect(room(runtime).override?.status).toBe('completed');
    jest.advanceTimersByTime(3600000);
    await idle(runtime);
    expect(overrideTransport.resumeOverride).toHaveBeenCalledTimes(1);
  });

  test('presence is retained during override and only applies after successful explicit resume', async () => {
    fakeClock();
    const { runtime, transport } = await fixture();
    await configure(runtime, true);
    await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
    await runtime.handle('/presence', { home: true });
    await idle(runtime);
    const plan = await review(runtime);
    await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
    await idle(runtime);
    await runtime.handle('/presence', { home: false });
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    await runtime.handle('/schedules/read', { deviceIds: ['room-a'] });
    await idle(runtime);
    await runtime.handle('/overrides/cancel', { deviceId: 'room-a' });
    await idle(runtime);
    expect(transport.apply).toHaveBeenCalledTimes(2);
    expect(room(runtime).sync.confirmedProfile).toBe('away');
  });

  test('an expiry failure is visible and never retries, including after restart', async () => {
    fakeClock();
    const original = await fixture();
    const plan = await review(original.runtime);
    await original.runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
    await idle(original.runtime);
    original.overrideTransport.resumeOverride.mockRejectedValueOnce(new Error('Internet unavailable'));
    jest.advanceTimersByTime(3600000);
    await idle(original.runtime);
    expect(room(original.runtime).override?.status).toBe('recovery-required');
    expect(room(original.runtime).override?.error).toContain('will not retry');
    jest.advanceTimersByTime(3600000);
    await idle(original.runtime);
    expect(original.overrideTransport.resumeOverride).toHaveBeenCalledTimes(1);
    await original.runtime.close();
    const overrideTransport = new MockOverrideTransport();
    const runtime = new ThermostatRuntime(original.runtime.manager, original.directory, '0123456789abcdef',
      { warn: jest.fn() }, original.transport, overrideTransport);
    fixtures.push({ ...original, runtime, overrideTransport });
    await runtime.start(false);
    jest.advanceTimersByTime(3600000);
    await idle(runtime);
    expect(room(runtime).override?.status).toBe('recovery-required');
    expect(overrideTransport.resumeOverride).not.toHaveBeenCalled();
  });

  test('active override restored before its deadline also needs review and never auto-resumes', async () => {
    fakeClock();
    const original = await fixture();
    const plan = await review(original.runtime);
    await original.runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
    await idle(original.runtime);
    await original.runtime.close();
    const overrideTransport = new MockOverrideTransport();
    const runtime = new ThermostatRuntime(original.runtime.manager, original.directory, '0123456789abcdef',
      { warn: jest.fn() }, original.transport, overrideTransport);
    fixtures.push({ ...original, runtime, overrideTransport });
    await runtime.start(false);
    jest.advanceTimersByTime(3600000);
    await idle(runtime);
    expect(room(runtime).override?.status).toBe('recovery-required');
    expect(overrideTransport.resumeOverride).not.toHaveBeenCalled();
  });
});

describe('local room and programme history', () => {
  test('room aliases and clock confirmation are local; restoring a programme changes only its draft', async () => {
    const { runtime, transport } = await fixture();
    await runtime.handle('/rooms/save', { deviceId: 'room-a', name: 'Kitchen', timeZone: 'Europe/London', clockVerified: true });
    expect(room(runtime).name).toBe('Kitchen');
    expect(runtime.manager.getDevice('room-a')?.name).toBe('room-a');
    await save(runtime, 'home', 20);
    await save(runtime, 'home', 21);
    const old = room(runtime).programmeHistory.find(version => version.programme.days[0].events[0].temperature === 20)!;
    await runtime.handle('/profiles/restore', { deviceId: 'room-a', versionId: old.id, profile: 'away' });
    expect(room(runtime).profiles.away).toEqual(programme(20));
    expect(room(runtime).profiles.home).toEqual(programme(21));
    expect(transport.apply).not.toHaveBeenCalled();
    expect(transport.activateProgramme).not.toHaveBeenCalled();
  });

  test('history records genuine observations and view reads create no points', async () => {
    const { runtime } = await fixture();
    const now = Date.now();
    await runtime.recordTemperature('room-a', { at: now, sourceAt: now - 1000, currentTemperature: 18,
      targetTemperature: 20, unit: 'c', online: true });
    runtime.view(); runtime.view();
    const response = await runtime.handle('/temperatures/history', { deviceId: 'room-a' });
    expect((response as unknown as { temperatureHistory: unknown[] }).temperatureHistory).toHaveLength(1);
  });
});


test('genuine current, target and online events preserve independent history fields and unsubscribe on close', async () => {
  const { runtime } = await fixture();
  const device = runtime.manager.getDevice('room-a')!;
  runtime.manager.emit(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, device,
    { value: 185, receivedAt: Date.now(), reportedAt: Date.now() - 1000, source: 'mqtt' });
  await idle(runtime);
  runtime.manager.emit(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, device, [{ code: 'temp_set', value: 220 }]);
  await idle(runtime);
  device.online = false;
  runtime.manager.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device, {});
  await idle(runtime);
  const response = await runtime.handle('/temperatures/history', { deviceId: 'room-a' });
  const points = (response as unknown as { temperatureHistory: Record<string, unknown>[] }).temperatureHistory;
  expect(points).toHaveLength(3);
  expect(points[0]).toEqual(expect.objectContaining({ currentTemperature: 18.5 }));
  expect(points[0].targetTemperature).toBeUndefined();
  expect(points[1]).toEqual(expect.objectContaining({ targetTemperature: 22 }));
  expect(points[1].currentTemperature).toBeUndefined();
  expect(points[2]).toEqual(expect.objectContaining({ online: false }));
  expect(points[2].currentTemperature).toBeUndefined();
  expect(points[2].targetTemperature).toBeUndefined();
  await runtime.close();
  expect(runtime.manager.listenerCount(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION)).toBe(0);
  expect(runtime.manager.listenerCount(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE)).toBe(0);
  expect(runtime.manager.listenerCount(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE)).toBe(0);
});

test('expiry waits for an already running schedule read and then resumes once', async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12), doNotFake: ['setImmediate', 'nextTick'] });
  const { runtime, transport, overrideTransport } = await fixture();
  const response = await runtime.handle('/overrides/preview', { deviceId: 'room-a', temperature: 23, endsAt: Date.now() + 1000 });
  const plan = (response as unknown as { overridePreview: { id: string } }).overridePreview;
  await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
  await idle(runtime);
  const gate = deferred<void>();
  const started = deferred<void>();
  transport.read.mockImplementationOnce(async id => { started.resolve(); await gate.promise; return transport.snapshot(id); });
  await runtime.handle('/schedules/read', { deviceIds: ['room-a'] });
  await started.promise;
  jest.advanceTimersByTime(1000);
  expect(overrideTransport.resumeOverride).not.toHaveBeenCalled();
  expect(room(runtime).override?.status).toBe('active');
  gate.resolve();
  await idle(runtime);
  expect(overrideTransport.resumeOverride).toHaveBeenCalledTimes(1);
  expect(room(runtime).override?.status).toBe('completed');
});

test('clock moving backward does not end an override early', async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12), doNotFake: ['setImmediate', 'nextTick'] });
  const { runtime, overrideTransport } = await fixture();
  const response = await runtime.handle('/overrides/preview', { deviceId: 'room-a', temperature: 23, endsAt: Date.now() + 1000 });
  const plan = (response as unknown as { overridePreview: { id: string } }).overridePreview;
  await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
  await idle(runtime);
  jest.setSystemTime(Date.now() - 1000);
  jest.advanceTimersByTime(1000);
  await idle(runtime);
  expect(overrideTransport.resumeOverride).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  await idle(runtime);
  expect(overrideTransport.resumeOverride).toHaveBeenCalledTimes(1);
});

test('a failed resume persistence leaves visible recovery state and never sends a command', async () => {
  const { runtime, overrideTransport } = await fixture();
  const response = await runtime.handle('/overrides/preview', { deviceId: 'room-a', temperature: 23, endsAt: Date.now() + 3600000 });
  const plan = (response as unknown as { overridePreview: { id: string } }).overridePreview;
  await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
  await idle(runtime);
  jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk full before resume'));
  await runtime.handle('/overrides/cancel', { deviceId: 'room-a' });
  await idle(runtime);
  expect(overrideTransport.resumeOverride).not.toHaveBeenCalled();
  expect(room(runtime).override?.status).toBe('recovery-required');
  expect(room(runtime).override?.error).toContain('Disk full');
});


test('shutdown during prewrite persistence never issues Hold and retains explicit recovery state', async () => {
  const { runtime, overrideTransport } = await fixture();
  const response = await runtime.handle('/overrides/preview', { deviceId: 'room-a', temperature: 23, endsAt: Date.now() + 3600000 });
  const plan = (response as unknown as { overridePreview: { id: string } }).overridePreview;
  const originalRename = fs.rename.bind(fs);
  const gate = deferred<void>();
  const started = deferred<void>();
  jest.spyOn(fs, 'rename').mockImplementationOnce(async (oldPath, newPath) => {
    started.resolve(); await gate.promise; await originalRename(oldPath, newPath);
  });
  await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
  await started.promise;
  const closing = runtime.close();
  gate.resolve();
  await closing;
  expect(overrideTransport.startOverride).not.toHaveBeenCalled();
  expect(room(runtime).override?.status).toBe('recovery-required');
  expect((runtime as unknown as { overrideTimers: Map<string, unknown> }).overrideTimers.size).toBe(0);
});

test('failed expiry retains latest occupancy for the later explicit resume', async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12), doNotFake: ['setImmediate', 'nextTick'] });
  const { runtime, transport, overrideTransport } = await fixture();
  await configure(runtime, true);
  await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
  await runtime.handle('/presence', { home: true });
  await idle(runtime);
  const response = await runtime.handle('/overrides/preview', { deviceId: 'room-a', temperature: 23, endsAt: Date.now() + 1000 });
  const plan = (response as unknown as { overridePreview: { id: string } }).overridePreview;
  await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
  await idle(runtime);
  await runtime.handle('/presence', { home: false });
  overrideTransport.resumeOverride.mockRejectedValueOnce(new Error('Internet disconnected'));
  jest.advanceTimersByTime(1000);
  await idle(runtime);
  expect(transport.apply).toHaveBeenCalledTimes(1);
  expect(room(runtime).override?.status).toBe('recovery-required');
  await runtime.handle('/overrides/cancel', { deviceId: 'room-a' });
  await idle(runtime);
  expect(overrideTransport.resumeOverride).toHaveBeenCalledTimes(2);
  expect(transport.apply).toHaveBeenCalledTimes(2);
  expect(room(runtime).sync.confirmedProfile).toBe('away');
});

test('temperature history writes are batched and shutdown flushes the final genuine sample', async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12), doNotFake: ['setImmediate', 'nextTick'] });
  const { runtime, directory } = await fixture();
  const rename = jest.spyOn(fs, 'rename');
  await runtime.recordTemperature('room-a', { at: Date.now(), currentTemperature: 18, online: true, unit: 'c' });
  expect(rename).not.toHaveBeenCalled();
  jest.advanceTimersByTime(30000);
  await idle(runtime);
  expect(rename).toHaveBeenCalledTimes(1);
  await runtime.recordTemperature('room-a', { at: Date.now(), currentTemperature: 19, online: true, unit: 'c' });
  await runtime.close();
  expect(rename).toHaveBeenCalledTimes(2);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'TuyaThermostatProfiles.0123456789abcdef.json'), 'utf8'));
  expect(saved.history.devices['room-a'].temperatures).toHaveLength(2);
});

test('resuming a temporary temperature never retries an unrelated failed programme upload', async () => {
  const { runtime, transport } = await fixture();
  await configure(runtime, true);
  await runtime.handle('/controls/settings', { awayDelayMinutes: 0 });
  await runtime.handle('/presence', { home: true });
  await idle(runtime);
  transport.apply.mockResolvedValueOnce({ status: 'failed', backup: transport.snapshot('room-a'),
    planned: 0, applied: 0, error: 'The previous Away upload failed.' });
  await runtime.handle('/presence', { home: false });
  await idle(runtime);
  expect(runtime.state.devices['room-a'].status).toBe('failed');
  const response = await runtime.handle('/overrides/preview', { deviceId: 'room-a', temperature: 23, endsAt: Date.now() + 3600000 });
  const plan = (response as unknown as { overridePreview: { id: string } }).overridePreview;
  await runtime.handle('/overrides/start', { previewId: plan.id, acceptHostDependentExpiry: true });
  await idle(runtime);
  await runtime.handle('/overrides/cancel', { deviceId: 'room-a' });
  await idle(runtime);
  expect(transport.apply).toHaveBeenCalledTimes(2);
  expect(room(runtime).override?.status).toBe('completed');
  expect(room(runtime).sync.status).toBe('failed');
  expect(room(runtime).sync.error).toContain('previous Away upload failed');
});

test('a failed deadline save stops policy changes until explicit recovery', async () => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12), doNotFake: ['setImmediate', 'nextTick'] });
  const { runtime, transport } = await fixture();
  await configure(runtime, true);
  await runtime.handle('/presence', { home: true });
  await idle(runtime);
  await runtime.handle('/presence', { home: false });
  jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk temporarily unavailable'));
  jest.advanceTimersByTime(30 * 60000);
  await new Promise<void>(resolve => setImmediate(resolve));
  await idle(runtime);
  expect(runtime.view().controls.recoveryRequired).toContain('Disk temporarily unavailable');
  expect(transport.apply).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(60 * 60000);
  await idle(runtime);
  expect(transport.apply).toHaveBeenCalledTimes(1);
  await runtime.handle('/controls/recover', { confirm: true });
  await idle(runtime);
  expect(transport.apply).toHaveBeenCalledTimes(2);
  expect(room(runtime).sync.confirmedProfile).toBe('away');
});
