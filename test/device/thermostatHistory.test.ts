import ThermostatHistory, { ThermostatHistoryState } from '../../src/device/schedule/ThermostatHistory';
import { FASTWARM_SCHEDULE_DAYS } from '../../src/device/schedule/FastWarmSchedule';
import { ThermostatWeeklyProgramme } from '../../src/device/schedule/ThermostatProfiles';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 7, 12);

function programme(temperature = 20): ThermostatWeeklyProgramme {
  return { days: FASTWARM_SCHEDULE_DAYS.map(day => ({ day, events: [
    { event: 0, hour: 6, minute: 0, temperature },
    { event: 1, hour: 8, minute: 30, temperature: 16 },
    { event: 2, hour: 17, minute: 0, temperature },
    { event: 3, hour: 22, minute: 0, temperature: 12 },
  ] })) };
}

describe('local observed temperature history', () => {
  let now: number;
  let history: ThermostatHistory;

  beforeEach(() => {
    now = NOW;
    history = new ThermostatHistory({ now: () => now });
  });

  test('keeps reception and device timestamps separate and never fabricates repeated measurements', () => {
    expect(history.ingestTemperature('room', {
      at: NOW - 1000, sourceAt: NOW - 5000, online: true, unit: 'c', currentTemperature: 19.5, targetTemperature: 20,
    })).toBe(true);
    expect(history.ingestTemperature('room', {
      at: NOW, sourceAt: NOW - 2000, online: true, unit: 'c', currentTemperature: 19.5, targetTemperature: 20,
    })).toBe(false);
    expect(history.temperatureHistory('room')).toEqual([
      { at: NOW - 1000, sourceAt: NOW - 5000, online: true, currentTemperature: 19.5, targetTemperature: 20 },
    ]);
    now += HOUR;
    expect(history.temperatureHistory('room')).toHaveLength(1);
    expect(history.snapshot().devices.room.temperatures).toHaveLength(1);
  });

  test('records only changed values, with no carry-forward of an earlier measurement', () => {
    history.ingestTemperature('room', { at: NOW - 500, online: true, unit: 'c', currentTemperature: 18, targetTemperature: 20 });
    history.ingestTemperature('room', { at: NOW, online: true, unit: 'c', currentTemperature: 18, targetTemperature: 21 });
    expect(history.temperatureHistory('room')[1]).toEqual({ at: NOW, online: true, targetTemperature: 21 });
    history.ingestTemperature('room', { at: NOW + 1, online: false, unit: 'c', currentTemperature: 18, targetTemperature: 21 });
    expect(history.temperatureHistory('room')[2]).toEqual({ at: NOW + 1, online: false });
  });

  test('retains genuine steady readings at five-minute cadence but creates no samples when reports stop', () => {
    const start = NOW - 12 * HOUR;
    for (let minute = 0; minute <= 12 * 60; minute++) {
      history.ingestTemperature('room', {
        at: start + minute * 60000, sourceAt: start + minute * 60000 - 1000,
        online: true, unit: 'c', currentTemperature: 18,
      });
    }
    const points = history.temperatureHistory('room');
    expect(points).toHaveLength(145);
    expect(points.every(point => point.currentTemperature === 18)).toBe(true);
    expect(points[144]).toMatchObject({ at: NOW, sourceAt: NOW - 1000 });
    now += 2 * HOUR;
    expect(history.temperatureHistory('room')).toEqual(points);
    // Receiving an unchanged cloud shadow timestamp later is still the same original measurement.
    expect(history.ingestTemperature('room', {
      at: now, sourceAt: NOW - 1000, online: true, unit: 'c', currentTemperature: 18,
    })).toBe(false);
    expect(history.temperatureHistory('room')).toEqual(points);
  });

  test('orders delayed measurements by source time while retaining their actual reception times', () => {
    history.ingestTemperature('room', { at: NOW - 2000, online: false });
    history.ingestTemperature('room', { at: NOW, sourceAt: NOW - 60000, online: true, unit: 'c', currentTemperature: 18 });
    expect(history.temperatureHistory('room')).toEqual([
      { at: NOW, sourceAt: NOW - 60000, online: true, currentTemperature: 18 },
      { at: NOW - 2000, online: false },
    ]);
  });

  test('does not guess unknown measurement time or verified Celsius from cached/Fahrenheit values', () => {
    history.ingestTemperature('unknown', { at: NOW, online: true, currentTemperature: 68, targetTemperature: 70 });
    history.ingestTemperature('fahrenheit', { at: NOW, online: true, unit: 'f', currentTemperature: 68, targetTemperature: 70 });
    expect(history.temperatureHistory('unknown')).toEqual([{ at: NOW, online: true }]);
    expect(history.temperatureHistory('fahrenheit')).toEqual([{ at: NOW, online: true }]);
    history.ingestTemperature('room', { at: NOW, online: true, unit: 'c', currentTemperature: 18 });
    expect(history.temperatureHistory('room')[0]).toEqual({ at: NOW, online: true, currentTemperature: 18 });
    expect(history.temperatureHistory('room')[0]).not.toHaveProperty('sourceAt');
  });

  test.each([NaN, Infinity, -41, 101])('drops invalid current temperature %s without losing online state', value => {
    history.ingestTemperature('room', { at: NOW, online: true, unit: 'c', currentTemperature: value, targetTemperature: 20 });
    expect(history.temperatureHistory('room')).toEqual([{ at: NOW, online: true, targetTemperature: 20 }]);
  });

  test.each([NaN, Infinity, 4.9, 40.1])('drops invalid target temperature %s', value => {
    history.ingestTemperature('room', { at: NOW, online: true, unit: 'c', currentTemperature: 18, targetTemperature: value });
    expect(history.temperatureHistory('room')).toEqual([{ at: NOW, online: true, currentTemperature: 18 }]);
  });

  test('rejects malformed/future and out-of-order timestamps, and older source values do not replace newer reports', () => {
    expect(history.ingestTemperature('room', { at: NaN, online: true, unit: 'c', currentTemperature: 18 })).toBe(false);
    expect(history.ingestTemperature('room', { at: NOW + HOUR, online: true, unit: 'c', currentTemperature: 18 })).toBe(false);
    expect(history.ingestTemperature('room', {
      at: NOW, sourceAt: NOW + HOUR, online: true, unit: 'c', currentTemperature: 18,
    })).toBe(false);
    history.ingestTemperature('room', { at: NOW, sourceAt: NOW - 100, online: true, unit: 'c', currentTemperature: 18 });
    expect(history.ingestTemperature('room', {
      at: NOW - 1, online: true, unit: 'c', currentTemperature: 19,
    })).toBe(false);
    expect(history.ingestTemperature('room', {
      at: NOW + 1, sourceAt: NOW - 200, online: true, unit: 'c', currentTemperature: 19,
    })).toBe(false);
    expect(history.temperatureHistory('room')).toHaveLength(1);
  });

  test('expires measurements using their source time, rather than treating delayed reports as new', () => {
    history.ingestTemperature('room', {
      at: NOW, sourceAt: NOW - 31 * 24 * HOUR, online: true, unit: 'c', currentTemperature: 18,
    });
    expect(history.temperatureHistory('room')).toEqual([{ at: NOW, online: true }]);
    now += 31 * 24 * HOUR;
    expect(history.temperatureHistory('room')).toEqual([]);
  });

  test('downsamples old observations by hour without merging measurements from different reports', () => {
    const start = NOW - 2 * 24 * HOUR;
    history.ingestTemperature('room', { at: start, online: true, unit: 'c', currentTemperature: 18 });
    history.ingestTemperature('room', { at: start + 60000, online: true, unit: 'c', currentTemperature: 19 });
    history.ingestTemperature('room', { at: start + 120000, online: true, unit: 'c', targetTemperature: 20 });
    expect(history.temperatureHistory('room', 72)).toEqual([
      { at: start + 60000, online: true, currentTemperature: 19 },
      { at: start + 120000, online: true, targetTemperature: 20 },
    ]);
  });

  test('limits dense recent history and returns independent copies', () => {
    for (let index = 0; index < 1510; index++) {
      history.ingestTemperature('room', { at: NOW - 2000 + index, online: true, unit: 'c', currentTemperature: 18 + index % 2 });
    }
    const points = history.temperatureHistory('room');
    expect(points).toHaveLength(1500);
    points[0].currentTemperature = 99;
    history.snapshot().devices.room.temperatures[0].online = false;
    expect(history.temperatureHistory('room')[0]).toMatchObject({ currentTemperature: 18, online: true });
  });

  test.each([0, -1, 721, NaN, Infinity])('rejects invalid query period %s', hours => {
    expect(() => history.temperatureHistory('room', hours)).toThrow('720 hours');
  });
});

