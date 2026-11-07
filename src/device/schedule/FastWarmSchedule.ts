/** The ET-63 heating programme uses Monday through Sunday as these bitmap bits. */
export const FASTWARM_SCHEDULE_DAYS = [1, 2, 4, 8, 16, 32, 64] as const;

export type FastWarmScheduleDay = typeof FASTWARM_SCHEDULE_DAYS[number];
/** Wake, Leave, Return and Sleep respectively. */
export type FastWarmScheduleEventId = 0 | 1 | 2 | 3;

export interface FastWarmScheduleEvent {
  event: FastWarmScheduleEventId;
  hour: number;
  minute: number;
  temperature: number;
}

/** A single-event update or a complete four-event day report, possibly covering several days. */
export interface FastWarmSchedulePacket {
  dayMask: number;
  events: readonly FastWarmScheduleEvent[];
}

export interface FastWarmScheduleReport {
  packet: FastWarmSchedulePacket;
  /** Device report timestamp; use the same units throughout a collection. */
  reportedAt?: number;
}

export interface FastWarmScheduleDayState {
  day: FastWarmScheduleDay;
  events: FastWarmScheduleEvent[];
  complete: boolean;
}

export interface FastWarmScheduleState {
  days: FastWarmScheduleDayState[];
  complete: boolean;
  missing: { day: FastWarmScheduleDay; event: FastWarmScheduleEventId }[];
}

const EVENT_IDS: readonly FastWarmScheduleEventId[] = [0, 1, 2, 3];

function validateInteger(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`FastWarm schedule ${name} must be an integer from ${min} to ${max}.`);
  }
}

function validateEvent(event: FastWarmScheduleEvent) {
  validateInteger(event.event, 0, 3, 'event ID');
  validateInteger(event.hour, 0, 23, 'hour');
  validateInteger(event.minute, 0, 59, 'minute');
  if (!Number.isFinite(event.temperature) || event.temperature < 5 || event.temperature > 40
    || !Number.isInteger(event.temperature * 2)) {
    throw new Error('FastWarm schedule temperature must be from 5 to 40 degrees Celsius in 0.5 degree steps.');
  }
}

function validatePacket(packet: FastWarmSchedulePacket) {
  validateInteger(packet.dayMask, 1, 127, 'day mask');
  if (packet.events.length !== 1 && packet.events.length !== 4) {
    throw new Error('FastWarm schedule packets must contain one event or all four events.');
  }
  const seen = new Set<number>();
  for (const event of packet.events) {
    validateEvent(event);
    if (seen.has(event.event)) {
      throw new Error(`FastWarm schedule packet contains duplicate event ID ${event.event}.`);
    }
    seen.add(event.event);
  }
}

/** Decode DP119 base64 or raw bytes. It is not the separate DP124 timer programme format. */
export function decodeFastWarmSchedule(payload: string | Uint8Array): FastWarmSchedulePacket {
  let bytes: Buffer;
  if (typeof payload === 'string') {
    bytes = Buffer.from(payload, 'base64');
    // Buffer's decoder silently accepts invalid characters and truncated input; reject those here.
    if (bytes.toString('base64') !== payload) {
      throw new Error('FastWarm schedule payload must be canonical base64 without whitespace.');
    }
  } else {
    bytes = Buffer.from(payload);
  }
  if (bytes.length !== 6 && bytes.length !== 21) {
    throw new Error('FastWarm schedule payload must contain 6 bytes for one event or 21 bytes for a complete day.');
  }

  const events: FastWarmScheduleEvent[] = [];
  for (let offset = 1; offset < bytes.length; offset += 5) {
    events.push({
      event: bytes[offset] as FastWarmScheduleEventId,
      hour: bytes[offset + 1],
      minute: bytes[offset + 2],
      temperature: bytes.readUInt16BE(offset + 3) / 10,
    });
  }
  const packet = { dayMask: bytes[0], events };
  validatePacket(packet);
  return packet;
}

/**
 * Encode either DP119 packet shape with the temperature as a big-endian integer times ten.
 * Only the six-byte event update is documented as a device command; encoding a
 * complete day supports report round trips, not a verified full-day write.
 */
export function encodeFastWarmSchedule(packet: FastWarmSchedulePacket): string {
  validatePacket(packet);
  const bytes = Buffer.alloc(1 + packet.events.length * 5);
  bytes[0] = packet.dayMask;
  packet.events.forEach((event, index) => {
    const offset = 1 + index * 5;
    bytes[offset] = event.event;
    bytes[offset + 1] = event.hour;
    bytes[offset + 2] = event.minute;
    bytes.writeUInt16BE(event.temperature * 10, offset + 3);
  });
  return bytes.toString('base64');
}

/**
 * Assemble reports without assuming their arrival order or mistaking a latest shadow chunk for the whole week.
 * Newer timestamped values win per day/event. Timestamped values take precedence over untimed ones;
 * equal timestamps (or two untimed reports) use input order. No missing events are invented.
 * Completeness is structural; callers must scope read sessions and establish snapshot freshness separately.
 */
export function collectFastWarmSchedule(reports: readonly FastWarmScheduleReport[]): FastWarmScheduleState {
  const entries = FASTWARM_SCHEDULE_DAYS.map(() =>
    new Map<FastWarmScheduleEventId, { event: FastWarmScheduleEvent; reportedAt?: number }>());

  for (const report of reports) {
    validatePacket(report.packet);
    if (report.reportedAt !== undefined) {
      validateInteger(report.reportedAt, 0, Number.MAX_SAFE_INTEGER, 'report timestamp');
    }
    FASTWARM_SCHEDULE_DAYS.forEach((day, index) => {
      if (!(report.packet.dayMask & day)) {
        return;
      }
      for (const event of report.packet.events) {
        const previous = entries[index].get(event.event);
        if (previous?.reportedAt !== undefined
          && (report.reportedAt === undefined || previous.reportedAt > report.reportedAt)) {
          continue;
        }
        entries[index].set(event.event, { event: { ...event }, reportedAt: report.reportedAt });
      }
    });
  }

  const missing: FastWarmScheduleState['missing'] = [];
  const days = FASTWARM_SCHEDULE_DAYS.map((day, index) => {
    const events: FastWarmScheduleEvent[] = [];
    for (const event of EVENT_IDS) {
      const entry = entries[index].get(event);
      if (entry) {
        events.push({ ...entry.event });
      } else {
        missing.push({ day, event });
      }
    }
    return { day, events, complete: events.length === 4 };
  });
  return { days, complete: missing.length === 0, missing };
}

/** Update DP110's grouping/adaptive bits without changing any other flags. */
export function updateFastWarmScheduleSettings(
  current: number,
  changes: { grouping?: '7-day' | '5+1+1'; adaptive?: boolean },
): number {
  validateInteger(current, 0, 0xffffffff, 'settings');
  let next = current;
  if (changes.grouping !== undefined) {
    if (changes.grouping !== '7-day' && changes.grouping !== '5+1+1') {
      throw new Error('FastWarm schedule grouping must be 7-day or 5+1+1.');
    }
    next = (next & ~1) | (changes.grouping === '5+1+1' ? 1 : 0);
  }
  if (changes.adaptive !== undefined) {
    if (typeof changes.adaptive !== 'boolean') {
      throw new Error('FastWarm schedule adaptive setting must be a boolean.');
    }
    next = (next & ~2) | (changes.adaptive ? 2 : 0);
  }
  return next >>> 0;
}
