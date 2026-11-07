import {
  collectFastWarmSchedule,
  decodeFastWarmSchedule,
  encodeFastWarmSchedule,
  FastWarmScheduleEvent,
  FastWarmSchedulePacket,
  updateFastWarmScheduleSettings,
} from '../../src/device/schedule/FastWarmSchedule';

const wake: FastWarmScheduleEvent = { event: 0, hour: 7, minute: 30, temperature: 19.5 };
// The device model's example full-day report: 07:00/23.5, 09:30/25, 17:30/22, 22:00/19.
const fullDayBytes = Buffer.from('0100070000eb01091e00fa02111e00dc03160000be', 'hex');
const fullDay = decodeFastWarmSchedule(fullDayBytes);

function singleEvent(changes: Partial<FastWarmScheduleEvent> = {}): FastWarmSchedulePacket {
  return { dayMask: 1, events: [{ ...wake, ...changes }] };
}

describe('FastWarm DP119 heating schedule codec', () => {
  test('decodes a known single-event base64 packet', () => {
    expect(decodeFastWarmSchedule('AQAHHgDD')).toEqual({ dayMask: 1, events: [wake] });
  });

  test('encodes grouped days and a big-endian temperature above 25.5 degrees', () => {
    expect(encodeFastWarmSchedule({ dayMask: 5, events: [{ ...wake, temperature: 39.5 }] })).toBe('BQAHHgGL');
  });

  test('decodes all four events in a complete day report', () => {
    expect(fullDay).toEqual({
      dayMask: 1,
      events: [
        { event: 0, hour: 7, minute: 0, temperature: 23.5 },
        { event: 1, hour: 9, minute: 30, temperature: 25 },
        { event: 2, hour: 17, minute: 30, temperature: 22 },
        { event: 3, hour: 22, minute: 0, temperature: 19 },
      ],
    });
    expect(Buffer.from(encodeFastWarmSchedule(fullDay), 'base64')).toEqual(fullDayBytes);
  });

  test('accepts a non-Buffer Uint8Array without mutating it', () => {
    const bytes = new Uint8Array([64, 3, 22, 0, 0, 120]);
    expect(decodeFastWarmSchedule(bytes)).toEqual({
      dayMask: 64, events: [{ event: 3, hour: 22, minute: 0, temperature: 12 }],
    });
    expect(Array.from(bytes)).toEqual([64, 3, 22, 0, 0, 120]);
  });

  test.each([5, 5.5, 39.5, 40])('round-trips the supported temperature %s', temperature => {
    const packet = singleEvent({ temperature });
    expect(decodeFastWarmSchedule(encodeFastWarmSchedule(packet))).toEqual(packet);
  });

  test('supports boundary days and times', () => {
    const packet = { dayMask: 127, events: [{ event: 3 as const, hour: 23, minute: 59, temperature: 5 }] };
    expect(decodeFastWarmSchedule(encodeFastWarmSchedule(packet))).toEqual(packet);
  });

  test.each(['AQAHHgDD!', 'AQAH HgDD', 'AQAHHgD', 'AQAHHgDD\n', 'AQAHHgDD='])('rejects malformed base64 %j', value => {
    expect(() => decodeFastWarmSchedule(value)).toThrow('canonical base64');
  });

  test.each([0, 1, 5, 7, 20, 22, 28])('rejects unsupported packet byte length %s', length => {
    expect(() => decodeFastWarmSchedule(Buffer.alloc(length))).toThrow('6 bytes');
  });

  test.each([0, 128, -1, 1.5, NaN])('rejects invalid day mask %s', dayMask => {
    expect(() => encodeFastWarmSchedule({ ...singleEvent(), dayMask })).toThrow('day mask');
  });

  test.each([
    { event: -1 }, { event: 4 }, { event: 0.5 },
    { hour: -1 }, { hour: 24 }, { hour: 1.5 },
    { minute: -1 }, { minute: 60 }, { minute: 1.5 },
  ])('rejects an invalid event field %j', changes => {
    expect(() => encodeFastWarmSchedule(singleEvent(changes as Partial<FastWarmScheduleEvent>))).toThrow('must be an integer');
  });

  test.each([0, 4.5, 40.5, 19.1, NaN, Infinity])('rejects unsupported temperature %s', temperature => {
    expect(() => encodeFastWarmSchedule(singleEvent({ temperature }))).toThrow('0.5 degree steps');
  });

  test.each([0, 2, 3, 5])('rejects a packet containing %s events', count => {
    expect(() => encodeFastWarmSchedule({ dayMask: 1, events: Array(count).fill(wake) })).toThrow('one event or all four');
  });

  test('rejects duplicate IDs in complete day reports instead of silently overwriting events', () => {
    const bytes = Buffer.from(fullDayBytes);
    bytes[6] = 0;
    expect(() => decodeFastWarmSchedule(bytes)).toThrow('duplicate event ID 0');
    expect(() => encodeFastWarmSchedule({ dayMask: 1, events: Array(4).fill(wake) })).toThrow('duplicate event ID');
  });

  test.each([
    [0, 128, 'day mask'],
    [1, 4, 'event ID'],
    [2, 24, 'hour'],
    [3, 60, 'minute'],
    [5, 194, 'temperature'],
  ])('validates device-supplied fields at byte %s', (offset, value, message) => {
    const bytes = Buffer.from([1, 0, 7, 30, 0, 195]);
    bytes[offset] = value;
    expect(() => decodeFastWarmSchedule(bytes)).toThrow(String(message));
  });
});

