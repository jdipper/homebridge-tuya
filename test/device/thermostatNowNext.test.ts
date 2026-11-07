import { getThermostatNowNext, isThermostatTimeZone } from '../../src/device/schedule/ThermostatNowNext';
import { ThermostatWeeklyProgramme } from '../../src/device/schedule/ThermostatProfiles';

function programme(): ThermostatWeeklyProgramme {
  return { days: [1, 2, 4, 8, 16, 32, 64].map(day => ({ day, events: [
    { event: 0, hour: 5, minute: 30, temperature: 20 }, { event: 1, hour: 8, minute: 30, temperature: 12 },
    { event: 2, hour: 17, minute: 0, temperature: 20 }, { event: 3, hour: 22, minute: 0, temperature: 12 },
  ] })) } as ThermostatWeeklyProgramme;
}
const clock = { timeZone: 'Europe/London', clockVerified: true };

test('uses the previous day at midnight and crosses the Sunday/Monday week boundary', () => {
  const result = getThermostatNowNext(programme(), clock, Date.parse('2026-11-09T00:05:00Z'));
  expect(result.current).toMatchObject({ day: 64, label: 'Sleep', at: Date.parse('2026-11-08T22:00:00Z'), temperature: 12 });
  expect(result.next).toMatchObject({ day: 1, label: 'Wake', at: Date.parse('2026-11-09T05:30:00Z'), temperature: 20 });
  expect(result.safeForExpiry).toBe(true);
});

test('an event starting now is current, and the next event is strictly in the future', () => {
  const result = getThermostatNowNext(programme(), clock, Date.parse('2026-11-09T08:30:00Z'));
  expect(result.current?.label).toBe('Leave');
  expect(result.next?.label).toBe('Return');
});

test('IANA summer offset is used rather than retaining a fixed winter offset', () => {
  const result = getThermostatNowNext(programme(), clock, Date.parse('2026-07-06T03:00:00Z'));
  expect(result.next?.at).toBe(Date.parse('2026-07-06T04:30:00Z'));
});

test('supports half-hour zones and the local calendar day', () => {
  const result = getThermostatNowNext(programme(), { timeZone: 'Asia/Kolkata', clockVerified: true }, Date.parse('2026-11-08T23:00:00Z'));
  expect(result.next).toMatchObject({ day: 1, at: Date.parse('2026-11-09T00:00:00Z') });
});

test('an unconfirmed clock can show a planned time but cannot time an override boundary', () => {
  const result = getThermostatNowNext(programme(), { ...clock, clockVerified: false }, Date.parse('2026-11-09T10:00:00Z'));
  expect(result.next?.label).toBe('Return');
  expect(result.safeForExpiry).toBe(false);
  expect(result.reason).toMatch(/Confirm/);
});

test.each(['garbage', '', '+01:00', null])('invalid zone %s remains unknown', timeZone => {
  expect(isThermostatTimeZone(timeZone)).toBe(false);
  expect(getThermostatNowNext(programme(), { timeZone: timeZone as string, clockVerified: true }).next).toBeUndefined();
});

test('missing or malformed programmes cannot invent a next event', () => {
  expect(getThermostatNowNext(undefined, clock).next).toBeUndefined();
  const invalid = programme();
  invalid.days[0].events.pop();
  expect(getThermostatNowNext(invalid, clock).next).toBeUndefined();
});

test.each([
  ['2026-10-25T00:40:00Z', '2026-10-25T01:30:00Z'],
  ['2026-03-29T00:40:00Z', '2026-03-29T07:30:00Z'],
])('clock change at %s never fabricates a safe expiry', (now, next) => {
  const p = programme();
  p.days[6].events[0] = { event: 0, hour: 1, minute: 30, temperature: 20 };
  const result = getThermostatNowNext(p, clock, Date.parse(now));
  expect(result.next?.at).toBe(Date.parse(next));
  expect(result.safeForExpiry).toBe(false);
  expect(result.reason).toMatch(/clock change/);
});
