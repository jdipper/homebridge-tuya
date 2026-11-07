#!/usr/bin/env node
'use strict';

// GET-only unless explicitly executed. This diagnostic tests a native Smart-only
// timer; it never puts a temperature, programme, power or lock action in a timer.
const fs = require('node:fs');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const PLUGIN = '/var/lib/homebridge/node_modules/@homebridge-plugins/homebridge-tuya';
const JOURNAL = '/tmp/fastwarm-heating-timer-probe.json';
const TARGET = process.env.FASTWARM_PROBE_DEVICE_ID || '';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: FASTWARM_PROBE_DEVICE_ID=<pilot> node fastwarm-heating-timer-probe.cjs [--execute-timer]\nDefault: authenticated GET-only preflight. Execution requires FASTWARM_EXPECTED_TARGET=20 and FASTWARM_SEQUENCE_NO_BOUNDARY_UNTIL=<ISO timestamp>, independently verified 10–30 minutes ahead. Pilot suffix cdrjgm only.');
  process.exit(0);
}
if (args.some(arg => arg !== '--execute-timer') || args.length > 1
    || !/^[a-z0-9]{16,40}$/.test(TARGET) || !TARGET.endsWith('cdrjgm')) {
  console.error('Only the pilot suffix cdrjgm and optional --execute-timer are accepted.');
  process.exit(2);
}
const execute = args.includes('--execute-timer');
const TIMER_PATH = `/v2.0/cloud/timer/device/${TARGET}`;
const dueAt = Math.ceil((Date.now() + 150000) / 60000) * 60000;
const unique = randomUUID().replaceAll('-', '');
const future = new Date(dueAt);
const dateParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(future);
const task = {
  alias_name: `fwt${unique.slice(0, 8)}`,
  category: `fwheat_${unique.slice(0, 16)}`,
  date: ['year', 'month', 'day'].map(part => dateParts.find(p => p.type === part).value).join(''),
  time: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(future),
  timezone_id: 'Europe/London', loops: '0000000', functions: [{ code: 'ControlMode', value: 'smart' }],
};
const journal = {
  version: 1, startedAt: new Date().toISOString(), execute, targetSuffix: TARGET.slice(-6), task,
  dueAt: new Date(dueAt).toISOString(), events: [], recovery: { required: false, verified: false }, cleanup: { required: false, verified: false },
};
const secrets = [TARGET];
let api;
let stage = 'initialize';
let baseline;
let baselineIds = [];
let createdId;
let creationOutcome = 'not-sent';
let creationAttempted = false;
let heatingAttempted = false;
let holdAttemptedAt;
let holdReportedAt;
let boostReportedAt;
let bestEffort = false;
let abortRequested = false;
let noBoundaryUntil;
let lastReading;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { abortRequested = true; journal.abortRequested = signal; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function scrub(value, key = '') {
  if (/^(?:id|dev_?id|device_?id|uid|uuid|owner_id|home_id|local_?key|key|access_?(?:id|key)|client_?id|sign|ip|lat|lon|.*token|.*secret|.*password)$/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  if (typeof value !== 'string') return value;
  let result = value;
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length >= 6)) result = result.split(secret).join('[redacted]');
  return result.replace(/\bbf[a-z0-9]{15,}\b/gi, '[redacted-device]').slice(0, 1000);
}
function save() {
  journal.currentStage = stage;
  journal.updatedAt = new Date().toISOString();
  const temp = `${JOURNAL}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(scrub(journal), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, JOURNAL);
  } catch (error) {
    if (!bestEffort) throw error;
    journal.persistenceErrors ??= [];
    journal.persistenceErrors.push({ stage, code: error.code, message: scrub(error.message) });
  }
}
function record(label, value) { journal.events.push({ stage: label, at: new Date().toISOString(), ...scrub(value) }); save(); }
function checked(response, label) {
  if (response?.success !== true) throw new Error(`${label}: API rejected request (code ${response?.code ?? 'unknown'}).`);
  return response.result;
}
function proceed() {
  if (abortRequested) throw new Error('Interruption requested; proceeding through recovery and timer cleanup.');
  if (execute && Date.now() + 120000 >= noBoundaryUntil) throw new Error('Programme-boundary safety window expired.');
}
async function signedJson(method, path, params, payload, timeoutMs = 10000) {
  const wire = JSON.stringify(payload);
  const now = Date.now(); const nonce = randomUUID();
  const headers = {
    t: String(now), client_id: api.accessId, nonce, 'Signature-Headers': 'client_id',
    sign: api._getSign(api.accessId, api.accessKey, api.tokenInfo.access_token, now, nonce, api._getStringToSign(method, path, params, payload)),
    sign_method: 'HMAC-SHA256', access_token: api.tokenInfo.access_token,
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path + (params ? '?' + new URLSearchParams(params) : ''), api.endpoint), {
      method: method.toUpperCase(), headers, ...(api.forceIPv4 ? { family: 4 } : {}),
    }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 1000000) req.destroy(new Error('Oversized JSON response.')); });
      res.on('error', reject);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}).`)); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('JSON request deadline expired; outcome uncertain.')), timeoutMs);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(wire);
  });
}
async function get(label, path, params = null, timeoutMs = 7000) {
  stage = label;
  const response = await api.request('get', path, params, null, { attempts: 1, timeoutMs });
  record(label, { response });
  return checked(response, label);
}
const idOf = item => {
  const id = item && (item.timer_id ?? item.time_id);
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) || Number.isSafeInteger(id) ? String(id) : null;
};
function idsOf(items) {
  if (!Array.isArray(items)) throw new Error('Expected an explicit timer list.');
  const ids = items.map(idOf);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Timer IDs are missing or duplicated.');
  return ids.sort();
}
function owned(item) {
  const category = typeof item?.category === 'object' ? item.category?.category : item?.category;
  return item?.alias_name === task.alias_name && (category === undefined || category === task.category);
}
async function reading(label, timeoutMs = 7000) {
  const result = await get(label, `/v2.0/cloud/thing/${TARGET}/shadow/properties`, {
    codes: 'ControlMode,SetTemp,power1,TemperUnitChange,type,RoomTemper',
  }, timeoutMs);
  if (!Array.isArray(result?.properties)) throw new Error(`${label}: missing native properties.`);
  const prop = code => {
    const matches = result.properties.filter(item => item.code === code);
    if (matches.length !== 1) throw new Error(`${label}: missing or duplicate ${code}.`);
    return matches[0];
  };
  const mode = prop('ControlMode'); const target = prop('SetTemp');
  if (!['hold', 'smart', 'holiday'].includes(mode.value) || !Number.isInteger(target.value) || target.value < 50 || target.value > 400
      || !Number.isFinite(mode.time) || !Number.isFinite(target.time) || mode.time > Date.now() + 2000 || target.time > Date.now() + 2000
      || ![true, 1].includes(prop('power1').value) || prop('TemperUnitChange').value !== false || ![0, '0'].includes(prop('type').value)) {
    throw new Error(`${label}: timestamped Celsius thermostat state is not verified.`);
  }
  lastReading = { mode: mode.value, target: target.value, modeReportedAt: mode.time, targetReportedAt: target.time, observedAt: Date.now() };
  record(label + '-parsed', { reading: lastReading });
  return lastReading;
}
function fresh(report, field, value, attemptedAt, prior) {
  return report[field] === value && report[field === 'mode' ? 'modeReportedAt' : 'targetReportedAt'] > prior
    && report[field === 'mode' ? 'modeReportedAt' : 'targetReportedAt'] >= attemptedAt - 2000;
}
function recovered(report) {
  return fresh(report, 'mode', 'smart', holdAttemptedAt,
    Math.max(baseline.modeReportedAt, holdReportedAt ?? 0))
    && fresh(report, 'target', baseline.target, holdAttemptedAt,
      Math.max(baseline.targetReportedAt, boostReportedAt ?? 0))
    && report.modeReportedAt >= holdAttemptedAt && report.targetReportedAt >= holdAttemptedAt;
}
function safe(report) { if (report.target > 220) throw new Error('Target exceeded the 22°C recalled-target cap; recovery required.'); }
async function issue(label, properties, recovery = false) {
  if (!recovery) proceed();
  const entries = Object.entries(properties);
  if (entries.length !== 1 || !(entries[0][0] === 'ControlMode' && ['hold', 'smart'].includes(entries[0][1])
      || entries[0][0] === 'SetTemp' && [baseline.target, baseline.target + 5].includes(entries[0][1]))) throw new Error('Command outside fixed whitelist.');
  stage = label;
  record(label + '-planned', { properties });
  heatingAttempted = true; journal.recovery.required = true;
  const attemptedAt = Date.now();
  holdAttemptedAt ??= attemptedAt;
  if (properties.ControlMode === 'hold') journal.holdAttemptedAt = attemptedAt;
  const response = await signedJson('post', `/v2.0/cloud/thing/${TARGET}/shadow/properties/issue`, null, { properties: JSON.stringify(properties) });
  record(label + '-response', { response });
  checked(response, label);
  return attemptedAt;
}
async function confirm(label, field, value, attemptedAt, prior, recovery = false) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!recovery) proceed();
    const report = await reading(label, Math.max(1, Math.min(7000, deadline - Date.now())));
    if (!recovery) safe(report);
    if (fresh(report, field, value, attemptedAt, prior)) return report;
    await pause(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${label}: fresh ${field}=${value} was not observed.`);
}
async function stable(label, mode, target, recovery = false) {
  const deadline = Date.now() + 10000;
  do {
    if (!recovery) proceed();
    const report = await reading(label);
    if (!recovery) safe(report);
    if (report.mode !== mode || report.target !== target || recovery && !recovered(report)) throw new Error(`${label}: expected mode/target did not remain verified.`);
    if (Date.now() >= deadline) return report;
    await pause(Math.min(2000, deadline - Date.now()));
  } while (true);
}
async function ensureRecovered() {
  if (!heatingAttempted) { journal.recovery.verified = true; return true; }
  try {
    if (recovered(await reading('cleanup-read-heating-state'))) {
      await stable('cleanup-observe-restored-state', 'smart', baseline.target, true);
      journal.recovery.verified = true; journal.recovery.final = lastReading; save(); return true;
    }
  } catch (error) { journal.recovery.initialReadError = scrub(error.message); }
  journal.recovery.fallbackAttempted = true;
  journal.recovery.fallbackAttemptedAt = Date.now();
  save();
  // Always attempt the original target even if the mode request or read fails.
  try { await issue('fallback-smart-only', { ControlMode: 'smart' }, true); }
  catch (error) { journal.recovery.modeCommandError = scrub(error.message); }
  try { await confirm('confirm-fallback-smart', 'mode', 'smart', holdAttemptedAt, baseline.modeReportedAt, true); }
  catch (error) { journal.recovery.modeReadError = scrub(error.message); }
  try { await issue('fallback-original-target-only', { SetTemp: baseline.target }, true); }
  catch (error) { journal.recovery.targetCommandError = scrub(error.message); }
  try {
    await confirm('confirm-fallback-original-target', 'target', baseline.target, holdAttemptedAt, baseline.targetReportedAt, true);
    await stable('observe-fallback-restoration', 'smart', baseline.target, true);
    journal.recovery.verified = true; journal.recovery.final = lastReading;
  } catch (error) { journal.recovery.finalReadError = scrub(error.message); }
  save(); return journal.recovery.verified;
}
async function cleanup() {
  stage = 'cleanup-own-smart-timer';
  journal.cleanup.required = creationAttempted;
  const categoryTasks = await get('reconcile-own-category', TIMER_PATH, { category: task.category });
  if (!Array.isArray(categoryTasks)) throw new Error('Owned-category query did not return a timer list.');
  const exact = categoryTasks.filter(owned);
  const ids = [...new Set([...exact.map(idOf), createdId].filter(Boolean))];
  if (exact.some(item => !idOf(item)) || ids.some(id => baselineIds.includes(id))) throw new Error('Timer cleanup ownership is ambiguous.');
  if (ids.length) {
    stage = 'delete-own-smart-timer';
    const timer_ids = ids.join(',');
    try {
      const response = await signedJson('delete', `${TIMER_PATH}/batch`, { timer_ids }, { timer_ids });
      record(stage, { response });
      checked(response, stage);
    } catch (error) { journal.cleanup.deleteError = scrub(error.message); }
  }
  const all = await get('verify-all-timers-after-cleanup', TIMER_PATH);
  const afterIds = idsOf(all);
  const categoryAfter = await get('verify-own-category-after-cleanup', TIMER_PATH, { category: task.category });
  if (!Array.isArray(categoryAfter)) throw new Error('Final category query did not return a list.');
  journal.cleanup = { ...journal.cleanup,
    ownTaskAbsent: !all.some(owned) && !categoryAfter.some(owned) && ids.every(id => !afterIds.includes(id)),
    baselineUnchanged: JSON.stringify(afterIds) === JSON.stringify(baselineIds),
    ownCategoryEmpty: categoryAfter.length === 0,
    creationReconciled: creationOutcome === 'rejected' || ids.length > 0,
  };
  journal.cleanup.verified = journal.cleanup.ownTaskAbsent && journal.cleanup.baselineUnchanged
    && journal.cleanup.ownCategoryEmpty && journal.cleanup.creationReconciled;
  save();
  if (!journal.cleanup.verified) throw new Error('Timer cleanup is unverified; preserve the journal before another probe.');
}
async function logs() {
  try {
    await get('operation-logs', `/v2.0/cloud/thing/${TARGET}/logs`, {
      type: '5,7,10', start_time: Date.parse(journal.startedAt), end_time: Date.now(), query_type: 1, size: 100,
    });
  } catch (error) { journal.logError = scrub(error.message); save(); }
}
async function runHeatingTest() {
  proceed();
  const saved = await get('verify-saved-smart-timer', TIMER_PATH, { timer_ids: createdId });
  if (!Array.isArray(saved)) throw new Error('Saved timer query did not return a list.');
  const own = saved.find(item => idOf(item) === createdId);
  if (!own || !owned(own) || own.enable !== true || own.date !== task.date || own.time !== task.time
      || own.timezone_id !== task.timezone_id || own.loops !== task.loops || !Array.isArray(own.functions)
      || own.functions.length !== 1 || own.functions[0].code !== 'ControlMode' || own.functions[0].value !== 'smart') {
    throw new Error('Saved timer does not exactly match the enabled one-off native Smart action; refusing Hold.');
  }
  const byCategory = await get('verify-saved-smart-timer-category', TIMER_PATH, { category: task.category });
  if (!Array.isArray(byCategory) || byCategory.filter(item => idOf(item) === createdId && owned(item)).length !== 1) {
    throw new Error('Saved timer category is not verified; refusing Hold.');
  }
  journal.savedTimerVerified = true;
  await pause(Math.max(0, journal.timerAcceptedAt + 15000 - Date.now()));
  proceed();
  const current = await reading('confirm-baseline-before-hold');
  if (current.mode !== 'smart' || current.target !== baseline.target) throw new Error('Baseline changed before Hold; refusing the test.');
  if (dueAt - Date.now() < 60000) throw new Error('Less than 60 seconds remain before the Smart timer; refusing Hold.');
  let attemptedAt = await issue('enter-hold-only', { ControlMode: 'hold' });
  let report = await confirm('confirm-hold-only', 'mode', 'hold', attemptedAt, baseline.modeReportedAt);
  holdReportedAt = report.modeReportedAt;
  journal.holdRecall = report;
  const priorTarget = report.targetReportedAt;
  attemptedAt = await issue('set-boost-target-only', { SetTemp: baseline.target + 5 });
  report = await confirm('confirm-boost-target', 'target', baseline.target + 5, attemptedAt, priorTarget);
  boostReportedAt = report.targetReportedAt;
  if (report.mode !== 'hold') throw new Error('Hold mode changed before boosted target was confirmed.');
  await stable('observe-boosted-hold', 'hold', baseline.target + 5);
  journal.boostVerified = true; save();
  const deadline = dueAt + 12000;
  while (Date.now() < deadline) {
    proceed();
    report = await reading('observe-timed-smart-restoration', Math.max(1, Math.min(7000, deadline - Date.now())));
    safe(report);
    const freshSmart = fresh(report, 'mode', 'smart', holdAttemptedAt, Math.max(baseline.modeReportedAt, holdReportedAt));
    if (freshSmart && (report.modeReportedAt < dueAt || report.observedAt < dueAt)) {
      journal.executionResult = 'early-smart-restoration-inconclusive';
      throw new Error('Smart mode returned before the timer deadline; result is inconclusive.');
    }
    if (freshSmart && report.target === baseline.target && report.modeReportedAt >= dueAt
        && report.targetReportedAt >= dueAt && report.targetReportedAt > baseline.targetReportedAt) {
      journal.scheduledSmartConfirmed = true;
      journal.restoration = report;
      journal.executionResult = 'native-smart-timer-restored-original-target';
      journal.outcome = journal.executionResult;
      save(); return;
    }
    await pause(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
  throw new Error('Fresh Smart and original target were not both observed by deadline +12 seconds; fallback required.');
}
async function main() {
  if (fs.existsSync(JOURNAL)) {
    const stat = fs.lstatSync(JOURNAL);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error('Existing journal is not a regular file owned by this user.');
    const prior = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    if (prior.execute && (prior.cleanup?.required && !prior.cleanup?.verified || prior.recovery?.required && !prior.recovery?.verified)) {
      throw new Error('An earlier heating timer probe has unverified recovery/cleanup; preserve and resolve its journal.');
    }
  }
  save(); stage = 'project-config';
  require(PLUGIN + '/dist/util/Logger').initLogger({ info() {}, warn() {}, debug() {}, error() {} });
  const API = require(PLUGIN + '/dist/core/TuyaOpenAPI').default;
  const config = JSON.parse(fs.readFileSync('/var/lib/homebridge/config.json', 'utf8'));
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
  baselineIds = idsOf(timers);
  if (timers.length !== 0) throw new Error('Preflight requires no existing device timers.');
  baseline = await reading('baseline-native-state'); journal.baseline = baseline;
  if (baseline.mode !== 'smart' || baseline.target !== 200) throw new Error('This timed heating pilot requires Smart mode and the verified 20°C baseline.');
  journal.plan = { baselineCelsius: 20, boostCelsius: 20.5, timerAction: { ControlMode: 'smart' },
    deadlineGraceSeconds: 12, noProgrammePowerLockOrNetworkChanges: true };
  save();
  if (!execute) { journal.outcome = 'read-only-preflight-passed'; return; }
  noBoundaryUntil = Date.parse(process.env.FASTWARM_SEQUENCE_NO_BOUNDARY_UNTIL || '');
  if (Number(process.env.FASTWARM_EXPECTED_TARGET) !== 20 || !Number.isFinite(noBoundaryUntil)
      || noBoundaryUntil - Date.now() < 600000 || noBoundaryUntil - Date.now() > 1800000) {
    throw new Error('Execution requires expected target20 and an independently verified 10–30 minute boundary-free window.');
  }
  journal.noBoundaryUntil = new Date(noBoundaryUntil).toISOString();
  proceed();
  try {
    stage = 'create-own-smart-timer';
    journal.cleanup.required = true;
    save(); // Last mandatory durable checkpoint before any remote mutation.
    proceed(); creationAttempted = true; creationOutcome = 'uncertain'; bestEffort = true;
    const response = await signedJson('post', TIMER_PATH, null, task);
    creationOutcome = response?.success === true ? 'accepted' : response?.success === false ? 'rejected' : 'uncertain';
    createdId = response?.success === true ? idOf(response.result) : null;
    journal.creationOutcome = creationOutcome; journal.createdTimerId = createdId; journal.timerAcceptedAt = Date.now();
    record(stage, { response }); checked(response, stage);
    if (!createdId) {
      const own = await get('reconcile-created-timer-id', TIMER_PATH, { category: task.category });
      if (!Array.isArray(own) || own.filter(owned).length !== 1 || !idOf(own.find(owned))) throw new Error('Created timer ownership is ambiguous.');
      createdId = idOf(own.find(owned)); journal.createdTimerId = createdId; save();
    }
    if (baselineIds.includes(createdId)) throw new Error('Created timer ID overlaps a baseline task.');
    await runHeatingTest();
  } finally {
    if (creationAttempted) {
      journal.creationOutcome = creationOutcome;
      if (!(await ensureRecovered())) {
        journal.cleanup.retainedTimerForSafety = true;
        journal.cleanup.error = 'Heating recovery unverified; native Smart timer retained for safety.';
        save(); await logs();
        throw new Error(journal.cleanup.error);
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
  console.log(JSON.stringify(scrub({ outcome: journal.outcome, executionResult: journal.executionResult, scheduledSmartConfirmed: journal.scheduledSmartConfirmed,
    baseline: journal.baseline, holdRecall: journal.holdRecall, boostVerified: journal.boostVerified, dueAt: journal.dueAt, restoration: journal.restoration,
    recovery: journal.recovery, cleanup: journal.cleanup, creationOutcome: journal.creationOutcome, error: journal.error,
    persistenceErrors: journal.persistenceErrors, journalPath: JOURNAL }), null, 2));
});
