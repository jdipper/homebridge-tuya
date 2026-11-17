import { createThermostatControlPolicy, evaluateThermostatControlPolicy, policyDeadlines, policyIntent,
  policyMinutes, policyTimestamp, restoreThermostatControlPolicy } from '../../src/device/schedule/ThermostatControlPolicy';

const now = Date.UTC(2026, 0, 1, 12);

test('Away and Home take effect immediately, while a guest hold keeps occupancy separate', () => {
  const home = createThermostatControlPolicy(true);
  const departing = { ...home, actualHome: false };
  expect(evaluateThermostatControlPolicy(departing, now).effectiveHome).toBe(false);
  expect(evaluateThermostatControlPolicy({ ...departing, actualHome: true }, now).effectiveHome).toBe(true);
  const guest = evaluateThermostatControlPolicy({ ...departing, holdUntil: now + 3600000 }, now);
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
  const saved = { ...createThermostatControlPolicy(true), actualHome: false, holdUntil: now - 1 };
  const restored = restoreThermostatControlPolicy(saved, null, false, now);
  expect(restored.effectiveHome).toBe(true);
  expect(restored.recoveryRequired).toContain('while Homebridge was stopped');
  expect(policyDeadlines(restored)).toEqual([]);
});

test.each([now - 1, now + 1800000])('discards an old Away countdown (%s) without scheduling it or requiring recovery', pendingAwayAt => {
  const saved = { ...createThermostatControlPolicy(true), actualHome: false, awayDelayMinutes: 30, pendingAwayAt };
  const restored = restoreThermostatControlPolicy(saved, null, false, now);
  expect(restored).not.toHaveProperty('pendingAwayAt');
  expect(restored).not.toHaveProperty('awayDelayMinutes');
  expect(restored.recoveryRequired).toBeNull();
  expect(policyDeadlines(restored)).toEqual([]);
  expect(evaluateThermostatControlPolicy(restored, now).effectiveHome).toBe(false);
});

test('validates bounded future dates and minutes', () => {
  expect(policyTimestamp(now + 1000, 'Return', now)).toBe(now + 1000);
  expect(policyTimestamp(null, 'Return', now)).toBeNull();
  expect(() => policyTimestamp(now, 'Return', now)).toThrow('future');
  expect(() => policyTimestamp(now + 367 * 86400000, 'Return', now)).toThrow('year');
  expect(() => policyMinutes(0.5, 'Delay', 1440)).toThrow('whole number');
});
