import { FASTWARM_SCHEDULE_DAYS, FastWarmScheduleEventId } from '../../src/device/schedule/FastWarmSchedule';
import {
  createThermostatProfilesState,
  prepareThermostatProfileApply,
  reduceThermostatProfiles,
  restoreThermostatProfilesState,
  selectThermostatProfile,
  ThermostatProfileId,
  ThermostatProfilesState,
  ThermostatWeeklyProgramme,
  validateThermostatWeeklyProgramme,
} from '../../src/device/schedule/ThermostatProfiles';

function programme(temperature: number): ThermostatWeeklyProgramme {
  return {
    days: FASTWARM_SCHEDULE_DAYS.map(day => ({
      day,
      events: [6, 8, 17, 22].map((hour, event) => ({ event: event as FastWarmScheduleEventId, hour, minute: 0, temperature })),
    })),
  };
}

function configuredState(): ThermostatProfilesState {
  let state = createThermostatProfilesState(['living-room', 'bedroom']);
  for (const deviceId of Object.keys(state.devices)) {
    for (const [profileId, temperature] of [['home', 20], ['away', 16], ['holiday', 10]] as const) {
      state = reduceThermostatProfiles(state, { type: 'set-programme', deviceId, profileId, programme: programme(temperature) });
    }
    state = reduceThermostatProfiles(state, { type: 'set-enabled', deviceId, enabled: true });
  }
  return reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: true });
}

function start(state: ThermostatProfilesState, operationId = 'operation-1', profileId?: ThermostatProfileId) {
  return reduceThermostatProfiles(state, { type: 'apply-started', deviceId: 'living-room', operationId, profileId });
}

function confirm(state: ThermostatProfilesState, temperature = 20, operationId = 'operation-1') {
  return reduceThermostatProfiles(state, {
    type: 'apply-confirmed', deviceId: 'living-room', operationId, programme: programme(temperature), confirmedAt: 1000,
  });
}

describe('validateThermostatWeeklyProgramme', () => {
  test('accepts four constant-temperature periods for a possible Holiday profile', () => {
    expect(validateThermostatWeeklyProgramme(programme(10))).toEqual(programme(10));
  });

  test('normalizes day and event order without requiring a codec complete flag', () => {
    const input = programme(20);
    input.days.reverse();
    input.days.forEach(day => day.events.reverse());
    expect(validateThermostatWeeklyProgramme(input)).toEqual(programme(20));
    expect(input.days[0].day).toBe(64);
    expect(input.days[0].events[0].event).toBe(3);
  });

  test('returns an independent copy', () => {
    const input = programme(20);
    const output = validateThermostatWeeklyProgramme(input);
    output.days[0].events[0].temperature = 5;
    expect(input.days[0].events[0].temperature).toBe(20);
  });

  test.each([undefined, null, {}, { days: [] }, { days: programme(20).days.slice(1) }])('rejects incomplete programme %j', input => {
    expect(() => validateThermostatWeeklyProgramme(input)).toThrow('all seven days');
  });

  test('rejects grouped or duplicate day records', () => {
    const grouped = programme(20);
    grouped.days[0].day = 3 as typeof grouped.days[0]['day'];
    expect(() => validateThermostatWeeklyProgramme(grouped)).toThrow('individual Monday-to-Sunday');
    const duplicate = programme(20);
    duplicate.days[0].day = 2;
    expect(() => validateThermostatWeeklyProgramme(duplicate)).toThrow('duplicate day');
  });

  test('rejects missing or duplicate event slots', () => {
    const missing = programme(20);
    missing.days[0].events.pop();
    expect(() => validateThermostatWeeklyProgramme(missing)).toThrow('all four events');
    const duplicate = programme(20);
    duplicate.days[0].events[3].event = 0;
    expect(() => validateThermostatWeeklyProgramme(duplicate)).toThrow('duplicate event ID');
  });

  test.each([6, 5])('rejects equal or reversed event times at hour %s', hour => {
    const input = programme(20);
    input.days[0].events[1].hour = hour;
    expect(() => validateThermostatWeeklyProgramme(input)).toThrow('in increasing time order');
  });

  test('allows events one minute apart', () => {
    const input = programme(20);
    input.days[0].events[1].hour = 6;
    input.days[0].events[1].minute = 1;
    expect(validateThermostatWeeklyProgramme(input)).toEqual(input);
  });

  test.each([4.5, 40.5, 19.1, NaN, Infinity])('rejects unsupported programme temperature %s', temperature => {
    expect(() => validateThermostatWeeklyProgramme(programme(temperature))).toThrow('0.5 degree steps');
  });

  test.each([5, 5.5, 39.5, 40])('accepts supported temperature %s', temperature => {
    expect(validateThermostatWeeklyProgramme(programme(temperature))).toEqual(programme(temperature));
  });
});

