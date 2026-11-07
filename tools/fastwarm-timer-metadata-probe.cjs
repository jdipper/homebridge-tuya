#!/usr/bin/env node
'use strict';

// Read-only by default. --execute creates only a distant native Lock:false timer,
// disables it, reads its metadata, and removes it. --execute-online additionally
// tests keypad Lock only, with a scheduled unlock and immediate API fallback.
const fs = require('node:fs');
const https = require('node:https');
const { randomUUID } = require('node:crypto');

const TARGET = process.env.FASTWARM_PROBE_DEVICE_ID || '';
const PLUGIN = '/var/lib/homebridge/node_modules/@homebridge-plugins/homebridge-tuya';
const TIMER_PATH = `/v2.0/cloud/timer/device/${TARGET}`;
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: FASTWARM_PROBE_DEVICE_ID=<pilot-device-id> node fastwarm-timer-metadata-probe.cjs [--execute | --execute-online]\nDefault: authenticated GET preflight and plan only. --execute-online tests keypad lock/unlock only. Pilot suffix must be cdrjgm.');
  process.exit(0);
}
if (args.some(arg => !['--execute', '--execute-online'].includes(arg)) || args.length > 1) {
  console.error('Only --execute or --execute-online is accepted; the pilot target and lock actions are fixed.');
  process.exit(2);
}
if (!/^[a-z0-9]{16,40}$/.test(TARGET) || !TARGET.endsWith('cdrjgm')) {
  console.error('FASTWARM_PROBE_DEVICE_ID must identify the approved pilot thermostat ending cdrjgm.');
  process.exit(2);
}
const online = args.includes('--execute-online');
const execute = online || args.includes('--execute');
const JOURNAL = online ? '/tmp/fastwarm-timer-execution-probe.json' : '/tmp/fastwarm-timer-metadata-probe.json';
const dueAt = Math.ceil((Date.now() + 90000) / 60000) * 60000;
const unique = randomUUID().replaceAll('-', '');
const future = new Date(online ? dueAt : Date.now() + 7 * 86400000);
const dateParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(future);
const date = ['year', 'month', 'day'].map(part => dateParts.find(p => p.type === part).value).join('');
const time = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(future);
const body = {
  alias_name: `fwp${unique.slice(0, 8)}`,
  time: online ? time : '12:00', timezone_id: 'Europe/London', date, loops: '0000000',
  functions: [{ code: 'Lock', value: false }], category: `fwprobe_${unique.slice(0, 16)}`,
};
const journal = {
  version: 1, startedAt: new Date().toISOString(), execute, online, targetSuffix: TARGET.slice(-6),
  request: body, events: [], cleanup: { required: false, verified: false },
};
const secrets = [TARGET];
let api;
let stage = 'initialize';
let baselineIds = [];
let returnedId;
let createAttempted = false;
let createOutcome = 'not-sent';
let persistenceBestEffort = false;
let abortRequested = false;
const execution = { dueAt: new Date(dueAt).toISOString(), fallbackAttempted: false, unlockedVerified: false };
if (online) journal.execution = execution;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  abortRequested = true;
  journal.abortRequested = signal;
});
function continueProbe() {
  if (abortRequested) throw new Error('Probe interruption requested; proceeding through unlock and cleanup.');
}
const idOf = task => {
  const id = task && (task.timer_id ?? task.time_id);
  return (typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)) || Number.isSafeInteger(id) ? String(id) : null;
};
function scrub(value, key = '') {
  if (/^(?:id|dev_?id|device_?id|uid|local_?key|key|access_?(?:id|key)|client_?id|sign|.*token|.*secret|.*password)$/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets.filter(s => typeof s === 'string' && s.length >= 6)) result = result.split(secret).join('[redacted]');
    return result.replace(/\bbf[a-z0-9]{15,}\b/gi, '[redacted-device]').slice(0, 1000);
  }
  return value;
}
function save() {
  journal.currentStage = stage;
  journal.updatedAt = new Date().toISOString();
  const temp = `${JOURNAL}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(scrub(journal), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, JOURNAL);
  } catch (error) {
    if (!persistenceBestEffort) throw error;
    journal.persistenceErrors ??= [];
    journal.persistenceErrors.push({ stage, code: error.code, message: scrub(error.message) });
    // Once a POST may have been sent, disk failure must never block remote cleanup.
  }
}
function record(label, response) {
  journal.events.push({ stage: label, at: new Date().toISOString(), response: scrub(response) });
  save();
}
function checked(response, label) {
  if (!response || response.success !== true) throw new Error(`${label}: API rejected the request (code ${response?.code ?? 'unknown'}).`);
  return response.result;
}
function list(response, label) {
  const result = checked(response, label);
  if (!Array.isArray(result)) throw new Error(`${label}: expected a task list; refusing to infer ownership.`);
  return result;
}
function taskIds(tasks) {
  const ids = tasks.map(idOf);
  if (ids.some(id => id === null) || new Set(ids).size !== ids.length) throw new Error('Task list has missing or duplicate IDs.');
  return ids.sort();
}
async function request(method, path, params = null, payload = null, timeoutMs = 15000) {
  // A single attempt for every request, particularly writes with uncertain outcomes.
  if (payload !== null) return signedJsonRequest(method, path, params, payload, timeoutMs);
  return api.request(method, path, params, payload, { attempts: 1, timeoutMs });
}
async function read(label, path, params = null) {
  stage = label;
  const result = await request('get', path, params);
  record(label, result);
  return result;
}
async function ownedTasks() {
  const response = await read('reconcile-own-category', TIMER_PATH, { category: body.category });
  return list(response, stage).filter(task => {
    const category = typeof task.category === 'object' ? task.category?.category : task.category;
    return task.alias_name === body.alias_name && (category === undefined || category === body.category);
  });
}
async function disable(id) {
  if (baselineIds.includes(id)) throw new Error('Refusing to disable a baseline timer.');
  stage = 'disable-own-task';
  const response = await request('put', `${TIMER_PATH}/state`, null, { timer_id: id, enable: false });
  record(stage, response);
  if (checked(response, stage) !== true) throw new Error('Disable request did not return true.');
}
async function deleteOnce(ids) {
  // Tuya requires timer_ids in query AND JSON body. Explicit Content-Length
  // makes Node send a DELETE body; signing reuses the installed SDK methods.
  const path = `${TIMER_PATH}/batch`;
  const params = { timer_ids: ids.join(',') };
  const payload = { timer_ids: ids.join(',') };
  return signedJsonRequest('delete', path, params, payload);
}
async function signedJsonRequest(method, path, params, payload, timeoutMs = 15000) {
  const wireBody = JSON.stringify(payload);
  const now = Date.now();
  const nonce = randomUUID();
  const headers = {
    t: String(now), client_id: api.accessId, nonce, 'Signature-Headers': 'client_id',
    sign: api._getSign(api.accessId, api.accessKey, api.tokenInfo.access_token, now, nonce, api._getStringToSign(method, path, params, payload)),
    sign_method: 'HMAC-SHA256', access_token: api.tokenInfo.access_token,
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wireBody),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path + (params ? '?' + new URLSearchParams(params) : ''), api.endpoint), {
      method: method.toUpperCase(), headers, ...(api.forceIPv4 ? { family: 4 } : {}),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 1000000) req.destroy(new Error('Oversized JSON response.')); });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`JSON request returned invalid JSON (HTTP ${res.statusCode}).`)); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('JSON request deadline expired; outcome requires verification.')), timeoutMs);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(wireBody);
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function lockState(label, timeoutMs = 7000) {
  stage = label;
  const response = await request('get', `/v2.0/cloud/thing/${TARGET}/shadow/properties`, { codes: 'Lock' }, null, timeoutMs);
  record(label, response);
  const properties = checked(response, label)?.properties;
  const matches = Array.isArray(properties) ? properties.filter(dp => dp.code === 'Lock') : [];
  if (matches.length !== 1 || typeof matches[0].value !== 'boolean') throw new Error(`${label}: native Lock state is unavailable.`);
  const report = { value: matches[0].value, observedAt: Date.now(), reportedAt: matches[0].time };
  execution.currentLock = report.value;
  execution.lastLockReadAt = report.observedAt;
  execution.lastLockReportAt = report.reportedAt;
  save();
  return report;
}
function freshUnlock(report) {
  const threshold = Math.max(execution.preLockReportAt ?? Infinity,
    execution.lockConfirmedReportAt ?? 0, (execution.lockAttemptedAt ?? Infinity) - 2000);
  return report.value === false && Number.isFinite(report.reportedAt) && report.reportedAt > threshold;
}
async function issueLock(value) {
  stage = value ? 'issue-keypad-lock' : 'fallback-keypad-unlock';
  const response = await request('post', `/v2.0/cloud/thing/${TARGET}/shadow/properties/issue`, null,
    { properties: JSON.stringify({ Lock: value }) }, 10000);
  record(stage, response);
  checked(response, stage);
}
async function onlineExecution() {
  continueProbe();
  const tasks = list(await read('confirm-saved-unlock-task', TIMER_PATH, { timer_ids: returnedId }), stage);
  const task = tasks.find(item => idOf(item) === returnedId);
  if (!task || task.enable !== true || task.alias_name !== body.alias_name || task.date !== body.date || task.time !== body.time
      || task.timezone_id !== body.timezone_id || task.loops !== body.loops
      || !Array.isArray(task.functions) || task.functions.length !== 1
      || task.functions[0].code !== 'Lock' || task.functions[0].value !== false) {
    throw new Error('Saved timer does not exactly match the one-off keypad unlock; keypad will remain untouched.');
  }
  execution.savedTaskVerified = true;
  await read('inspect-legacy-before-keypad-lock', `/v1.0/devices/${TARGET}/timers`);
  stage = 'settle-unlock-task';
  await pause(Math.max(0, execution.timerAcceptedAt + 15000 - Date.now()));
  continueProbe();
  if (dueAt - Date.now() < 60000) throw new Error('Less than 60 seconds remain before unlock; refusing keypad lock.');
  const beforeLock = await lockState('confirm-unlocked-before-lock');
  if (beforeLock.value !== false || !Number.isFinite(beforeLock.reportedAt)) throw new Error('Timestamped unlocked state is unavailable; refusing the test.');
  execution.preLockReportAt = beforeLock.reportedAt;
  continueProbe();
  if (dueAt - Date.now() < 60000) throw new Error('Unlock deadline became too close; refusing keypad lock.');
  execution.lockAttemptedAt = Date.now();
  save();
  await issueLock(true); // Never retry a possibly accepted lock command.
  const confirmationDeadline = Math.min(Date.now() + 20000, dueAt - 10000);
  while (Date.now() < confirmationDeadline) {
    continueProbe();
    const report = await lockState('confirm-keypad-locked', Math.max(1, Math.min(7000, confirmationDeadline - Date.now())));
    if (report.value === true && Number.isFinite(report.reportedAt) && report.reportedAt > execution.preLockReportAt) {
      execution.lockConfirmedAt = report.observedAt;
      execution.lockConfirmedReportAt = report.reportedAt;
      break;
    }
    await pause(Math.min(3000, Math.max(0, confirmationDeadline - Date.now())));
  }
  if (!execution.lockConfirmedAt) throw new Error('Keypad lock was not confirmed; immediate unlock fallback required.');
  const automaticDeadline = Math.min(dueAt + 10000, execution.lockAttemptedAt + 150000);
  while (Date.now() < automaticDeadline) {
    continueProbe();
    const report = await lockState('observe-scheduled-unlock', Math.max(1, Math.min(7000, automaticDeadline - Date.now())));
    if (freshUnlock(report)) {
      execution.unlockedVerified = true;
      execution.unlockObservedAt = report.observedAt;
      execution.scheduledUnlockConfirmed = report.observedAt >= dueAt;
      execution.result = execution.scheduledUnlockConfirmed ? 'online-scheduled-unlock-observed' : 'unlocked-before-deadline-inconclusive';
      save();
      return;
    }
    await pause(Math.min(3000, Math.max(0, automaticDeadline - Date.now())));
  }
  throw new Error('No automatic unlock was observed by the bounded deadline; immediate unlock fallback required.');
}
async function ensureOnlineUnlocked() {
  if (!execution.lockAttemptedAt) { execution.unlockedVerified = true; return true; }
  try {
    const before = await lockState('cleanup-authoritative-lock-state');
    if (freshUnlock(before)) {
      if (!execution.unlockedVerified) {
        execution.result = 'unlocked-during-cleanup-inconclusive';
        execution.scheduledUnlockConfirmed = false;
        execution.unlockObservedAt = before.observedAt;
      }
      execution.unlockedVerified = true;
      save();
      return true;
    }
  } catch (error) { execution.cleanupReadError = scrub(error.message); }
  if (!execution.fallbackAttempted) {
    execution.fallbackAttempted = true;
    execution.fallbackAttemptedAt = Date.now();
    execution.scheduledUnlockConfirmed = false;
    save();
    try { await issueLock(false); } catch (error) { execution.fallbackError = scrub(error.message); }
  }
  const deadline = Math.min(Date.now() + 20000, execution.lockAttemptedAt + 180000);
  while (Date.now() < deadline) {
    try {
      const report = await lockState('verify-fallback-unlocked', Math.max(1, Math.min(7000, deadline - Date.now())));
      if (freshUnlock(report)) {
        execution.unlockedVerified = true;
        execution.unlockObservedAt = report.observedAt;
        execution.result = 'immediate-unlock-fallback-used';
        save();
        return true;
      }
    } catch (error) { execution.fallbackReadError = scrub(error.message); }
    await pause(Math.min(3000, Math.max(0, deadline - Date.now())));
  }
  execution.unlockedVerified = false;
  save();
  return false;
}
async function executionLogs() {
  try {
    await read('execution-operation-logs', `/v2.0/cloud/thing/${TARGET}/logs`, {
      type: '5,7,10', start_time: Date.parse(journal.startedAt), end_time: Date.now(), query_type: 1, size: 100,
    });
  } catch (error) { execution.logError = scrub(error.message); save(); }
}
async function cleanup() {
  persistenceBestEffort = true;
  journal.cleanup.required = true;
  save();
  let owned = [];
  let reconciliationError;
  try { owned = await ownedTasks(); } catch (error) { reconciliationError = error.message; }
  const ids = [...new Set([...owned.map(idOf), returnedId].filter(Boolean))];
  if (ids.some(id => baselineIds.includes(id))) throw new Error('Cleanup refused: an owned ID overlaps a baseline timer.');
  if (ids.length > 0) {
    stage = 'delete-own-tasks';
    let deleteError;
    try { record(stage, await deleteOnce(ids)); } catch (error) { deleteError = error.message; }
    if (deleteError) journal.cleanup.deleteError = deleteError;
  }
  const after = list(await read('verify-all-tasks-after-cleanup', TIMER_PATH), stage);
  const afterIds = taskIds(after);
  const remaining = list(await read('verify-own-category-after-cleanup', TIMER_PATH, { category: body.category }), stage);
  const aliasStillPresent = after.some(task => task.alias_name === body.alias_name)
    || remaining.some(task => task.alias_name === body.alias_name);
  journal.cleanup = {
    ...journal.cleanup, ownTaskAbsent: !aliasStillPresent && ids.every(id => !afterIds.includes(id)),
    baselineIdsUnchanged: JSON.stringify(afterIds) === JSON.stringify(baselineIds),
    creationReconciled: createOutcome === 'rejected' || ids.length > 0,
    ...(reconciliationError ? { reconciliationError } : {}),
  };
  journal.cleanup.verified = journal.cleanup.ownTaskAbsent && journal.cleanup.baselineIdsUnchanged && journal.cleanup.creationReconciled;
  save();
  if (!journal.cleanup.verified) throw new Error('Cleanup verification failed; inspect the preserved journal before another probe.');
}
async function main() {
  if (fs.existsSync(JOURNAL)) {
    const stat = fs.lstatSync(JOURNAL);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error('Existing journal is not a regular file owned by this user.');
    const prior = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    if (prior.execute && !prior.cleanup?.verified) throw new Error('An earlier execution has unverified cleanup; preserve and resolve its journal first.');
  }
  save();
  stage = 'load-project-config';
  require(PLUGIN + '/dist/util/Logger').initLogger({ info() {}, warn() {}, debug() {}, error() {} });
  const API = require(PLUGIN + '/dist/core/TuyaOpenAPI').default;
  const config = JSON.parse(fs.readFileSync('/var/lib/homebridge/config.json', 'utf8'));
  const options = config.platforms.find(p => p.platform === 'TuyaPlatform')?.options;
  if (!options?.accessId || !options?.accessKey) throw new Error('Tuya project credentials were not found.');
  secrets.push(options.accessId, options.accessKey, options.password, options.username);
  api = new API(options.endpoint || API.getDefaultEndpoint(Number(options.countryCode)), options.accessId, options.accessKey, 'en', false, options.forceIPv4);
  stage = 'project-token';
  // The getToken flow, with a bounded single-attempt request; never homeLogin.
  const token = checked(await request('get', '/v1.0/token', { grant_type: 1 }), stage);
  if (typeof token?.access_token !== 'string' || !token.access_token || !Number.isFinite(token.expire_time)) {
    throw new Error('Project-token response has an unexpected schema.');
  }
  api.tokenInfo = {
    access_token: token.access_token, refresh_token: token.refresh_token,
    uid: token.uid, expire: Date.now() + token.expire_time * 1000,
  };
  secrets.push(api.tokenInfo.access_token, api.tokenInfo.refresh_token, api.tokenInfo.uid);
  const baseline = list(await read('baseline-all-tasks', TIMER_PATH), stage);
  baselineIds = taskIds(baseline);
  journal.baselineIds = baselineIds;
  stage = 'device-details';
  const details = checked(await request('get', `/v1.0/devices/${TARGET}`), stage);
  record(stage, { success: true, result: { online: details?.online, fieldNames: Object.keys(details ?? {}) } });
  if (details?.online !== true) throw new Error('Thermostat must be online for this probe.');
  if (details?.product_id !== 'lmtejj3f4kafi2k1') throw new Error('Unexpected thermostat product; refusing the pilot probe.');
  const status = checked(await read('device-status', `/v1.0/devices/${TARGET}/status`), stage);
  if (!Array.isArray(status) || status.filter(dp => dp.code === 'child_lock').length !== 1
      || status.find(dp => dp.code === 'child_lock')?.value !== false) throw new Error('Preflight requires child_lock to be explicitly false.');
  const native = checked(await read('native-lock-status', `/v2.0/cloud/thing/${TARGET}/shadow/properties`, { codes: 'Lock' }), stage);
  if (!Array.isArray(native?.properties) || native.properties.filter(dp => dp.code === 'Lock').length !== 1
      || native.properties.find(dp => dp.code === 'Lock')?.value !== false) throw new Error('Preflight requires native Lock to be explicitly false.');
  journal.plan = {
    action: online ? 'Online keypad-lock test with scheduled unlock and immediate API unlock fallback'
      : execute ? 'Create, immediately disable, inspect and delete one distant timer' : 'GET-only preflight; no timer will be created',
    noHeatingCommands: true, noDeviceCommands: !online, task: body,
    cleanup: 'Only our exact alias/category or returned non-baseline timer ID; then verify baseline IDs unchanged',
  };
  save();
  if (!execute) { journal.outcome = 'dry-run-preflight-passed'; return; }
  continueProbe();
  try {
    continueProbe();
    stage = 'create-own-task';
    journal.cleanup.required = true;
    // This last durable write must succeed before any remote mutation.
    save();
    createAttempted = true;
    createOutcome = 'uncertain';
    persistenceBestEffort = true;
    const created = await request('post', TIMER_PATH, null, body);
    createOutcome = created?.success === true ? 'accepted' : created?.success === false ? 'rejected' : 'uncertain';
    journal.createOutcome = createOutcome;
    // Capture ownership before any journal operation, including best-effort writes.
    returnedId = created?.success === true ? idOf(created.result) : null;
    execution.timerAcceptedAt = Date.now();
    journal.createdTimerId = returnedId;
    record(stage, created);
    checked(created, stage);
    if (returnedId && baselineIds.includes(returnedId)) throw new Error('Creation returned a baseline timer ID; refusing mutation.');
    if (!returnedId) {
      const own = await ownedTasks();
      if (own.length !== 1 || !idOf(own[0])) throw new Error('Created timer ID is ambiguous; cleanup reconciliation will run.');
      returnedId = idOf(own[0]);
    }
    journal.createdTimerId = returnedId;
    save();
    if (online) {
      await onlineExecution();
      journal.outcome = execution.result;
      return;
    }
    await disable(returnedId);
    const inspected = list(await read('inspect-own-timer-id', TIMER_PATH, { timer_ids: returnedId }), stage);
    const own = inspected.find(task => idOf(task) === returnedId);
    journal.disableReadback = {
      found: Boolean(own), enableFieldPresent: Boolean(own && Object.hasOwn(own, 'enable')),
      verified: own?.enable === false,
    };
    save();
    list(await read('inspect-own-category', TIMER_PATH, { category: body.category }), stage);
    checked(await read('inspect-legacy-timers', `/v1.0/devices/${TARGET}/timers`), stage);
    journal.outcome = 'metadata-probe-completed';
  } catch (error) {
    journal.probeFailure = { stage, message: scrub(error.message) };
    journal.createOutcome = createOutcome;
    save();
    throw error;
  } finally {
    if (createAttempted) {
      const failedStage = stage;
      if (online && !(await ensureOnlineUnlocked())) {
        journal.cleanup.retainedTimerForSafety = true;
        journal.cleanup.error = 'Keypad unlock is unverified; scheduled unlock task retained rather than deleted.';
        save();
        await executionLogs();
        throw new Error(journal.cleanup.error);
      }
      try { await cleanup(); } catch (error) {
        journal.cleanup.failedStage = stage;
        journal.cleanup.error = error.message;
        save();
        throw error;
      }
      if (online) await executionLogs();
      stage = failedStage;
    }
  }
}
main().catch(error => {
  journal.outcome = 'failed';
  journal.failedStage = stage;
  journal.error = scrub(error.message);
  process.exitCode = 1;
}).finally(() => {
  journal.finishedAt = new Date().toISOString();
  // Do not replace an earlier unresolved journal on initialization failure.
  if (stage !== 'initialize') { try { save(); } catch { process.exitCode = 1; } }
  if (journal.persistenceErrors?.length) process.exitCode = 1;
  console.log(JSON.stringify(scrub({ ...journal, journalPath: JOURNAL }), null, 2));
});