describe('immutable programme version history', () => {
  let history: ThermostatHistory;

  beforeEach(() => {
    history = new ThermostatHistory({ now: () => NOW });
  });

  test('stores complete saved drafts and native reads with stable distinct identities', () => {
    const draft = history.recordProgramme('room', { programme: programme(), source: 'draft', profile: 'home' });
    const native = history.recordProgramme('room', { programme: programme(), source: 'native' });
    expect(draft).toMatchObject({ at: NOW, source: 'draft', profile: 'home', programme: programme() });
    expect(native).toMatchObject({ at: NOW, source: 'native', programme: programme() });
    expect(native.id).not.toBe(draft.id);
    expect(history.programmeHistory('room')).toEqual([native, draft]);
  });

  test('deduplicates repeat reads and same-profile saves while retaining deliberate changes and returns', () => {
    const first = history.recordProgramme('room', { programme: programme(), source: 'native' });
    history.recordProgramme('room', { programme: programme(21), source: 'draft', profile: 'home' });
    expect(history.recordProgramme('room', { programme: programme(), source: 'native' }).id).toBe(first.id);
    const changed = history.recordProgramme('room', { programme: programme(21), source: 'native' });
    expect(changed.id).not.toBe(first.id);
    const returned = history.recordProgramme('room', { programme: programme(), source: 'native' });
    expect(returned.id).not.toBe(first.id);
    expect(history.programmeHistory('room')).toHaveLength(4);
    history.recordProgramme('room', { programme: programme(), source: 'draft', profile: 'holiday' });
    expect(history.programmeHistory('room')).toHaveLength(5);
  });

  test('version lookup is read-only and a caller can restore only a validated independent draft copy', () => {
    const input = programme();
    const saved = history.recordProgramme('room', { programme: input, source: 'draft', profile: 'home' });
    input.days[0].events[0].temperature = 5;
    saved.programme.days[0].events[0].temperature = 6;
    const version = history.getProgrammeVersion('room', saved.id)!;
    expect(version.programme.days[0].events[0].temperature).toBe(20);
    version.programme.days[0].events[0].temperature = 7;
    history.programmeHistory('room')[0].programme.days[0].events[0].temperature = 8;
    history.snapshot().devices.room.programmes[0].programme.days[0].events[0].temperature = 9;
    expect(history.getProgrammeVersion('room', saved.id)!.programme).toEqual(programme());
    expect(history.getProgrammeVersion('different-room', saved.id)).toBeUndefined();
    expect(history.getProgrammeVersion('room', 'missing')).toBeUndefined();
  });

  test('rejects incomplete or invalid programmes, unknown profiles and timestamps', () => {
    expect(() => history.recordProgramme('room', { programme: { days: [] }, source: 'native' })).toThrow('all seven days');
    const invalid = programme();
    invalid.days[0].events[1].hour = 5;
    expect(() => history.recordProgramme('room', { programme: invalid, source: 'native' })).toThrow('in increasing time order');
    expect(() => history.recordProgramme('room', { programme: programme(), source: 'draft' })).toThrow('valid time');
    expect(() => history.recordProgramme('room', { programme: programme(), source: 'native', at: NaN })).toThrow('valid time');
  });

  test('retains the newest fifty versions per device', () => {
    const ids: string[] = [];
    for (let index = 0; index < 55; index++) {
      ids.push(history.recordProgramme('room', { programme: programme(20 + index % 2), source: 'native', at: NOW - 100 + index }).id);
    }
    const versions = history.programmeHistory('room');
    expect(versions).toHaveLength(50);
    expect(versions[0].id).toBe(ids[54]);
    expect(history.getProgrammeVersion('room', ids[4])).toBeUndefined();
    expect(history.getProgrammeVersion('room', ids[5])).toBeDefined();
  });
});

