/** Persisted household policy. Deadlines belong to the bridge, not the thermostat. */
export interface ThermostatControlPolicy {
  version: 1;
  actualHome: boolean | null;
  effectiveHome: boolean | null;
  awayDelayMinutes: number;
  pendingAwayAt: number | null;
  holdUntil: number | null;
  holidayActive: boolean;
  returnAt: number | null;
  preheatMinutes: number;
  preheating: boolean;
  recoveryRequired: string | null;
}

export function createThermostatControlPolicy(actualHome: boolean | null = null, holidayActive = false): ThermostatControlPolicy {
  return { version: 1, actualHome, effectiveHome: actualHome, awayDelayMinutes: 30, pendingAwayAt: null,
    holdUntil: null, holidayActive, returnAt: null, preheatMinutes: 0, preheating: false, recoveryRequired: null };
}

export function policyTimestamp(value: unknown, label: string, now: number, allowNull = true): number | null {
  if (allowNull && value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= now || value > now + 366 * 86400000) {
    throw new Error(`${label} must be a future date within the next year.`);
  }
  return value;
}

export function policyMinutes(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a whole number between 0 and ${maximum} minutes.`);
  }
  return value;
}

/** Evaluate deadlines only. The runtime serializes persistence before any resulting device operations. */
export function evaluateThermostatControlPolicy(input: ThermostatControlPolicy, now: number): ThermostatControlPolicy {
  const next = { ...input };
  if (next.recoveryRequired) {
    return next;
  }
  if (next.holdUntil !== null && next.holdUntil <= now) {
    next.holdUntil = null;
  }
  if (next.pendingAwayAt !== null && next.pendingAwayAt <= now) {
    next.pendingAwayAt = null;
    next.effectiveHome = next.actualHome;
  }
  if (next.actualHome === true || (next.holdUntil !== null && next.holdUntil > now)) {
    next.effectiveHome = true;
  } else if (next.pendingAwayAt === null) {
    next.effectiveHome = next.actualHome;
  }
  if (next.holidayActive && next.returnAt !== null) {
    if (next.returnAt <= now) {
      if (next.actualHome === null && next.holdUntil === null) {
        next.recoveryRequired = 'Holiday return is due, but household presence is unknown. '
          + 'Set whether anyone is home, then review recovery.';
        return next;
      }
      next.holidayActive = false;
      next.returnAt = null;
      next.preheating = false;
    } else {
      next.preheating = next.preheatMinutes > 0 && next.returnAt - next.preheatMinutes * 60000 <= now;
    }
  } else {
    next.preheating = false;
  }
  return next;
}

export function policyIntent(policy: ThermostatControlPolicy) {
  return {
    anyoneHome: policy.preheating ? true : policy.effectiveHome,
    holiday: policy.holidayActive && !policy.preheating,
  };
}

export function policyDeadlines(policy: ThermostatControlPolicy): number[] {
  if (policy.recoveryRequired) {
    return [];
  }
  const deadlines = [policy.pendingAwayAt, policy.holdUntil,
    policy.holidayActive ? policy.returnAt : null,
    policy.holidayActive && !policy.preheating && policy.returnAt !== null && policy.preheatMinutes > 0
      ? policy.returnAt - policy.preheatMinutes * 60000 : null];
  return deadlines.filter((value): value is number => typeof value === 'number');
}

/** Old profile files migrate without inventing timers. Overdue timers are never replayed after restart. */
export function restoreThermostatControlPolicy(value: unknown, fallbackHome: boolean | null, fallbackHoliday: boolean,
  now: number): ThermostatControlPolicy {
  if (value === undefined) {
    return createThermostatControlPolicy(fallbackHome, fallbackHoliday);
  }
  const policy = value as ThermostatControlPolicy;
  if (!policy || policy.version !== 1 || (policy.actualHome !== null && typeof policy.actualHome !== 'boolean')
    || (policy.effectiveHome !== null && typeof policy.effectiveHome !== 'boolean')
    || typeof policy.holidayActive !== 'boolean' || typeof policy.preheating !== 'boolean'
    || ![policy.pendingAwayAt, policy.holdUntil, policy.returnAt].every(item => item === null
      || (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0))
    || !(policy.recoveryRequired === null || typeof policy.recoveryRequired === 'string')) {
    throw new Error('Invalid saved household heating policy.');
  }
  policyMinutes(policy.awayDelayMinutes, 'Away delay', 1440);
  policyMinutes(policy.preheatMinutes, 'Preheat lead', 1440);
  const restored = { ...policy };
  if (policyDeadlines(restored).some(deadline => deadline <= now)) {
    restored.recoveryRequired = 'A heating policy deadline passed while Homebridge was stopped. Review and resume it explicitly.';
  }
  return restored;
}