describe('collectFastWarmSchedule', () => {
  test('does not invent a complete timetable from an empty or single-chunk shadow', () => {
    const empty = collectFastWarmSchedule([]);
    expect(empty.complete).toBe(false);
    expect(empty.missing).toHaveLength(28);
    expect(empty.days).toHaveLength(7);
    const one = collectFastWarmSchedule([{ packet: singleEvent() }]);
    expect(one.complete).toBe(false);
    expect(one.missing).toHaveLength(27);
    expect(one.days[0]).toEqual({ day: 1, events: [wake], complete: false });
  });

  test('collects complete days arriving in any order', () => {
    const dayMasks = [64, 4, 16, 1, 32, 2, 8];
    const result = collectFastWarmSchedule(dayMasks.map(dayMask => ({ packet: { ...fullDay, dayMask } })));
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.days.map(day => day.day)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(result.days.every(day => day.complete && day.events.length === 4)).toBe(true);
  });

  test('expands grouped weekday and weekend reports', () => {
    const weekend = fullDay.events.map(event => ({ ...event, temperature: 20 }));
    const result = collectFastWarmSchedule([
      { packet: { dayMask: 31, events: fullDay.events } },
      { packet: { dayMask: 96, events: weekend } },
    ]);
    expect(result.complete).toBe(true);
    expect(result.days.slice(0, 5).every(day => day.events[0].temperature === 23.5)).toBe(true);
    expect(result.days.slice(5).every(day => day.events[0].temperature === 20)).toBe(true);
  });

  test('orders individual event chunks by event ID and identifies every missing slot', () => {
    const result = collectFastWarmSchedule(fullDay.events.slice().reverse().map(event => ({
      packet: { dayMask: 64, events: [event] },
    })));
    expect(result.days[6]).toEqual({ day: 64, events: fullDay.events, complete: true });
    expect(result.complete).toBe(false);
    expect(result.missing).toHaveLength(24);
    expect(result.missing).not.toContainEqual(expect.objectContaining({ day: 64 }));
  });

  test('ignores older overlapping reports per day/event without discarding other days', () => {
    const result = collectFastWarmSchedule([
      { packet: singleEvent({ temperature: 21 }), reportedAt: 200 },
      { packet: { dayMask: 3, events: [{ ...wake, temperature: 18 }] }, reportedAt: 100 },
    ]);
    expect(result.days[0].events[0].temperature).toBe(21);
    expect(result.days[1].events[0].temperature).toBe(18);
  });

  test('keeps newer event edits when a stale complete day report arrives later', () => {
    const result = collectFastWarmSchedule([
      { packet: singleEvent({ temperature: 21 }), reportedAt: 200 },
      { packet: fullDay, reportedAt: 100 },
    ]);
    expect(result.days[0].complete).toBe(true);
    expect(result.days[0].events[0].temperature).toBe(21);
    expect(result.days[0].events[1].temperature).toBe(25);
  });

  test('prefers timestamped reports and uses input order for untimed or equally timed values', () => {
    const result = collectFastWarmSchedule([
      { packet: singleEvent({ temperature: 18 }) },
      { packet: singleEvent({ temperature: 19 }) },
      { packet: singleEvent({ temperature: 20 }), reportedAt: 100 },
      { packet: singleEvent({ temperature: 21 }), reportedAt: 100 },
      { packet: singleEvent({ temperature: 22 }) },
    ]);
    expect(result.days[0].events[0].temperature).toBe(21);
  });

  test('does not mutate input packets or share grouped event objects between days', () => {
    const packet = { dayMask: 3, events: [{ ...wake }] };
    const result = collectFastWarmSchedule([{ packet }]);
    result.days[0].events[0].temperature = 40;
    expect(packet.events[0].temperature).toBe(19.5);
    expect(result.days[1].events[0].temperature).toBe(19.5);
  });

  test.each([-1, NaN, Infinity, 0.5])('rejects invalid report timestamp %s', reportedAt => {
    expect(() => collectFastWarmSchedule([{ packet: singleEvent(), reportedAt }])).toThrow('report timestamp');
  });
});

describe('updateFastWarmScheduleSettings', () => {
  test('changes programme grouping while retaining adaptive start and unknown flags', () => {
    expect(updateFastWarmScheduleSettings(0b10101010, { grouping: '5+1+1' })).toBe(0b10101011);
    expect(updateFastWarmScheduleSettings(0b10101011, { grouping: '7-day' })).toBe(0b10101010);
  });

  test('changes adaptive start while retaining grouping and unknown flags', () => {
    expect(updateFastWarmScheduleSettings(0b10101001, { adaptive: true })).toBe(0b10101011);
    expect(updateFastWarmScheduleSettings(0b10101011, { adaptive: false })).toBe(0b10101001);
  });

  test('can update both bits and preserves the unsigned high bit', () => {
    expect(updateFastWarmScheduleSettings(0xffffffff, { grouping: '7-day', adaptive: false })).toBe(0xfffffffc);
    expect(updateFastWarmScheduleSettings(0xffffffff, {})).toBe(0xffffffff);
  });

  test.each([-1, 0.5, NaN, 0x100000000])('rejects invalid settings value %s', value => {
    expect(() => updateFastWarmScheduleSettings(value, {})).toThrow('settings');
  });
});