describe('profile selection and intent', () => {
  test.each([
    [null, false, null], [true, false, 'home'], [false, false, 'away'],
    [null, true, 'holiday'], [true, true, 'holiday'], [false, true, 'holiday'],
  ] as const)('selects %s occupancy with Holiday %s as %s', (anyoneHome, holiday, expected) => {
    expect(selectThermostatProfile(anyoneHome, holiday)).toBe(expected);
  });

  test('starts without fabricated programmes, occupancy or enabled devices', () => {
    const state = createThermostatProfilesState(['living-room']);
    expect(state.anyoneHome).toBeNull();
    expect(state.enabledDeviceIds).toEqual([]);
    expect(state.devices['living-room']).toEqual({
      programmes: {}, requestedProfile: null, confirmedProfile: null, confirmedProgramme: null, confirmedAt: null,
      inFlight: null, status: 'idle', error: null,
    });
  });

  test('registering a new device never enables it automatically', () => {
    const original = configuredState();
    const next = reduceThermostatProfiles(original, { type: 'register-device', deviceId: 'kitchen' });
    expect(next.enabledDeviceIds).not.toContain('kitchen');
    expect(next.devices.kitchen.requestedProfile).toBeNull();
    expect(original.devices.kitchen).toBeUndefined();
    expect(reduceThermostatProfiles(next, { type: 'register-device', deviceId: 'kitchen' })).toBe(next);
  });

  test('occupancy applies intent only to explicitly enabled devices', () => {
    const registered = createThermostatProfilesState(['living-room', 'bedroom']);
    const enabled = reduceThermostatProfiles(registered, { type: 'set-enabled', deviceId: 'living-room', enabled: true });
    const state = reduceThermostatProfiles(enabled, { type: 'occupancy', anyoneHome: false });
    expect(state.devices['living-room'].requestedProfile).toBe('away');
    expect(state.devices.bedroom.requestedProfile).toBeNull();
    expect(state.devices['living-room'].inFlight).toBeNull();
    expect(state.devices['living-room'].confirmedProfile).toBeNull();
  });

  test('records latest occupancy while Holiday takes priority, then restores the correct programme', () => {
    let state = configuredState();
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: true });
    state = reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: false });
    expect(state.anyoneHome).toBe(false);
    expect(state.devices['living-room'].requestedProfile).toBe('holiday');
    state = reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: true });
    expect(state.devices['living-room'].requestedProfile).toBe('holiday');
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: false });
    expect(state.devices['living-room'].requestedProfile).toBe('home');
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: true });
    state = reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: false });
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: false });
    expect(state.devices['living-room'].requestedProfile).toBe('away');
  });

  test('turning off Holiday with unknown occupancy requests no invented replacement', () => {
    let state = createThermostatProfilesState(['living-room']);
    state = reduceThermostatProfiles(state, { type: 'set-enabled', deviceId: 'living-room', enabled: true });
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: true });
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: false });
    expect(state.devices['living-room'].requestedProfile).toBeNull();
    expect(() => prepareThermostatProfileApply(state, 'living-room')).toThrow('establish occupancy');
  });

  test('enabling repeatedly cannot duplicate IDs, and disabling removes the request', () => {
    let state = configuredState();
    state = reduceThermostatProfiles(state, { type: 'set-enabled', deviceId: 'living-room', enabled: true });
    expect(state.enabledDeviceIds.filter(id => id === 'living-room')).toHaveLength(1);
    state = reduceThermostatProfiles(state, { type: 'set-enabled', deviceId: 'living-room', enabled: false });
    expect(state.devices['living-room'].requestedProfile).toBeNull();
    expect(() => prepareThermostatProfileApply(state, 'living-room')).toThrow('not enabled');
  });
});

