#!/usr/bin/env node
'use strict';

// One dated, bounded investigation. All device commands use Tuya's cloud API;
// the private Homebridge socket only requests/readbacks the native programme.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { randomUUID, createHash } = require('node:crypto');
const PLUGIN = '/var/lib/homebridge/node_modules/@homebridge-plugins/homebridge-tuya';
const STORAGE = '/var/lib/homebridge';
const DIRECTORY = process.env.FASTWARM_BOUNDARY_OUTPUT_DIR || STORAGE + '/fastwarm-investigation/boundary-20261107';
const TARGET = process.env.FASTWARM_PROBE_DEVICE_ID || '';
const EXPECTED_FINGERPRINT = process.env.FASTWARM_BOUNDARY_PROGRAMME_FINGERPRINT || '';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: FASTWARM_PROBE_DEVICE_ID=<pilot> FASTWARM_BOUNDARY_PROGRAMME_FINGERPRINT=<sha256> node fastwarm-heating-boundary-probe.cjs [--preflight | --execute-boundary]\nDefault/--preflight: GET-only device preflight and cached native programme validation. Execution is restricted to 7 November 2026, 21:57:30–21:59:20 UTC; Hold20.5 at21:59, native Smart timer22:01, boundary22:00, bounded recovery.');
  process.exit(0);
}
if (args.some(arg => !['--preflight', '--execute-boundary'].includes(arg)) || args.length > 1
    || !/^[a-z0-9]{16,40}$/.test(TARGET) || !TARGET.endsWith('cdrjgm') || !/^[a-f0-9]{64}$/.test(EXPECTED_FINGERPRINT)) {
  console.error('A pilot suffix cdrjgm, independently verified programme SHA256 and one supported mode are required.');
  process.exit(2);
}
const execute = args.includes('--execute-boundary');
const JOURNAL = DIRECTORY + (execute ? '/execution.json' : '/preflight.json');
const SETUP_AT = Date.parse('2026-11-07T21:57:30Z');
const HOLD_AT = Date.parse('2026-11-07T21:59:00Z');
const HOLD_CUTOFF = Date.parse('2026-11-07T21:59:20Z');
const BOUNDARY_AT = Date.parse('2026-11-07T22:00:00Z');
const RECHECK_AT = Date.parse('2026-11-07T22:00:15Z');
const DUE_AT = Date.parse('2026-11-07T22:01:00Z');
const END_AT = DUE_AT + 15000;
const TIMER_PATH = `/v2.0/cloud/timer/device/${TARGET}`;
const unique = randomUUID().replaceAll('-', '');
const task = { alias_name: `fwb${unique.slice(0, 8)}`, category: `fwbound_${unique.slice(0, 16)}`,
  date: '20261107', time: '22:01', timezone_id: 'Europe/London', loops: '0000000',
  functions: [{ code: 'ControlMode', value: 'smart' }] };
const backupTask = { ...task, alias_name: `fwc${unique.slice(0, 8)}`, time: '22:02', functions: [{ code: 'SetTemp', value: 120 }] };
const plannedTasks = [task, backupTask];
const journal = { version: 1, startedAt: new Date().toISOString(), execute, targetSuffix: TARGET.slice(-6), task, backupTask,
  dueAt: new Date(DUE_AT).toISOString(), boundaryAt: new Date(BOUNDARY_AT).toISOString(), expectedFingerprint: EXPECTED_FINGERPRINT,
  offlineExecutionTested: false, physicalClockAlignmentVerified: false, events: [],
  recovery: { required: false, verified: false }, cleanup: { required: false, verified: false } };
