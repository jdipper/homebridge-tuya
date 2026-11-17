/** A reviewed room time zone; household policy remains in the shared controller. */
export interface FastWarmActiveTargetContext { timeZone: string }
export interface FastWarmActivePeriod { targetC: number; startsAt: number; endsAt: number }
type Programme = Record<string, {startMinute: number; targetC: number}[]>;
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY = 86400000;

export function validateFastWarmActiveTarget(value: unknown): FastWarmActiveTargetContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || typeof (value as FastWarmActiveTargetContext).timeZone !== 'string') {
    throw new Error('Current-period activation requires only a valid room time zone.');
  }
  const timeZone = (value as FastWarmActiveTargetContext).timeZone;
  if (!timeZone.trim() || timeZone.length > 100 || /^[+-]/.test(timeZone)) {
    throw new Error('Choose a valid room time zone for current-period activation.');
  }
  try {
    new Intl.DateTimeFormat('en-GB', {timeZone}).format();
  } catch {
    throw new Error('Choose a valid room time zone for current-period activation.');
  }
  return {timeZone};
}

/** Invert wall-clock events, including yesterday's final period and week rollover. */
export function getFastWarmActivePeriod(programme: Programme, context: FastWarmActiveTargetContext,
  now = Date.now()): FastWarmActivePeriod {
  validateFastWarmActiveTarget(context);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error('A valid clock is required for current-period activation.');
  }
  const formatter = new Intl.DateTimeFormat('en-GB', {timeZone: context.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  const wallTime = (at: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  };
  const today = new Date(wallTime(now)); today.setUTCHours(0, 0, 0, 0);
  const events: {at: number; targetC: number}[] = [], uncertain: {from: number; until: number}[] = [];
  for (let offset = -1; offset <= 8; offset++) {
    const date = new Date(today.getTime() + offset * DAY);
    const day = DAYS[(date.getUTCDay() + 6) % 7], periods = programme[day];
    if (!Array.isArray(periods) || periods.length !== 4) {
      throw new Error('A complete four-period week is required.');
    }
    for (const period of periods) {
      if (!Number.isInteger(period.startMinute) || period.startMinute < 0 || period.startMinute >= 1440
        || !Number.isFinite(period.targetC)) {
        throw new Error('Invalid current-period programme.');
      }
      const wall = date.getTime() + period.startMinute * 60000;
      const offsets = [...new Set([-DAY, -DAY / 2, 0, DAY / 2, DAY].map(delta => wallTime(wall + delta) - wall - delta))];
      const candidates = offsets.map(delta => wall - delta).filter(at => wallTime(at) === wall).sort((a, b) => a - b);
      if (candidates.length !== 1) {
        const estimates = offsets.map(delta => wall - delta);
        uncertain.push({from: Math.min(...estimates), until: Math.max(...estimates)});
      }
      for (const at of candidates) {
        events.push({at, targetC: period.targetC});
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  const current = events.filter(event => event.at <= now).pop(), next = events.find(event => event.at > now);
  if (!current || !next || uncertain.some(event => event.until >= current.at && event.from <= next.at)) {
    throw new Error('A clock change makes this programme period ambiguous; no current target was sent.');
  }
  return {targetC: current.targetC, startsAt: current.at, endsAt: next.at};
}
