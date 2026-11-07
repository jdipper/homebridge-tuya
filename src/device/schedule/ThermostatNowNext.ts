import { ThermostatWeeklyProgramme, validateThermostatWeeklyProgramme } from './ThermostatProfiles';

export interface ThermostatScheduleClock {
  timeZone: string;
  /** A user confirmation, not a remote observation of the thermostat's clock. */
  clockVerified: boolean;
}

export interface ThermostatPeriodOccurrence {
  at: number;
  day: number;
  event: number;
  label: string;
  temperature: number;
}

export interface ThermostatNowNext {
  timeZone: string;
  clockVerified: boolean;
  safeForExpiry: boolean;
  current?: ThermostatPeriodOccurrence;
  next?: ThermostatPeriodOccurrence;
  reason?: string;
}

const LABELS = ['Wake', 'Leave', 'Return', 'Sleep'];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function isThermostatTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100 || !value.trim() || /^[+-]/.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** Planned wall-clock periods. Never asserts that the physical thermostat's clock was read. */
export function getThermostatNowNext(
  programme: ThermostatWeeklyProgramme | undefined,
  clock: ThermostatScheduleClock,
  now = Date.now(),
): ThermostatNowNext {
  const result: ThermostatNowNext = { ...clock, safeForExpiry: false };
  if (!isThermostatTimeZone(clock.timeZone) || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    return { ...result, reason: 'Choose a valid time zone for the thermostat.' };
  }
  let valid: ThermostatWeeklyProgramme;
  try {
    valid = validateThermostatWeeklyProgramme(programme);
  } catch {
    return { ...result, reason: 'Read a complete programme to see its planned periods.' };
  }
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: clock.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const wallTime = (at: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  };
  const today = new Date(wallTime(now));
  today.setUTCHours(0, 0, 0, 0);
  const occurrences: ThermostatPeriodOccurrence[] = [];
  const uncertain: { from: number; until: number }[] = [];
  // Include yesterday's Sleep and next week's earliest event, including midnight/week rollover.
  for (let dayOffset = -1; dayOffset <= 8; dayOffset++) {
    const date = new Date(today.getTime() + dayOffset * DAY);
    const day = 1 << ((date.getUTCDay() + 6) % 7);
    const events = valid.days.find(item => item.day === day)!.events;
    for (const event of events) {
      const wall = date.getTime() + (event.hour * 60 + event.minute) * MINUTE;
      // Probe both sides of a clock change. Invert using observed offsets, then verify the wall time.
      const offsets = [...new Set([-DAY, -DAY / 2, 0, DAY / 2, DAY].map(delta => wallTime(wall + delta) - wall - delta))];
      const candidates = offsets.map(offset => wall - offset).filter(at => wallTime(at) === wall).sort((a, b) => a - b);
      if (candidates.length !== 1) {
        const estimates = offsets.map(offset => wall - offset);
        uncertain.push({ from: Math.min(...estimates), until: Math.max(...estimates) });
      }
      for (const at of candidates) {
        occurrences.push({ at, day, event: event.event, label: LABELS[event.event], temperature: event.temperature });
      }
    }
  }
  occurrences.sort((a, b) => a.at - b.at);
  result.current = occurrences.filter(item => item.at <= now).pop();
  result.next = occurrences.find(item => item.at > now);
  const clockChange = uncertain.some(item => item.until >= (result.current?.at ?? now)
    && item.from <= (result.next?.at ?? now));
  if (clockChange) {
    result.reason = 'A clock change makes this period ambiguous; check the thermostat clock before using a timed boundary.';
  } else if (!clock.clockVerified) {
    result.reason = 'Planned times use this time zone. Confirm that the thermostat clock matches before timing an override to a period.';
  } else {
    result.safeForExpiry = result.next !== undefined;
  }
  return result;
}