const secrets = [TARGET];
let api; let runtime; let stage = 'initialize'; let bestEffort = false; let abortRequested = false;
let baseline; let createdId; let creationAttempted = false; let creationOutcome = 'not-sent';
const createdIds = [];
let heatingAttempted = false; let holdAttemptedAt; let holdReportedAt = 0; let boostReportedAt = 0;
let lastReading; let externalConflict = false; let programmeVerifiedAt = 0;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { abortRequested = true; journal.abortRequested = signal; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function scrub(value, key = '') {
  if (/^(?:id|dev_?id|device_?id|uid|uuid|owner_id|home_id|local_?key|key|access_?(?:id|key)|client_?id|sign|ip|lat|lon|.*token|.*secret|.*password)$/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  if (typeof value !== 'string') return value;
  let result = value;
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length >= 6)) result = result.split(secret).join('[redacted]');
  return result.replace(/\bbf[a-z0-9]{15,}\b/gi, '[redacted-device]').slice(0, 2000);
}
function save() {
  journal.currentStage = stage; journal.updatedAt = new Date().toISOString();
  const temporary = JOURNAL + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(scrub(journal), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, JOURNAL);
  } catch (error) {
    if (!bestEffort) throw error;
    (journal.persistenceErrors ??= []).push({ stage, code: error.code, message: scrub(error.message) });
  }
}
function record(label, value) { journal.events.push({ stage: label, at: new Date().toISOString(), ...scrub(value) }); save(); }
function checked(response, label) {
  if (response?.success !== true) throw new Error(`${label}: API rejected request (code ${response?.code ?? 'unknown'}).`);
  return response.result;
}
function proceed() {
  if (fs.existsSync(DIRECTORY + '/cancelled.json')) { abortRequested = true; journal.abortRequested = 'cancellation-marker'; }
  if (abortRequested) throw new Error('Interruption requested; entering recovery and owned timer cleanup.');
  if (externalConflict) throw new Error('External state changed; no further heating commands are permitted.');
}
function conflict(message) {
  externalConflict = true; journal.externalConflict = message;
  journal.recovery.skippedForExternalConflict = true; journal.recovery.required = false;
  throw new Error(message);
}
async function signedJson(method, path, params, payload, timeoutMs = 7000) {
  const wire = JSON.stringify(payload); const now = Date.now(); const nonce = randomUUID();
  const headers = { t: String(now), client_id: api.accessId, nonce, 'Signature-Headers': 'client_id',
    sign: api._getSign(api.accessId, api.accessKey, api.tokenInfo.access_token, now, nonce, api._getStringToSign(method, path, params, payload)),
    sign_method: 'HMAC-SHA256', access_token: api.tokenInfo.access_token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire) };
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path + (params ? '?' + new URLSearchParams(params) : ''), api.endpoint), {
      method: method.toUpperCase(), headers, ...(api.forceIPv4 ? { family: 4 } : {}),
    }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('error', reject);
      res.on('data', chunk => { data += chunk; if (data.length > 1000000) req.destroy(new Error('Oversized JSON response.')); });
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}).`)); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('JSON deadline expired; mutation outcome uncertain.')), timeoutMs);
    req.on('error', error => { clearTimeout(timer); reject(error); }); req.end(wire);
  });
}
async function get(label, path, params = null, timeoutMs = 6000) {
  stage = label; const response = await api.request('get', path, params, null, { attempts: 1, timeoutMs });
  record(label, { response }); return checked(response, label);
}
function discoverRuntime() {
  const persist = STORAGE + '/persist';
  const candidates = fs.readdirSync(persist).filter(name => /^TuyaRuntime\.[a-f0-9]{16}\.json$/.test(name)).map(name => {
    const path = persist + '/' + name; const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
    const item = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (item.version !== 1 || item.plugin !== '@homebridge-plugins/homebridge-tuya' || !/^[a-f0-9]{16}$/.test(item.instanceId)
        || name !== `TuyaRuntime.${item.instanceId}.json` || !/^[a-f0-9]{64}$/.test(item.token)
        || !Number.isSafeInteger(item.pid) || item.pid <= 0 || item.socketPath !== `${persist}/tuya-${item.instanceId}.sock`) return null;
    return item;
  }).filter(Boolean);
  if (candidates.length !== 1) throw new Error('A single private Homebridge runtime descriptor is required.');
  runtime = candidates[0]; secrets.push(runtime.token);
}
async function runtimeRequest(path, payload) {
  if (!['/thermostats', '/schedules/read'].includes(path)) throw new Error('Runtime route outside read-only programme whitelist.');
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: runtime.socketPath, path, method: 'POST',
      headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('error', reject);
      res.on('data', chunk => { data += chunk; if (data.length > 4000000) req.destroy(new Error('Oversized runtime response.')); });
      res.on('end', () => { clearTimeout(timer); try {
        if (res.statusCode < 200 || res.statusCode >= 300) throw new Error('Runtime rejected native programme read.');
        resolve(JSON.parse(data));
      } catch (error) { reject(error); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('Runtime request deadline expired.')), 5000);
    req.on('error', error => { clearTimeout(timer); reject(error); }); req.end(body);
  });
}
function validateProgramme(view, freshSince = 0) {
  const matches = view?.thermostats?.filter(item => item.id === TARGET);
  if (!matches || matches.length !== 1) throw new Error('Pilot runtime view is missing or duplicated.');
  const room = matches[0]; const schedule = room.schedule;
  if (room.online !== true || room.timeZone !== 'Europe/London' || room.sync?.status !== 'verified'
      || !Number.isFinite(room.lastUpdated) || room.lastUpdated < freshSince || room.lastUpdated > Date.now() + 2000
      || schedule?.complete !== true || !Array.isArray(schedule.days) || schedule.days.length !== 7) throw new Error('Complete fresh native programme is not verified.');
  const days = [1, 2, 4, 8, 16, 32, 64];
  for (let index = 0; index < days.length; index++) {
    const day = schedule.days[index];
    if (day.day !== days[index] || day.complete !== true || !Array.isArray(day.events) || day.events.length !== 4) throw new Error('Native programme must contain all ordered 28 events.');
    let previous = -1;
    day.events.forEach((event, eventIndex) => {
      const minute = event.hour * 60 + event.minute;
      if (event.event !== eventIndex || !Number.isInteger(event.hour) || event.hour < 0 || event.hour > 23
          || !Number.isInteger(event.minute) || event.minute < 0 || event.minute > 59 || minute <= previous
          || !Number.isInteger(event.temperature * 2) || event.temperature < 5 || event.temperature > 40) throw new Error('Invalid native programme event.');
      previous = minute;
    });
  }
  const actual = createHash('sha256').update(JSON.stringify(schedule.days.map(day => [day.day, day.events]))).digest('hex');
  if (actual !== room.scheduleFingerprint) throw new Error('Runtime programme fingerprint does not match its complete native state.');
  if (actual !== EXPECTED_FINGERPRINT) {
    journal.programmeConflict = { fingerprint: actual, observedAt: Date.now(), lastUpdated: room.lastUpdated };
    throw new Error('Native programme changed; stop the test, remove its fixed-temperature backup and recover our Hold with Smart only.');
  }
  const saturday = schedule.days[5].events;
  const before = saturday.filter(event => event.hour * 60 + event.minute <= 21 * 60 + 59).at(-1);
  const after = saturday.filter(event => event.hour * 60 + event.minute <= 22 * 60 + 1).at(-1);
  if (before?.temperature !== 20 || after?.temperature !== 12 || after.hour !== 22 || after.minute !== 0) throw new Error('Expected Saturday22:00 20→12°C native event is not verified.');
  journal.programme = { fingerprint: actual, lastUpdated: room.lastUpdated, timeZone: room.timeZone,
    clockVerifiedInSettings: room.clockVerified === true, before, after, events: schedule.days };
  programmeVerifiedAt = Date.now(); save(); return room;
}
async function programme(label, refresh, recovery = false) {
  stage = label; const started = Date.now();
  if (refresh) await runtimeRequest('/schedules/read', { deviceIds: [TARGET] });
  const deadline = started + 34000;
  do {
    if (!recovery) proceed(); const view = await runtimeRequest('/thermostats', {});
    const room = view?.thermostats?.find(item => item.id === TARGET);
    if (!refresh || room?.sync?.status === 'verified' && room.lastUpdated >= started) {
      const result = validateProgramme(view, refresh ? started : 0);
      record(label, { fingerprint: result.scheduleFingerprint, lastUpdated: result.lastUpdated }); return result;
    }
    if (['failed', 'partial'].includes(room?.sync?.status)) throw new Error('Fresh native programme inquiry failed or was incomplete.');
    await pause(1000);
  } while (Date.now() < deadline);
  throw new Error('Fresh complete native programme inquiry deadline expired.');
}
async function reading(label, timeoutMs = 6000) {
  const result = await get(label, `/v2.0/cloud/thing/${TARGET}/shadow/properties`, { codes: 'ControlMode,SetTemp,power1,TemperUnitChange,type,RoomTemper' }, timeoutMs);
  if (!Array.isArray(result?.properties)) throw new Error('Missing native properties.');
  const prop = code => { const matches = result.properties.filter(item => item.code === code);
    if (matches.length !== 1) throw new Error('Missing or duplicated native ' + code); return matches[0]; };
  const mode = prop('ControlMode'); const target = prop('SetTemp');
  if (!['hold', 'smart', 'holiday'].includes(mode.value) || !Number.isInteger(target.value) || target.value < 50 || target.value > 400
      || !Number.isFinite(mode.time) || !Number.isFinite(target.time) || mode.time > Date.now() + 2000 || target.time > Date.now() + 2000) throw new Error('Timestamped native mode/target not verified.');
  if (![true, 1].includes(prop('power1').value) || prop('TemperUnitChange').value !== false || ![0, '0'].includes(prop('type').value)) conflict('Thermostat power, unit or operating type changed; preserving external state.');
  lastReading = { mode: mode.value, target: target.value, modeReportedAt: mode.time, targetReportedAt: target.time, observedAt: Date.now() };
  record(label + '-parsed', { reading: lastReading }); return lastReading;
}
function fresh(report, field, value, attemptedAt, prior) {
  const time = report[field === 'mode' ? 'modeReportedAt' : 'targetReportedAt'];
  return report[field] === value && time > prior && time >= attemptedAt - 2000;
}
function expectedTarget() { return Date.now() >= BOUNDARY_AT ? 120 : 200; }
function recovered(report) {
  return report.mode === 'smart' && report.target === expectedTarget()
    && report.modeReportedAt > Math.max(baseline.modeReportedAt, holdReportedAt)
    && report.targetReportedAt > Math.max(baseline.targetReportedAt, boostReportedAt)
    && report.modeReportedAt >= holdAttemptedAt && report.targetReportedAt >= holdAttemptedAt;
}
function knownActivationRecall(report) {
  return journal.activationRecallExceededCap && report.target === journal.activationRecallTarget
    && ['hold', 'smart'].includes(report.mode);
}
function inspect(report, { settling = false } = {}) {
  if (settling && report.mode === 'hold' && report.target > 220) {
    journal.activationRecallExceededCap = true; journal.activationRecallTarget = report.target;
    throw new Error('Our Hold activation recalled a target above22°C; aborting activation and restoring the active programme target.');
  }
  if (report.mode === 'holiday' || report.target > 220) conflict('Unexpected mode/temperature outside the authorized test; preserving external state.');
  if (!settling && Date.now() < DUE_AT && (report.mode !== 'hold' || report.target !== 205)) conflict('Manual/early mode or target change during Hold; preserving external state.');
  if (Date.now() >= DUE_AT && ![120, 195, 200, 205, 220].includes(report.target)) conflict('Unexpected target at restoration; preserving external state.');
}
async function issue(label, properties, recovery = false) {
  if (!recovery) proceed();
  if (externalConflict) throw new Error('Heating commands blocked by external conflict.');
  const entries = Object.entries(properties);
  if (entries.length !== 1 || !(entries[0][0] === 'ControlMode' && ['hold', 'smart'].includes(entries[0][1])
      || entries[0][0] === 'SetTemp' && [120, 200, 205].includes(entries[0][1]))) throw new Error('Heating command outside fixed whitelist.');
  if (properties.ControlMode === 'hold' && (Date.now() < HOLD_AT || Date.now() > HOLD_CUTOFF)) throw new Error('Dated Hold activation window expired; no late catch-up permitted.');
  if (properties.SetTemp === 205 && (Date.now() > HOLD_CUTOFF || !holdReportedAt)) throw new Error('Boost activation window expired or Hold unconfirmed.');
  if (properties.SetTemp === 200 && Date.now() >= BOUNDARY_AT - 15000) throw new Error('Refusing a stale20°C recovery at or near the12°C boundary.');
  stage = label; record(label + '-planned', { properties }); heatingAttempted = true; journal.recovery.required = true;
  const attemptedAt = Date.now(); holdAttemptedAt ??= attemptedAt;
  const response = await signedJson('post', `/v2.0/cloud/thing/${TARGET}/shadow/properties/issue`, null, { properties: JSON.stringify(properties) });
  record(label + '-response', { response }); checked(response, label); return attemptedAt;
}
async function confirm(label, field, value, attemptedAt, prior, recovery = false) {
  const deadline = Date.now() + 14000;
  while (Date.now() < deadline) {
    if (!recovery) proceed();
    const report = await reading(label, Math.max(1, Math.min(6000, deadline - Date.now())));
    if (!recovery) inspect(report, { settling: true });
    else if (report.mode === 'holiday' || ![120, 195, 200, 205, 220].includes(report.target)
      && !knownActivationRecall(report)) conflict('External mode/target change during recovery; preserving state.');
    if (fresh(report, field, value, attemptedAt, prior)) return report;
    await pause(Math.min(1500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${label}: fresh ${field}=${value} was not observed.`);
}
function idOf(item) { const id = item && (item.timer_id ?? item.time_id);
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) || Number.isSafeInteger(id) ? String(id) : null; }
function owned(item) { const category = typeof item?.category === 'object' ? item.category?.category : item?.category;
  return plannedTasks.some(plan => item?.alias_name === plan.alias_name && (category === undefined || category === plan.category)); }
