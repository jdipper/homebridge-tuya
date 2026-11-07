import {
  encodeFastWarmSchedule,
  FASTWARM_SCHEDULE_DAYS,
  FastWarmScheduleDay,
  FastWarmScheduleEvent,
} from './FastWarmSchedule';

export type ThermostatProfileId = 'home' | 'away' | 'holiday';

export interface ThermostatWeeklyProgramme {
  days: { day: FastWarmScheduleDay; events: FastWarmScheduleEvent[] }[];
}

export interface ThermostatProfileApplyPlan {
  deviceId: string;
  profileId: ThermostatProfileId;
  programme: ThermostatWeeklyProgramme;
  /** Individually supported DP119 event updates, rather than an unverified full-day write. */
  commands: { code: 'week_program'; value: string }[];
}

export interface ThermostatProfileDeviceState {
  programmes: Partial<Record<ThermostatProfileId, ThermostatWeeklyProgramme>>;
  requestedProfile: ThermostatProfileId | null;
  confirmedProfile: ThermostatProfileId | null;
  confirmedProgramme: ThermostatWeeklyProgramme | null;
  confirmedAt: number | null;
  inFlight: { operationId: string; profileId: ThermostatProfileId; programme: ThermostatWeeklyProgramme } | null;
  status: 'idle' | 'pending' | 'applying' | 'confirmed' | 'partial' | 'failed';
  error: string | null;
}

/** Plain JSON data; restoring this state never resumes a write operation. */
export interface ThermostatProfilesState {
  version: 1;
  anyoneHome: boolean | null;
  holiday: boolean;
  enabledDeviceIds: string[];
  devices: Record<string, ThermostatProfileDeviceState>;
}

export type ThermostatProfilesAction =
  | { type: 'register-device'; deviceId: string }
  | { type: 'set-enabled'; deviceId: string; enabled: boolean }
  | { type: 'set-programme'; deviceId: string; profileId: ThermostatProfileId; programme: ThermostatWeeklyProgramme }
  | { type: 'occupancy'; anyoneHome: boolean }
  | { type: 'holiday'; enabled: boolean }
  | { type: 'apply-started'; deviceId: string; operationId: string; profileId?: ThermostatProfileId }
  | { type: 'apply-confirmed'; deviceId: string; operationId: string; programme: ThermostatWeeklyProgramme; confirmedAt: number }
  | { type: 'programme-verified'; deviceId: string; profileId: ThermostatProfileId;
    programme: ThermostatWeeklyProgramme; confirmedAt: number }
  | { type: 'apply-failed'; deviceId: string; operationId: string; error: string; mayHaveChangedDevice: boolean };

const PROFILE_IDS: readonly ThermostatProfileId[] = ['home', 'away', 'holiday'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDeviceId(deviceId: string) {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new Error('A thermostat device ID is required.');
  }
}

function validateProfileId(profileId: ThermostatProfileId) {
  if (!PROFILE_IDS.includes(profileId)) {
    throw new Error('Thermostat profile must be home, away or holiday.');
  }
}

/** Validate all 28 slots and return a normalized independent copy. Missing programmes are never synthesized. */
export function validateThermostatWeeklyProgramme(value: unknown): ThermostatWeeklyProgramme {
  if (!isRecord(value) || !Array.isArray(value.days) || value.days.length !== 7) {
    throw new Error('A thermostat programme must contain all seven days and four events per day.');
  }
  const seen = new Set<number>();
  const days = value.days.map(source => {
    if (!isRecord(source) || !FASTWARM_SCHEDULE_DAYS.includes(source.day as FastWarmScheduleDay)) {
      throw new Error('Programme days must be individual Monday-to-Sunday bitmap values: 1, 2, 4, 8, 16, 32, 64.');
    }
    const day = source.day as FastWarmScheduleDay;
    if (seen.has(day)) {
      throw new Error(`Thermostat programme contains duplicate day ${day}.`);
    }
    seen.add(day);
    if (!Array.isArray(source.events) || source.events.length !== 4) {
      throw new Error(`Thermostat programme day ${day} must contain all four events.`);
    }
    const events = source.events.map(item => {
      if (!isRecord(item)) {
        throw new Error(`Thermostat programme day ${day} contains an invalid event.`);
      }
      return {
        event: item.event,
        hour: item.hour,
        minute: item.minute,
        temperature: item.temperature,
      } as FastWarmScheduleEvent;
    });
    // Reuse the wire codec's event IDs, bounds, duplicate IDs and Celsius half-degree validation.
    encodeFastWarmSchedule({ dayMask: day, events });
    events.sort((a, b) => a.event - b.event);
    for (let index = 1; index < events.length; index++) {
      const previous = events[index - 1];
      const current = events[index];
      if (current.hour * 60 + current.minute <= previous.hour * 60 + previous.minute) {
        throw new Error(`Thermostat programme day ${day} must have Wake, Leave, Return and Sleep in increasing time order.`);
      }
    }
    return { day, events };
  });
  days.sort((a, b) => a.day - b.day);
  return { days };
}