describe('preparing and confirming profile application', () => {
  test('creates exactly 28 six-byte commands without starting an operation or modifying state', () => {
    const state = configuredState();
    const saved = JSON.stringify(state);
    const plan = prepareThermostatProfileApply(state, 'living-room');
    expect(plan.profileId).toBe('home');
    expect(plan.commands).toHaveLength(28);
    expect(plan.commands.every(command => command.code === 'week_program' && Buffer.from(command.value, 'base64').length === 6)).toBe(true);
    plan.programme.days[0].events[0].temperature = 5;
    expect(JSON.stringify(state)).toBe(saved);
    expect(state.devices['living-room'].inFlight).toBeNull();
  });

  test('refuses automatic application for disabled devices and never fabricates missing programmes', () => {
    let state = createThermostatProfilesState(['living-room']);
    expect(() => prepareThermostatProfileApply(state, 'living-room')).toThrow('not enabled');
    expect(() => prepareThermostatProfileApply(state, 'living-room', 'home')).toThrow('no saved home programme');
    state = reduceThermostatProfiles(state, { type: 'set-enabled', deviceId: 'living-room', enabled: true });
    expect(() => prepareThermostatProfileApply(state, 'living-room', 'home')).toThrow('no saved home programme');
  });

  test('allows an explicit manual profile on an unenrolled device without requiring the other programmes', () => {
    let state = createThermostatProfilesState(['living-room']);
    state = reduceThermostatProfiles(state, {
      type: 'set-programme', deviceId: 'living-room', profileId: 'away', programme: programme(16),
    });
    expect(prepareThermostatProfileApply(state, 'living-room', 'away').profileId).toBe('away');
    state = start(state, 'manual', 'away');
    expect(state.devices['living-room'].inFlight?.profileId).toBe('away');
    expect(state.devices['living-room'].requestedProfile).toBeNull();
    state = confirm(state, 16, 'manual');
    expect(state.devices['living-room'].confirmedProfile).toBe('away');
    expect(state.enabledDeviceIds).toEqual([]);
    expect(() => prepareThermostatProfileApply(state, 'living-room')).toThrow('not enabled');
  });

  test('keeps Home and Away programmes independent for each thermostat', () => {
    let state = configuredState();
    state = reduceThermostatProfiles(state, { type: 'set-programme', deviceId: 'bedroom', profileId: 'home', programme: programme(18) });
    expect(prepareThermostatProfileApply(state, 'living-room', 'home').programme).toEqual(programme(20));
    expect(prepareThermostatProfileApply(state, 'bedroom', 'home').programme).toEqual(programme(18));
    expect(prepareThermostatProfileApply(state, 'bedroom', 'away').programme).toEqual(programme(16));
  });

  test('does not claim a requested or started profile is confirmed until matching read-back arrives', () => {
    const requested = configuredState();
    expect(requested.devices['living-room'].requestedProfile).toBe('home');
    expect(requested.devices['living-room'].confirmedProfile).toBeNull();
    const applying = start(requested);
    expect(applying.devices['living-room'].status).toBe('applying');
    expect(applying.devices['living-room'].confirmedProfile).toBeNull();
    const confirmed = confirm(applying);
    expect(confirmed.devices['living-room'].confirmedProfile).toBe('home');
    expect(confirmed.devices['living-room'].confirmedAt).toBe(1000);
    expect(confirmed.devices['living-room'].status).toBe('confirmed');
    expect(confirmed.devices['living-room'].inFlight).toBeNull();
  });

  test('refuses overlapping operations and ignores stale completion/failure messages', () => {
    const state = start(configuredState());
    expect(() => start(state, 'operation-2')).toThrow('already has an application');
    expect(confirm(state, 20, 'old-operation')).toBe(state);
    expect(reduceThermostatProfiles(state, {
      type: 'apply-failed', deviceId: 'living-room', operationId: 'old-operation', error: 'Late timeout', mayHaveChangedDevice: true,
    })).toBe(state);
  });

  test('a late Home confirmation cannot claim the newly requested Away profile succeeded', () => {
    let state = start(configuredState());
    state = reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: false });
    state = confirm(state);
    expect(state.devices['living-room'].requestedProfile).toBe('away');
    expect(state.devices['living-room'].confirmedProfile).toBe('home');
    expect(state.devices['living-room'].status).toBe('pending');
    expect(state.devices['living-room'].inFlight).toBeNull();
  });

  test('editing a saved programme during an operation does not alter its captured programme', () => {
    let state = start(configuredState());
    state = reduceThermostatProfiles(state, {
      type: 'set-programme', deviceId: 'living-room', profileId: 'home', programme: programme(21),
    });
    state = confirm(state, 20);
    expect(state.devices['living-room'].confirmedProgramme).toEqual(programme(20));
    expect(state.devices['living-room'].programmes.home).toEqual(programme(21));
    expect(state.devices['living-room'].status).toBe('pending');
  });

  test('manual application captures the explicit profile without falsifying occupancy or global intent', () => {
    let state = start(configuredState(), 'manual', 'away');
    expect(state.anyoneHome).toBe(true);
    expect(state.holiday).toBe(false);
    expect(state.devices['living-room'].requestedProfile).toBe('home');
    expect(state.devices['living-room'].inFlight?.profileId).toBe('away');
    state = confirm(state, 16, 'manual');
    expect(state.devices['living-room'].confirmedProfile).toBe('away');
    expect(state.devices['living-room'].requestedProfile).toBe('home');
    expect(state.devices['living-room'].status).toBe('pending');
  });

  test('read-back must contain the exact complete programme', () => {
    const state = start(configuredState());
    expect(() => confirm(state, 21)).toThrow('does not match');
    expect(state.devices['living-room'].confirmedProfile).toBeNull();
    const incomplete = programme(20);
    incomplete.days.pop();
    expect(() => reduceThermostatProfiles(state, {
      type: 'apply-confirmed', deviceId: 'living-room', operationId: 'operation-1', programme: incomplete, confirmedAt: 1000,
    })).toThrow('all seven days');
  });

  test('partial failure invalidates the previous full confirmation', () => {
    let state = confirm(start(configuredState()));
    state = reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: false });
    state = start(state, 'away-operation');
    state = reduceThermostatProfiles(state, {
      type: 'apply-failed', deviceId: 'living-room', operationId: 'away-operation', error: 'Internet disconnected', mayHaveChangedDevice: true,
    });
    expect(state.devices['living-room'].status).toBe('partial');
    expect(state.devices['living-room'].confirmedProfile).toBeNull();
    expect(state.devices['living-room'].confirmedProgramme).toBeNull();
    expect(state.devices['living-room'].error).toBe('Internet disconnected');
  });

  test('failure before any device changes can retain the existing confirmation', () => {
    let state = confirm(start(configuredState()));
    state = start(state, 'no-write');
    state = reduceThermostatProfiles(state, {
      type: 'apply-failed', deviceId: 'living-room', operationId: 'no-write', error: 'Not connected', mayHaveChangedDevice: false,
    });
    expect(state.devices['living-room'].status).toBe('failed');
    expect(state.devices['living-room'].confirmedProfile).toBe('home');
  });

  test('occupancy changes during Holiday retain a failed Holiday operation until the request changes or is retried', () => {
    let state = configuredState();
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: true });
    state = start(state);
    state = reduceThermostatProfiles(state, {
      type: 'apply-failed', deviceId: 'living-room', operationId: 'operation-1', error: 'Partial Holiday upload', mayHaveChangedDevice: true,
    });
    state = reduceThermostatProfiles(state, { type: 'occupancy', anyoneHome: false });
    expect(state.devices['living-room'].requestedProfile).toBe('holiday');
    expect(state.devices['living-room'].status).toBe('partial');
    expect(state.devices['living-room'].error).toBe('Partial Holiday upload');
    state = reduceThermostatProfiles(state, {
      type: 'set-programme', deviceId: 'living-room', profileId: 'holiday', programme: programme(11),
    });
    expect(state.devices['living-room'].status).toBe('pending');
    expect(state.devices['living-room'].error).toBeNull();
  });
});

