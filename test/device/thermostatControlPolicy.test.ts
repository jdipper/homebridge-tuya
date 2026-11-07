import { createThermostatControlPolicy, evaluateThermostatControlPolicy, policyDeadlines, policyIntent,
  policyMinutes, policyTimestamp, restoreThermostatControlPolicy } from '../../src/device/schedule/ThermostatControlPolicy';

const now = Date.UTC(2026, 0, 1, 12);

test('Away delay retains Home, arrival cancels it, and guest hold wins without changing actual occupancy', () => {
  const home = createThermostatControlPolicy(true);
  const departing = { ...home, actualHome: false, pendingAwayAt: now + 1800000 };
  expect(evaluateThermostatControlPolicy(departing, now).effectiveHome).toBe(true);
  expect(evaluateThermostatControlPolicy(departing, now + 1800000).effectiveHome).toBe(false);
  const guest = evaluateThermostatControlPolicy({ ...departing, holdUntil: now + 3600000 }, now + 1800000);
  expect(guest.actualHome).toBe(false);
  expect(guest.effectiveHome).toBe(true);
  expect(evaluateThermostatControlPolicy(guest, now + 3600000).effectiveHome).toBe(false);
});

test('Holiday overrides presence and preheat uses Home until return, then latest occupancy', () => {
  const holiday = { ...createThermostatControlPolicy(false, true), returnAt: now + 3600000, preheatMinutes: 30 };
  expect(policyIntent(evaluateThermostatControlPolicy(holiday, now))).toEqual({ anyoneHome: false, holiday: true });
  const preheating = evaluateThermostatControlPolicy(holiday, now + 1800000);
  expect(preheating.holidayActive).toBe(true);
  expect(policyIntent(preheating)).toEqual({ anyoneHome: true, holiday: false });
  const returned = evaluateThermostatControlPolicy(preheating, now + 3600000);
  expect(returned.holidayActive).toBe(false);
  expect(policyIntent(returned)).toEqual({ anyoneHome: false, holiday: false });
});

test('unknown occupancy at Holiday return requires explicit recovery, rather than inventing Away', () => {
  const holiday = { ...createThermostatControlPolicy(null, true), returnAt: now - 1 };
  const result = evaluateThermostatControlPolicy(holiday, now);
  expect(result.recoveryRequired).toContain('presence is unknown');
  expect(result.holidayActive).toBe(true);
  expect(policyDeadlines(result)).toEqual([]);
});

test('legacy settings migrate without deadlines and startup overdue deadlines never replay', () => {
  expect(restoreThermostatControlPolicy(undefined, true, true, now)).toEqual(createThermostatControlPolicy(true, true));
  const saved = { ...createThermostatControlPolicy(true), actualHome: false, pendingAwayAt: now - 1 };
  const restored = restoreThermostatControlPolicy(saved, null, false, now);
  expect(restored.effectiveHome).toBe(true);
  expect(restored.recoveryRequired).toContain('while Homebridge was stopped');
  expect(policyDeadlines(restored)).toEqual([]);
});

test('validates bounded future dates and minutes', () => {
  expect(policyTimestamp(now + 1000, 'Return', now)).toBe(now + 1000);
  expect(policyTimestamp(null, 'Return', now)).toBeNull();
  expect(() => policyTimestamp(now, 'Return', now)).toThrow('future');
  expect(() => policyTimestamp(now + 367 * 86400000, 'Return', now)).toThrow('year');
  expect(() => policyMinutes(0.5, 'Delay', 1440)).toThrow('whole number');
});