/** Holiday overrides occupancy, but unknown occupancy cannot silently choose Home or Away. */
export function selectThermostatProfile(anyoneHome: boolean | null, holiday: boolean): ThermostatProfileId | null {
  return holiday ? 'holiday' : anyoneHome === null ? null : anyoneHome ? 'home' : 'away';
}

function emptyDevice(): ThermostatProfileDeviceState {
  return {
    programmes: {}, requestedProfile: null, confirmedProfile: null, confirmedProgramme: null, confirmedAt: null,
    inFlight: null, status: 'idle', error: null,
  };
}

export function createThermostatProfilesState(deviceIds: readonly string[] = []): ThermostatProfilesState {
  const devices = Object.fromEntries(deviceIds.map(deviceId => {
    validateDeviceId(deviceId);
    return [deviceId, emptyDevice()];
  }));
  return { version: 1, anyoneHome: null, holiday: false, enabledDeviceIds: [], devices };
}

function getDevice(state: ThermostatProfilesState, deviceId: string): ThermostatProfileDeviceState {
  if (!Object.prototype.hasOwnProperty.call(state.devices, deviceId)) {
    throw new Error(`Unknown thermostat device ${deviceId}.`);
  }
  return state.devices[deviceId];
}

function sameProgramme(a: ThermostatWeeklyProgramme | null, b: ThermostatWeeklyProgramme | undefined): boolean {
  return a !== null && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function withRequestedProfile(
  device: ThermostatProfileDeviceState,
  requestedProfile: ThermostatProfileId | null,
  resetFailure = false,
) {
  const confirmed = requestedProfile !== null && requestedProfile === device.confirmedProfile
    && sameProgramme(device.confirmedProgramme, device.programmes[requestedProfile]);
  const retainFailure = !resetFailure && requestedProfile === device.requestedProfile
    && (device.status === 'partial' || device.status === 'failed');
  return {
    ...device,
    requestedProfile,
    status: device.inFlight ? 'applying' as const : requestedProfile === null ? 'idle' as const
      : retainFailure ? device.status : confirmed ? 'confirmed' as const : 'pending' as const,
    error: retainFailure ? device.error : null,
  };
}

function refreshRequestedProfiles(state: ThermostatProfilesState): ThermostatProfilesState {
  const requested = selectThermostatProfile(state.anyoneHome, state.holiday);
  const devices = Object.fromEntries(Object.entries(state.devices).map(([deviceId, device]) => [
    deviceId, withRequestedProfile(device, state.enabledDeviceIds.includes(deviceId) ? requested : null),
  ]));
  return { ...state, devices };
}

function replaceDevice(state: ThermostatProfilesState, deviceId: string, device: ThermostatProfileDeviceState) {
  return { ...state, devices: { ...state.devices, [deviceId]: device } };
}

/**
 * Build a plan only when explicitly called. No timers, networking, startup/reconnect application or device mode changes occur here.
 * An explicit profileId supports manually applying a saved programme without automatic-profile enrollment
 * or changing the stored occupancy/Holiday intent.
 */
export function prepareThermostatProfileApply(
  state: ThermostatProfilesState,
  deviceId: string,
  profileId?: ThermostatProfileId,
): ThermostatProfileApplyPlan {
  const device = getDevice(state, deviceId);
  if (profileId === undefined && !state.enabledDeviceIds.includes(deviceId)) {
    throw new Error(`Thermostat ${deviceId} is not enabled for profile application.`);
  }
  if (device.inFlight) {
    throw new Error(`Thermostat ${deviceId} already has an application in progress.`);
  }
  const selected = profileId ?? device.requestedProfile;
  if (selected === null) {
    throw new Error('Select a profile or establish occupancy before applying a thermostat programme.');
  }
  validateProfileId(selected);
  const saved = device.programmes[selected];
  if (!saved) {
    throw new Error(`Thermostat ${deviceId} has no saved ${selected} programme.`);
  }
  const programme = validateThermostatWeeklyProgramme(saved);
  const commands = programme.days.flatMap(day => day.events.map(event => ({
    code: 'week_program' as const,
    value: encodeFastWarmSchedule({ dayMask: day.day, events: [event] }),
  })));
  return { deviceId, profileId: selected, programme, commands };
}

/** Intent changes and operation results only. The runtime must explicitly decide when to send a prepared plan. */
export function reduceThermostatProfiles(state: ThermostatProfilesState, action: ThermostatProfilesAction): ThermostatProfilesState {
  switch (action.type) {
    case 'register-device': {
      validateDeviceId(action.deviceId);
      return Object.prototype.hasOwnProperty.call(state.devices, action.deviceId)
        ? state : replaceDevice(state, action.deviceId, emptyDevice());
    }
    case 'set-enabled': {
      getDevice(state, action.deviceId);
      const enabledDeviceIds = state.enabledDeviceIds.filter(id => id !== action.deviceId);
      if (action.enabled) {
        enabledDeviceIds.push(action.deviceId);
      }
      return refreshRequestedProfiles({ ...state, enabledDeviceIds });
    }
    case 'set-programme': {
      validateProfileId(action.profileId);
      const device = getDevice(state, action.deviceId);
      const programmes = { ...device.programmes, [action.profileId]: validateThermostatWeeklyProgramme(action.programme) };
      return replaceDevice(state, action.deviceId, withRequestedProfile({ ...device, programmes }, device.requestedProfile, true));
    }
    case 'occupancy':
      return refreshRequestedProfiles({ ...state, anyoneHome: action.anyoneHome });
    case 'holiday':
      return refreshRequestedProfiles({ ...state, holiday: action.enabled });
    case 'apply-started': {
      if (typeof action.operationId !== 'string' || !action.operationId.trim()) {
        throw new Error('A thermostat application operation ID is required.');
      }
      const plan = prepareThermostatProfileApply(state, action.deviceId, action.profileId);
      const device = getDevice(state, action.deviceId);
      return replaceDevice(state, action.deviceId, {
        ...device,
        inFlight: { operationId: action.operationId, profileId: plan.profileId, programme: plan.programme },
        status: 'applying', error: null,
      });
    }
    case 'apply-confirmed': {
      const device = getDevice(state, action.deviceId);
      if (device.inFlight?.operationId !== action.operationId) {
        return state;
      }
      const programme = validateThermostatWeeklyProgramme(action.programme);
      if (!sameProgramme(programme, device.inFlight.programme)) {
        throw new Error('Thermostat read-back programme does not match the application in progress.');
      }
      if (!Number.isSafeInteger(action.confirmedAt) || action.confirmedAt < 0) {
        throw new Error('Thermostat confirmation time must be a non-negative integer timestamp.');
      }
      return replaceDevice(state, action.deviceId, withRequestedProfile({
        ...device,
        confirmedProfile: device.inFlight.profileId, confirmedProgramme: programme, confirmedAt: action.confirmedAt,
        inFlight: null,
      }, device.requestedProfile));
    }
    case 'apply-failed': {
      const device = getDevice(state, action.deviceId);
      if (device.inFlight?.operationId !== action.operationId) {
        return state;
      }
      return replaceDevice(state, action.deviceId, {
        ...device,
        ...(action.mayHaveChangedDevice ? { confirmedProfile: null, confirmedProgramme: null, confirmedAt: null } : {}),
        inFlight: null, status: action.mayHaveChangedDevice ? 'partial' : 'failed', error: action.error,
      });
    }
    case 'programme-verified': {
      const device = getDevice(state, action.deviceId);
      validateProfileId(action.profileId);
      const programme = validateThermostatWeeklyProgramme(action.programme);
      if (device.inFlight || !sameProgramme(programme, device.programmes[action.profileId])) {
        throw new Error('The saved programme changed or an upload is in progress. Verify it again.');
      }
      if (!Number.isSafeInteger(action.confirmedAt) || action.confirmedAt < 0) {
        throw new Error('Thermostat confirmation time must be a non-negative integer timestamp.');
      }
      return replaceDevice(state, action.deviceId, withRequestedProfile({
        ...device, confirmedProfile: action.profileId, confirmedProgramme: programme,
        confirmedAt: action.confirmedAt, error: null, status: 'idle',
      }, device.requestedProfile, true));
    }
  }
}

/** Validate persisted settings and programmes, retaining intent but making no claim about current device state. */
export function restoreThermostatProfilesState(value: unknown): ThermostatProfilesState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.devices) || !Array.isArray(value.enabledDeviceIds)
    || (value.anyoneHome !== null && typeof value.anyoneHome !== 'boolean') || typeof value.holiday !== 'boolean') {
    throw new Error('Invalid persisted thermostat profiles state (expected version 1).');
  }
  let state = createThermostatProfilesState(Object.keys(value.devices));
  for (const [deviceId, source] of Object.entries(value.devices)) {
    if (!isRecord(source) || !isRecord(source.programmes)) {
      throw new Error(`Invalid persisted programmes for thermostat ${deviceId}.`);
    }
    const programmes: ThermostatProfileDeviceState['programmes'] = {};
    for (const [profileId, programme] of Object.entries(source.programmes)) {
      validateProfileId(profileId as ThermostatProfileId);
      programmes[profileId as ThermostatProfileId] = validateThermostatWeeklyProgramme(programme);
    }
    state = replaceDevice(state, deviceId, { ...emptyDevice(), programmes });
  }
  const enabledDeviceIds = [...new Set(value.enabledDeviceIds.map(deviceId => {
    validateDeviceId(deviceId as string);
    getDevice(state, deviceId as string);
    return deviceId as string;
  }))];
  state = refreshRequestedProfiles({ ...state, anyoneHome: value.anyoneHome, holiday: value.holiday, enabledDeviceIds });
  // A persisted operation must never resume implicitly, and its former confirmation may now be stale.
  return {
    ...state,
    devices: Object.fromEntries(Object.entries(state.devices).map(([deviceId, device]) => [deviceId, { ...device, status: 'idle' }])),
  };
}