describe('history persistence validation and resource bounds', () => {
  test('round trips a copy without creating timestamps, samples or programme versions', () => {
    const original = new ThermostatHistory({ now: () => NOW });
    original.ingestTemperature('room', { at: NOW - 100, online: true, unit: 'c', currentTemperature: 18 });
    original.recordProgramme('room', { source: 'native', programme: programme() });
    const saved = original.snapshot();
    const restored = new ThermostatHistory({ now: () => NOW + HOUR });
    restored.restore(JSON.parse(JSON.stringify(saved)));
    expect(restored.snapshot()).toEqual(saved);
    saved.devices.room.temperatures[0].currentTemperature = 40;
    expect(restored.temperatureHistory('room')[0].currentTemperature).toBe(18);
  });

  test.each([undefined, null, {}, { version: 0 }, { version: 2, devices: {} }, { version: 1, devices: [] }])(
    'ignores absent, legacy or unknown schemas without inventing historic measurements: %p', value => {
      const history = new ThermostatHistory({ now: () => NOW });
      history.ingestTemperature('room', { at: NOW, online: true, unit: 'c', currentTemperature: 18 });
      history.restore(value);
      expect(history.snapshot()).toEqual({ version: 1, devices: {} });
    });

  test('rejects tampered timestamps, invalid/duplicate versions and invalid measurements individually', () => {
    const history = new ThermostatHistory({ now: () => NOW });
    const valid = history.recordProgramme('room', { source: 'native', programme: programme() });
    history.restore({ version: 1, devices: { room: {
      temperatures: [
        { online: true, currentTemperature: 18 },
        { at: 'yesterday', online: true, currentTemperature: 18 },
        { at: NOW + HOUR, online: true, currentTemperature: 18 },
        { at: NOW, sourceAt: NOW + HOUR, online: true, currentTemperature: 18 },
        { at: NOW, online: true, currentTemperature: 110 },
        { at: NOW, online: false, currentTemperature: 18 },
        { at: NOW, online: true, targetTemperature: 110 },
        { at: NOW, online: 'true', currentTemperature: 18 },
        { at: NOW, online: true, currentTemperature: 19 },
      ],
      programmes: [
        { ...valid, id: 'untrusted' }, { ...valid, at: undefined },
        { ...valid, id: '10000000-0000-0000-0000-000000000000', programme: { days: [] } },
        { ...valid, id: '20000000-0000-0000-0000-000000000000', profile: 'summer' },
        { ...valid, id: '30000000-0000-0000-0000-000000000000', source: 'draft' },
        valid, valid,
      ],
    } } });
    expect(history.temperatureHistory('room')).toEqual([{ at: NOW, online: true, currentTemperature: 19 }]);
    expect(history.programmeHistory('room')).toEqual([valid]);
  });

  test('bounds all devices and serialized data below the runtime IPC limit', () => {
    const history = new ThermostatHistory({ now: () => NOW });
    const saved: ThermostatHistoryState = { version: 1, devices: {} };
    for (let device = 0; device < 10; device++) {
      const seed = new ThermostatHistory({ now: () => NOW });
      const versions = Array.from({ length: 50 }, (_, index) => seed.recordProgramme('room', {
        source: 'native', at: NOW - 100 + index, programme: programme(20 + index % 2),
      }));
      saved.devices[`room-${device}`] = {
        temperatures: Array.from({ length: 1000 }, (_, index) => ({
          at: NOW - 2000 + index, sourceAt: NOW - 3000 + index, online: true,
          currentTemperature: 18 + index % 2, targetTemperature: 20,
        })),
        programmes: versions,
      };
    }
    history.restore(saved);
    const bounded = history.snapshot();
    expect(Object.values(bounded.devices).reduce((sum, device) => sum + device.temperatures.length, 0)).toBeLessThanOrEqual(6000);
    expect(Object.values(bounded.devices).reduce((sum, device) => sum + device.programmes.length, 0)).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