async function verifyTimer() {
  for (let index = 0; index < plannedTasks.length; index++) {
    const plan = plannedTasks[index];
    const saved = await get('verify-saved-timer-' + index, TIMER_PATH, { timer_ids: createdIds[index] });
    const own = Array.isArray(saved) && saved.find(item => idOf(item) === createdIds[index]);
    if (!own || own.alias_name !== plan.alias_name || !owned(own) || own.enable !== true || own.date !== plan.date || own.time !== plan.time
        || own.timezone_id !== plan.timezone_id || own.loops !== plan.loops || JSON.stringify(own.functions) !== JSON.stringify(plan.functions)) throw new Error('Saved native timer does not exactly match its enabled one-off action; refusing Hold.');
  }
  const all = await get('verify-only-own-timer', TIMER_PATH);
  const category = await get('verify-own-timer-category', TIMER_PATH, { category: task.category });
  if (!Array.isArray(all) || all.length !== 2 || !all.every(item => createdIds.includes(idOf(item)) && owned(item))
      || !Array.isArray(category) || category.length !== 2 || !category.every(item => createdIds.includes(idOf(item)) && owned(item))) throw new Error('Timer ownership or baseline changed; refusing Hold.');
  journal.savedTimerVerified = true; save();
}
async function cleanup() {
  stage = 'cleanup-own-smart-timer';
  const category = await get('reconcile-own-timer-category', TIMER_PATH, { category: task.category });
  if (!Array.isArray(category)) throw new Error('Owned timer list is not explicit.');
  const exact = category.filter(owned);
  const remainingCreatedIds = createdIds.filter(id => !(journal.cleanup.fixedBackupAbsent && id === createdIds[1]));
  const ids = [...new Set([...exact.map(idOf), ...remainingCreatedIds].filter(Boolean))];
  if (exact.some(item => !idOf(item))) throw new Error('Owned timer identity is ambiguous.');
  if (ids.length) {
    const timer_ids = ids.join(',');
    try { const response = await signedJson('delete', TIMER_PATH + '/batch', { timer_ids }, { timer_ids });
      record('delete-own-smart-timer', { response }); checked(response, 'delete-own-smart-timer');
    } catch (error) { journal.cleanup.deleteError = scrub(error.message); }
  }
  const all = await get('verify-all-timers-after-cleanup', TIMER_PATH);
  const ownAfter = await get('verify-own-category-after-cleanup', TIMER_PATH, { category: task.category });
  if (!Array.isArray(all) || !Array.isArray(ownAfter)) throw new Error('Final timer lists are not explicit.');
  journal.cleanup = { ...journal.cleanup, ownTaskAbsent: !all.some(owned) && ids.every(id => !all.some(item => idOf(item) === id)),
    ownCategoryEmpty: ownAfter.length === 0, baselineUnchanged: all.length === 0,
    creationReconciled: creationOutcome === 'rejected' || ids.length > 0 };
  journal.cleanup.verified = journal.cleanup.ownTaskAbsent && journal.cleanup.ownCategoryEmpty && journal.cleanup.creationReconciled
    && journal.cleanup.baselineUnchanged;
  save(); if (!journal.cleanup.verified) throw new Error('Owned timer cleanup is unverified.');
}
async function removeFixedBackup() {
  let category;
  try {
    category = await get('reconcile-invalid-fixed-backup', TIMER_PATH, { category: task.category });
    if (!Array.isArray(category)) throw new Error('Fixed backup ownership query did not return a list.');
  } catch (error) {
    journal.cleanup.backupReconcileError = scrub(error.message);
    // This ID was acknowledged and independently read back before Hold. A
    // failed list query must not prevent cancellation of that exact backup.
    if (!createdIds[1]) throw error;
    category = [];
  }
  const matches = category.filter(item => item.alias_name === backupTask.alias_name && owned(item));
  if (matches.some(item => !idOf(item))) throw new Error('Fixed backup identity is ambiguous.');
  const ids = [...new Set([...matches.map(idOf), createdIds[1]].filter(Boolean))];
  if (ids.length) {
    const timer_ids = ids.join(',');
    try {
      const response = await signedJson('delete', TIMER_PATH + '/batch', { timer_ids }, { timer_ids });
      record('delete-invalid-fixed-backup', { response }); checked(response, 'delete-invalid-fixed-backup');
    } catch (error) { journal.cleanup.backupDeleteError = scrub(error.message); }
  }
  const after = await get('verify-invalid-fixed-backup-absent', TIMER_PATH, { category: task.category });
  journal.cleanup.fixedBackupAbsent = Array.isArray(after) && !after.some(item => item.alias_name === backupTask.alias_name)
    && ids.every(id => !after.some(item => idOf(item) === id));
  save();
  if (!journal.cleanup.fixedBackupAbsent) throw new Error('Changed-programme fixed backup cancellation is unverified.');
}
async function recoverChangedProgramme() {
  journal.recovery.smartOnly = true; journal.recovery.targetNotVerified = true; journal.recovery.requiresReview = true;
  // A fixed12°C task is no longer justified by the programme. Remove it even
  // when a cloud read fails, preserving the native Smart-only safety task.
  try { await removeFixedBackup(); }
  catch (error) { journal.recovery.backupCancellationError = scrub(error.message); }
  if (!heatingAttempted) { journal.recovery.required = false; return true; }
  let report;
  try { report = await reading('programme-conflict-current-state'); }
  catch (error) { journal.recovery.conflictStateError = scrub(error.message); return externalConflict; }
  if (externalConflict) return true;
  if (report.mode === 'smart' && report.modeReportedAt > Math.max(baseline.modeReportedAt, holdReportedAt)
      && report.modeReportedAt >= holdAttemptedAt && Date.now() >= DUE_AT) {
    journal.recovery.smartOnlyVerified = true; journal.recovery.final = report; save(); return journal.cleanup.fixedBackupAbsent === true;
  }
  if (!(report.mode === 'hold' && (report.target === 205 || knownActivationRecall(report)))) {
    try { conflict('Manual mode/target change accompanies the programme edit; preserving external state.'); }
    catch { return true; }
  }
  journal.recovery.fallbackAttempted = true; save();
  let attemptedAt;
  try { attemptedAt = await issue('programme-conflict-smart-only', { ControlMode: 'smart' }, true); }
  catch (error) { journal.recovery.modeCommandError = scrub(error.message); }
  const deadline = Date.now() + 14000;
  try {
    do {
      report = await reading('confirm-programme-conflict-smart-only', Math.max(1, Math.min(6000, deadline - Date.now())));
      if (report.mode === 'holiday' || report.mode === 'hold' && report.target !== 205 && !knownActivationRecall(report)) {
        conflict('Manual state changed during Smart-only recovery; preserving external state.');
      }
      if (fresh(report, 'mode', 'smart', attemptedAt ?? holdAttemptedAt, Math.max(baseline.modeReportedAt, holdReportedAt))) {
        journal.recovery.smartOnlyVerified = true; journal.recovery.final = report; save();
        return journal.cleanup.fixedBackupAbsent === true;
      }
      await pause(Math.min(1500, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new Error('Fresh Smart mode after the programme edit was not confirmed; retaining the native Smart safety task.');
  } catch (error) { journal.recovery.smartOnlyError = scrub(error.message); save(); return externalConflict; }
}
async function stableRecovered() {
  const until = Date.now() + 6000;
  do {
    const report = await reading('observe-restored-state-stability');
    if (knownActivationRecall(report)) throw new Error('The high target recalled by our Hold command has not yet been restored.');
    if (report.mode === 'holiday' || ![120, 195, 200, 205, 220].includes(report.target)) conflict('External change while confirming restoration; preserving state.');
    if (!recovered(report)) throw new Error('Fresh Scheduled/active-period target did not remain stable.');
    if (Date.now() >= until) return report;
    await pause(Math.min(1500, until - Date.now()));
  } while (true);
}
async function ensureRecovered() {
  if (externalConflict) { journal.recovery.skippedForExternalConflict = true; return true; }
  if (journal.programmeConflict) return recoverChangedProgramme();
  if (!heatingAttempted) { journal.recovery.verified = true; return true; }
  try {
    const report = await reading('cleanup-read-heating-state');
    if (report.mode === 'holiday' || ![120, 195, 200, 205, 220].includes(report.target)
      && !knownActivationRecall(report)) conflict('External change detected before recovery; preserving state.');
    if (recovered(report)) { journal.recovery.final = await stableRecovered(); journal.recovery.verified = true; save(); return true; }
  } catch (error) { journal.recovery.initialReadError = scrub(error.message); if (externalConflict) return true; }
  // No fixed12/20°C command is allowed using an old or changed programme.
  try { if (Date.now() - programmeVerifiedAt > 45000) await programme('fresh-programme-before-fallback', true, true); }
  catch (error) {
    journal.recovery.programmeReadError = scrub(error.message);
    if (journal.programmeConflict) return recoverChangedProgramme();
    return externalConflict;
  }
  journal.recovery.fallbackAttempted = true; save();
  let attemptedAt;
  try { attemptedAt = await issue('fallback-smart-only', { ControlMode: 'smart' }, true); }
  catch (error) { journal.recovery.modeCommandError = scrub(error.message); }
  try { await confirm('confirm-fallback-smart', 'mode', 'smart', attemptedAt ?? holdAttemptedAt, baseline.modeReportedAt, true); }
  catch (error) { journal.recovery.modeReadError = scrub(error.message); }
  if (externalConflict) { save(); return true; }
  // If recovery began just before the change, wait through the boundary so an
  // in-flight20°C command cannot reintroduce the old target after22:00.
  if (Date.now() >= BOUNDARY_AT - 15000 && Date.now() < BOUNDARY_AT) await pause(BOUNDARY_AT - Date.now());
  const target = expectedTarget();
  try { attemptedAt = await issue('fallback-active-period-target-only', { SetTemp: target }, true); }
  catch (error) { journal.recovery.targetCommandError = scrub(error.message); }
  try {
    await confirm('confirm-fallback-active-period-target', 'target', target, attemptedAt ?? holdAttemptedAt, baseline.targetReportedAt, true);
    const final = await stableRecovered();
    if (!recovered(final)) throw new Error('Final fresh Smart/active-period target not verified.');
    journal.recovery.verified = true; journal.recovery.final = final;
  } catch (error) { journal.recovery.finalReadError = scrub(error.message); }
  save(); return externalConflict || journal.recovery.verified;
}
async function logs() { try { await get('operation-logs', `/v2.0/cloud/thing/${TARGET}/logs`, {
  type: '5,7,10', start_time: Date.parse(journal.startedAt), end_time: Date.now(), query_type: 1, size: 100,
}); } catch (error) { journal.logError = scrub(error.message); save(); } }
async function runTest() {
  await verifyTimer();
  await pause(Math.max(0, journal.timerAcceptedAt + 15000 - Date.now()));
  while (Date.now() < HOLD_AT) { proceed(); await pause(Math.min(1000, HOLD_AT - Date.now())); }
  proceed(); if (Date.now() > HOLD_CUTOFF) throw new Error('Hold start deadline expired; refusing late execution.');
  const current = await reading('verify-baseline-immediately-before-hold');
  if (current.mode !== 'smart' || current.target !== 200 || current.modeReportedAt !== baseline.modeReportedAt || current.targetReportedAt !== baseline.targetReportedAt) throw new Error('Baseline changed before Hold; refusing activation.');
  let at = await issue('enter-hold-only', { ControlMode: 'hold' });
  let report = await confirm('confirm-hold-only', 'mode', 'hold', at, baseline.modeReportedAt);
  holdReportedAt = report.modeReportedAt; journal.holdRecall = report;
  at = await issue('set-boost-target-only', { SetTemp: 205 });
  report = await confirm('confirm-boost-target', 'target', 205, at, report.targetReportedAt);
  boostReportedAt = report.targetReportedAt;
  if (report.mode !== 'hold') conflict('Hold changed while boosted temperature was being confirmed.');
  journal.boostVerified = true; save();
  let rechecked = false;
  while (Date.now() < END_AT) {
    proceed();
    if (!rechecked && Date.now() >= RECHECK_AT && Date.now() < DUE_AT) {
      await programme('fresh-programme-during-boundary-hold', true); rechecked = true;
      if (Date.now() >= DUE_AT - 3000) throw new Error('Programme read overran the restoration safety margin.');
    }
    report = await reading('observe-boundary-and-timed-restoration', Math.max(1, Math.min(6000, END_AT - Date.now())));
    inspect(report);
    if (Date.now() >= BOUNDARY_AT && Date.now() < DUE_AT && report.mode === 'hold' && report.target === 205) {
      journal.holdObservedAfterBoundary = true; journal.holdAfterBoundary = report;
    }
    if (report.mode === 'smart' && report.modeReportedAt >= DUE_AT && report.modeReportedAt > holdReportedAt) {
      journal.timerSmartObserved = report;
      if (report.target === 120 && report.targetReportedAt >= DUE_AT && report.targetReportedAt > boostReportedAt
          && journal.holdObservedAfterBoundary && rechecked) {
        journal.scheduledSmartConfirmed = true; journal.restoration = report;
        journal.outcome = 'native-smart-timer-selected-new-programme-period'; save(); return;
      }
    }
    await pause(Math.min(1500, Math.max(0, END_AT - Date.now())));
  }
  journal.executionResult = journal.timerSmartObserved
    ? (journal.timerSmartObserved.target === 200 ? 'native-smart-timer-returned-prior-target-clock-unverified' : 'native-smart-timer-returned-other-target-clock-unverified')
    : 'native-smart-timer-not-observed';
  throw new Error('Fresh Smart/12°C was not observed at the22:01 deadline; controlled fallback required.');
}
async function main() {
  if (execute && (Date.now() < SETUP_AT || Date.now() > HOLD_CUTOFF)) throw new Error('Execution is permitted only7Nov2026 21:57:30–21:59:20UTC; no late catch-up.');
  fs.mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(DIRECTORY);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077)) throw new Error('Output directory must be a private directory owned by this user.');
  if (fs.existsSync(JOURNAL)) {
    const stat = fs.lstatSync(JOURNAL);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Existing journal is not private and owned.');
    const prior = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    if (execute || prior.execute && (!prior.cleanup?.verified || prior.recovery?.required && !prior.recovery?.verified)) throw new Error('Refusing to overwrite an execution journal or unresolved earlier run.');
  }
  save(); stage = 'project-config';
  require(PLUGIN + '/dist/util/Logger').initLogger({ info() {}, warn() {}, debug() {}, error() {} });
  const API = require(PLUGIN + '/dist/core/TuyaOpenAPI').default;
  const config = JSON.parse(fs.readFileSync(STORAGE + '/config.json', 'utf8'));
  const options = config.platforms.find(p => p.platform === 'TuyaPlatform')?.options;
  if (!options?.accessId || !options?.accessKey) throw new Error('Tuya project credentials unavailable.');
  secrets.push(options.accessId, options.accessKey, options.username, options.password);
  api = new API(options.endpoint || API.getDefaultEndpoint(Number(options.countryCode)), options.accessId, options.accessKey, 'en', false, options.forceIPv4);
  const token = await get('project-token', '/v1.0/token', { grant_type: 1 });
  if (!token?.access_token || !Number.isFinite(token.expire_time)) throw new Error('Unexpected project-token schema.');
  api.tokenInfo = { access_token: token.access_token, refresh_token: token.refresh_token, uid: token.uid, expire: Date.now() + token.expire_time * 1000 };
  secrets.push(token.access_token, token.refresh_token, token.uid);
  const details = await get('device-details', `/v1.0/devices/${TARGET}`);
  if (details?.online !== true || details?.product_id !== 'lmtejj3f4kafi2k1') throw new Error('Expected online pilot product is not verified.');
  const timers = await get('baseline-timers', TIMER_PATH);
  if (!Array.isArray(timers) || timers.length !== 0) throw new Error('Baseline requires an explicit empty native timer list.');
  baseline = await reading('baseline-native-state'); journal.baseline = baseline;
  if (baseline.mode !== 'smart' || baseline.target !== 200) throw new Error('Boundary investigation requires Smart/20°C baseline.');
  discoverRuntime(); await programme('verify-native-programme', execute);
  if (!execute) { journal.outcome = 'read-only-preflight-passed'; return; }
  if (Date.now() > HOLD_AT - 15000) throw new Error('Insufficient setup/flash-settle time before21:59 Hold; refusing test.');
  try {
    proceed(); stage = 'create-own-smart-timer'; journal.cleanup.required = true; save();
    proceed(); creationAttempted = true; creationOutcome = 'uncertain'; bestEffort = true;
    for (const plan of plannedTasks) {
      proceed();
      const response = await signedJson('post', TIMER_PATH, null, plan);
      creationOutcome = response?.success === true ? 'accepted' : response?.success === false ? 'rejected' : 'uncertain';
      createdId = response?.success === true ? idOf(response.result) : null;
      journal.creationOutcome = creationOutcome; journal.timerAcceptedAt = Date.now();
      record(stage, { response }); checked(response, stage);
      if (!createdId) { const own = await get('reconcile-created-timer-id', TIMER_PATH, { category: task.category });
        const exact = Array.isArray(own) && own.filter(item => item.alias_name === plan.alias_name && owned(item));
        if (!exact || exact.length !== 1 || !idOf(exact[0])) throw new Error('Created timer ownership is ambiguous.');
        createdId = idOf(exact[0]); }
      if (createdIds.includes(createdId)) throw new Error('Native timer ID duplicated across one-off actions.');
      createdIds.push(createdId); journal.createdTimerIds = [...createdIds]; save();
    }
    await runTest();
  } finally {
    if (creationAttempted) {
      journal.creationOutcome = creationOutcome;
      if (!(await ensureRecovered())) {
        journal.cleanup.retainedTimerForSafety = true; journal.cleanup.error = 'Heating restoration is unverified; retaining native Smart timer.';
        save(); await logs(); throw new Error(journal.cleanup.error);
      }
      try { await cleanup(); } finally { await logs(); }
    }
  }
}
main().catch(error => {
  journal.outcome = 'failed'; journal.failedStage = stage; journal.error = scrub(error.message); process.exitCode = 1;
}).finally(() => {
  journal.finishedAt = new Date().toISOString();
  if (stage !== 'initialize') { try { save(); } catch { process.exitCode = 1; } }
  if (journal.persistenceErrors?.length) process.exitCode = 1;
  console.log(JSON.stringify(scrub({ outcome: journal.outcome, executionResult: journal.executionResult,
    scheduledSmartConfirmed: journal.scheduledSmartConfirmed, baseline: journal.baseline, holdRecall: journal.holdRecall,
    boostVerified: journal.boostVerified, holdObservedAfterBoundary: journal.holdObservedAfterBoundary,
    dueAt: journal.dueAt, restoration: journal.restoration, recovery: journal.recovery, cleanup: journal.cleanup,
    creationOutcome: journal.creationOutcome, externalConflict: journal.externalConflict, error: journal.error,
    programmeConflict: journal.programmeConflict,
    persistenceErrors: journal.persistenceErrors, journalPath: JOURNAL }), null, 2));
});
