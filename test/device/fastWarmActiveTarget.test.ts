import { getFastWarmActivePeriod, validateFastWarmActiveTarget } from '../../src/device/schedule/FastWarmActiveTarget';
const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const week = () => Object.fromEntries(days.map((day, index) => [day, [360, 510, 1020, 1320]
  .map((startMinute, slot) => ({startMinute, targetC: slot === 3 ? 10 + index : 20}))]));
const context = {timeZone: 'Europe/London'};
const at = (text: string) => Date.parse(text);

test('validates an exact IANA time-zone context before any device operation', () => {
  expect(validateFastWarmActiveTarget(undefined)).toBeUndefined();
  expect(validateFastWarmActiveTarget(context)).toEqual(context);
  for (const value of [null, {}, {timeZone: '+01:00'}, {timeZone: 'bad'}, {timeZone: 'UTC', targetC: 30}]) {
    expect(() => validateFastWarmActiveTarget(value)).toThrow();
  }
});

test('uses the current period and next change in winter local time', () => {
  expect(getFastWarmActivePeriod(week(), context, at('2026-11-17T17:30:00Z'))).toEqual({
    targetC: 20, startsAt: at('2026-11-17T17:00:00Z'), endsAt: at('2026-11-17T22:00:00Z'),
  });
});

test('uses the previous Sunday sleep before Monday wake', () => {
  expect(getFastWarmActivePeriod(week(), context, at('2026-11-16T05:00:00Z'))).toEqual({
    targetC: 16, startsAt: at('2026-11-15T22:00:00Z'), endsAt: at('2026-11-16T06:00:00Z'),
  });
});

test('uses the configured summer offset rather than a fixed device offset', () => {
  expect(getFastWarmActivePeriod(week(), context, at('2026-07-14T16:30:00Z'))).toEqual({
    targetC: 20, startsAt: at('2026-07-14T16:00:00Z'), endsAt: at('2026-07-14T21:00:00Z'),
  });
});

test.each(['2026-10-25T00:45:00Z', '2026-10-25T01:45:00Z'])('rejects an ambiguous repeated event at %s', timestamp => {
  const programme = week(); programme.sunday[0].startMinute = 90;
  expect(() => getFastWarmActivePeriod(programme, context, at(timestamp))).toThrow('ambiguous');
});

test('rejects an absent spring-clock event rather than inventing its target', () => {
  const programme = week(); programme.sunday[0].startMinute = 90;
  expect(() => getFastWarmActivePeriod(programme, context, at('2026-03-29T01:20:00Z'))).toThrow('ambiguous');
});