describe('persisted state restoration', () => {
  test('round-trips JSON programmes and selection without resuming operations or claiming stale confirmation', () => {
    let state = confirm(start(configuredState()));
    state = reduceThermostatProfiles(state, { type: 'holiday', enabled: true });
    state = start(state, 'holiday-operation');
    const restored = restoreThermostatProfilesState(JSON.parse(JSON.stringify(state)));
    expect(restored.anyoneHome).toBe(true);
    expect(restored.holiday).toBe(true);
    expect(restored.enabledDeviceIds).toEqual(state.enabledDeviceIds);
    expect(restored.devices['living-room'].programmes).toEqual(state.devices['living-room'].programmes);
    expect(restored.devices['living-room'].requestedProfile).toBe('holiday');
    expect(restored.devices['living-room'].confirmedProfile).toBeNull();
    expect(restored.devices['living-room'].inFlight).toBeNull();
    expect(restored.devices['living-room'].status).toBe('idle');
    expect(confirm(restored, 10, 'holiday-operation')).toBe(restored);
  });

  test('does not enable merely registered devices on restoration', () => {
    const restored = restoreThermostatProfilesState(JSON.parse(JSON.stringify(createThermostatProfilesState(['kitchen']))));
    expect(restored.enabledDeviceIds).toEqual([]);
    expect(restored.devices.kitchen.programmes).toEqual({});
    expect(restored.devices.kitchen.requestedProfile).toBeNull();
  });

  test.each([null, {}, { version: 2 }, { version: 1, devices: {}, anyoneHome: 'yes', holiday: false, enabledDeviceIds: [] }])(
    'rejects invalid persistence envelope %j', value => {
      expect(() => restoreThermostatProfilesState(value)).toThrow('Invalid persisted');
    },
  );

  test('rejects enabled IDs not present in the registered device list', () => {
    const state = createThermostatProfilesState();
    state.enabledDeviceIds.push('unknown');
    expect(() => restoreThermostatProfilesState(state)).toThrow('Unknown thermostat');
  });

  test('validates saved programmes rather than trusting a persisted completeness claim', () => {
    const state = configuredState();
    state.devices['living-room'].programmes.home!.days[0].events.pop();
    expect(() => restoreThermostatProfilesState(state)).toThrow('all four events');
  });
});
