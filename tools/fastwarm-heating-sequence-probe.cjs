#!/usr/bin/env node
'use strict';

// Diagnostic only. The default is authenticated GETs; execution is deliberately
// confined to one pilot, half-degree target changes, and explicit Smart/original
// recovery. The discriminator additionally prepares a temporary Smart setback.
const fs = require('node:fs');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const PLUGIN = '/var/lib/homebridge/node_modules/@homebridge-plugins/homebridge-tuya';
const TARGET = process.env.FASTWARM_PROBE_DEVICE_ID || '';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: FASTWARM_PROBE_DEVICE_ID=<pilot> node fastwarm-heating-sequence-probe.cjs [--execute-sequence | --execute-discriminator]\nDefault: GET-only baseline. Execution also requires FASTWARM_EXPECTED_TARGET=<Celsius> and FASTWARM_SEQUENCE_NO_BOUNDARY_UNTIL=<ISO timestamp>, verified independently against the active programme. The boundary gate must extend 10–30 minutes from startup. The discriminator requires Smart at 20°C, prepares a temporary 19.5°C Smart target, then tests Hold at 20.5°C and observes Smart alone before restoring 20°C. Pilot suffix cdrjgm only.');
  process.exit(0);
}
if (args.some(arg => !['--execute-sequence', '--execute-discriminator'].includes(arg)) || args.length > 1
    || !/^[a-z0-9]{16,40}$/.test(TARGET) || !TARGET.endsWith('cdrjgm')) {
  console.error('Only the pilot suffix cdrjgm and one optional sequence or discriminator execution mode are accepted.');
  process.exit(2);
}
const discriminator = args.includes('--execute-discriminator');
const execute = discriminator || args.includes('--execute-sequence');
const JOURNAL = discriminator ? '/tmp/fastwarm-heating-discriminator-probe.json' : '/tmp/fastwarm-heating-sequence-probe.json';
const journal = { version: 1, startedAt: new Date().toISOString(), execute, discriminator, targetSuffix: TARGET.slice(-6), events: [], recovery: { required: false, verified: false } };
const secrets = [TARGET];
let api;
let stage = 'initialize';
let baseline;
let writesAttempted = false;
let abortRequested = false;
let bestEffort = false;
let lastReading;
let noBoundaryUntil;
let firstWriteAt;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { abortRequested = true; journal.abortRequested = signal; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function scrub(value, key = '') {
  if (/^(?:id|dev_?id|device_?id|uid|local_?key|key|access_?(?:id|key)|client_?id|sign|.*token|.*secret|.*password)$/i.test(key)) return '[redacted]';
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
  if (abortRequested) throw new Error('Interruption requested; recover original Smart mode and target.');
  if (execute && Date.now() + 120000 >= noBoundaryUntil) throw new Error('Programme-boundary safety window expired.');
  if (firstWriteAt && Date.now() >= firstWriteAt + 90000) throw new Error('Sequence observation deadline reached; recovering original state.');
}
async function get(path, params = null, timeoutMs = 7000) {
  return checked(await api.request('get', path, params, null, { attempts: 1, timeoutMs }), stage);
}
async function signedIssue(properties) {
  const entries = Object.entries(properties);
  if (entries.length !== 1 || !(entries[0][0] === 'ControlMode' && ['hold', 'smart'].includes(entries[0][1])
      || entries[0][0] === 'SetTemp' && ([baseline.target, baseline.target + 5].includes(entries[0][1])
        || discriminator && baseline.target === 200 && entries[0][1] === 195))) {
    throw new Error('Refusing a command outside the fixed mode/temperature whitelist.');
  }
  const path = `/v2.0/cloud/thing/${TARGET}/shadow/properties/issue`;
  const payload = { properties: JSON.stringify(properties) };
  const wire = JSON.stringify(payload);
  const now = Date.now();
  const nonce = randomUUID();
  const headers = {
    t: String(now), client_id: api.accessId, nonce, 'Signature-Headers': 'client_id',
    sign: api._getSign(api.accessId, api.accessKey, api.tokenInfo.access_token, now, nonce, api._getStringToSign('post', path, null, payload)),
    sign_method: 'HMAC-SHA256', access_token: api.tokenInfo.access_token,
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path, api.endpoint), { method: 'POST', headers, ...(api.forceIPv4 ? { family: 4 } : {}) }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 1000000) req.destroy(new Error('Oversized JSON response.')); });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}).`)); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Command deadline expired; outcome uncertain.')),
      Math.max(1, Math.min(10000, firstWriteAt + 180000 - Date.now())));
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(wire);
  });
}
async function issue(label, properties, recovery = false) {
  if (!recovery) proceed();
  stage = label;
  record(label + '-planned', { properties }); // Must persist before the first write.
  writesAttempted = true;
  firstWriteAt ??= Date.now();
  bestEffort = true; // Persistence failures must never suppress recovery.
  journal.recovery.required = true;
  const attemptedAt = Date.now();
  journal.lastCommandAttemptedAt = attemptedAt;
  const response = await signedIssue(properties); // Never retry an uncertain command.
  record(label + '-response', { response });
  checked(response, label);
  return attemptedAt;
}
async function reading(label, timeoutMs = 7000) {
  stage = label;
  const result = await get(`/v2.0/cloud/thing/${TARGET}/shadow/properties`, {
    codes: 'ControlMode,SetTemp,power1,TemperUnitChange,type,RoomTemper',
  }, timeoutMs);
  const list = result?.properties;
  if (!Array.isArray(list)) throw new Error(`${label}: missing native properties.`);
  const prop = code => {
    const matches = list.filter(item => item.code === code);
    if (matches.length !== 1) throw new Error(`${label}: missing or duplicate ${code}.`);
    return matches[0];
  };
  const mode = prop('ControlMode'); const target = prop('SetTemp');
  if (!['hold', 'smart', 'holiday'].includes(mode.value) || !Number.isInteger(target.value)
      || target.value < 50 || target.value > 400 || !Number.isFinite(mode.time) || !Number.isFinite(target.time)
      || mode.time > Date.now() + 2000 || target.time > Date.now() + 2000
      || ![true, 1].includes(prop('power1').value) || prop('TemperUnitChange').value !== false
      || ![0, '0'].includes(prop('type').value)) {
    throw new Error(`${label}: power, Celsius, thermostat type, or timestamped native state is not verified.`);
  }
  lastReading = { mode: mode.value, target: target.value, modeReportedAt: mode.time, targetReportedAt: target.time, observedAt: Date.now() };
  const room = list.find(item => item.code === 'RoomTemper');
  if (room && Number.isFinite(room.value)) lastReading.roomTemperature = room.value / 10;
  record(label, { reading: lastReading });
  return lastReading;
}
function fresh(report, field, value, after, prior) {
  const time = report[field === 'mode' ? 'modeReportedAt' : 'targetReportedAt'];
  return report[field] === value && Number.isFinite(time) && time > prior && time >= after - 2000;
}
function safeReading(report) {
  if (report.target > 220) throw new Error('Target exceeded the 22°C recalled-target cap; recovering immediately.');
}
async function confirm(label, field, value, attemptedAt, prior, recovery = false) {
  const deadline = Math.min(Date.now() + 20000, firstWriteAt ? firstWriteAt + (recovery ? 180000 : 90000) : Infinity);
  while (Date.now() < deadline) {
    if (!recovery) proceed();
    const report = await reading(label, Math.min(7000, Math.max(1, deadline - Date.now())));
    if (!recovery) safeReading(report);
    if (fresh(report, field, value, attemptedAt, prior)) return report;
    await pause(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${label}: no fresh ${field}=${value} report within the deadline.`);
}
async function stabilize(label, expectedMode, expectedTarget, allowTargetChange = false) {
  const deadline = Date.now() + 10000;
  do {
    proceed();
    const report = await reading(label);
    safeReading(report);
    if (report.mode !== expectedMode || (!allowTargetChange && report.target !== expectedTarget)) {
      throw new Error(`${label}: mode or target changed during stabilization.`);
    }
    if (Date.now() >= deadline) return report;
    await pause(Math.min(2000, deadline - Date.now()));
  } while (true);
}
async function recover() {
  stage = 'recover-original-state';
  journal.recovery.attemptedAt = Date.now();
  save();
  // Smart and target are always separate commands. A failure in the first must
  // never prevent the target restoration attempt.
  let modeAt = Date.now();
  try { modeAt = await issue('recover-smart', { ControlMode: 'smart' }, true); }
  catch (error) { journal.recovery.modeCommandError = scrub(error.message); }
  try {
    await confirm('verify-recovery-smart', 'mode', 'smart', firstWriteAt, baseline.modeReportedAt, true);
    journal.recovery.smartVerified = true;
  } catch (error) { journal.recovery.modeReadError = scrub(error.message); }
  let targetAt = Date.now();
  try { targetAt = await issue('recover-original-target', { SetTemp: baseline.target }, true); }
  catch (error) { journal.recovery.targetCommandError = scrub(error.message); }
  try {
    const final = await confirm('verify-recovery-target', 'target', baseline.target,
      firstWriteAt, baseline.targetReportedAt, true);
    journal.recovery.targetVerified = true;
    journal.recovery.final = final;
    // Both fields must remain correct during a final observation window. The
    // final reads can reuse genuinely fresh reports; stale pre-test equality
    // alone can never establish recovery.
    const deadline = Math.min(Date.now() + 10000, firstWriteAt + 180000);
    do {
      if (Date.now() >= firstWriteAt + 180000) throw new Error('Final recovery observation deadline expired.');
      const report = await reading('observe-recovered-original-state');
      if (!fresh(report, 'mode', 'smart', firstWriteAt, baseline.modeReportedAt)
          || !fresh(report, 'target', baseline.target, firstWriteAt, baseline.targetReportedAt)) {
        throw new Error('Original Smart/target state did not remain verified.');
      }
      // A mode report delayed during the first verification can arrive while
      // restoring the target; final fresh dual-field evidence supersedes it.
      journal.recovery.smartVerified = true;
      journal.recovery.final = report;
      if (Date.now() >= deadline) break;
      await pause(Math.min(2000, deadline - Date.now()));
    } while (true);
    journal.recovery.verified = journal.recovery.smartVerified === true && journal.recovery.targetVerified === true;
  } catch (error) { journal.recovery.finalReadError = scrub(error.message); }
  save();
  if (!journal.recovery.verified) throw new Error('Recovery is unverified; do not run another probe. Inspect the journal and thermostat.');
}
async function main() {
  if (fs.existsSync(JOURNAL)) {
    const stat = fs.lstatSync(JOURNAL);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error('Existing journal is not a regular file owned by this user.');
    const prior = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    if (prior.execute && prior.recovery?.required && !prior.recovery?.verified) throw new Error('An earlier probe has unverified recovery; preserve and resolve its journal.');
  }
  save();
  stage = 'project-config';
  require(PLUGIN + '/dist/util/Logger').initLogger({ info() {}, warn() {}, debug() {}, error() {} });
  const API = require(PLUGIN + '/dist/core/TuyaOpenAPI').default;
  const config = JSON.parse(fs.readFileSync('/var/lib/homebridge/config.json', 'utf8'));
  const options = config.platforms.find(p => p.platform === 'TuyaPlatform')?.options;
  if (!options?.accessId || !options?.accessKey) throw new Error('Tuya project credentials unavailable.');
  secrets.push(options.accessId, options.accessKey, options.username, options.password);
  api = new API(options.endpoint || API.getDefaultEndpoint(Number(options.countryCode)), options.accessId, options.accessKey, 'en', false, options.forceIPv4);
  stage = 'project-token';
  const token = await get('/v1.0/token', { grant_type: 1 });
  if (!token?.access_token || !Number.isFinite(token.expire_time)) throw new Error('Unexpected project-token schema.');
  api.tokenInfo = { access_token: token.access_token, refresh_token: token.refresh_token, uid: token.uid, expire: Date.now() + token.expire_time * 1000 };
  secrets.push(token.access_token, token.refresh_token, token.uid);
  stage = 'device-details';
  const details = await get(`/v1.0/devices/${TARGET}`);
  if (details?.online !== true || details?.product_id !== 'lmtejj3f4kafi2k1') throw new Error('Expected online pilot product is not verified.');
  stage = 'baseline-timers';
  const timers = await get(`/v2.0/cloud/timer/device/${TARGET}`);
  if (!Array.isArray(timers) || timers.length !== 0) throw new Error('Preflight requires an explicitly empty device timer list.');
  baseline = await reading('baseline-native-state');
  journal.baseline = baseline;
  if (baseline.mode !== 'smart' || baseline.target > 205 || baseline.target % 5 !== 0) throw new Error('Preflight requires Smart mode and a 5–20.5°C half-degree target.');
  if (discriminator && baseline.target !== 200) throw new Error('The discriminator requires an original Smart target of exactly 20°C.');
  journal.plan = { initialMode: 'smart', baselineCelsius: baseline.target / 10, boostCelsius: (baseline.target + 5) / 10,
    steps: [...(discriminator ? ['Temporary Smart target 19.5°C alone; fresh report'] : []), 'Hold alone; fresh report', '0.5°C increase alone; fresh report and 10-second stability', 'Smart alone; observe target for 10 seconds', 'Original target alone; fresh report and 10-second stability'],
    recovery: 'Finally issue Smart then original target separately, with bounded fresh verification', noTimerProgrammePowerLockOrNetworkChanges: true };
  save();
  if (!execute) { journal.outcome = 'read-only-preflight-passed'; return; }
  const expected = Number(process.env.FASTWARM_EXPECTED_TARGET);
  noBoundaryUntil = Date.parse(process.env.FASTWARM_SEQUENCE_NO_BOUNDARY_UNTIL || '');
  if (!Number.isFinite(expected) || expected * 10 !== baseline.target
      || !Number.isFinite(noBoundaryUntil) || noBoundaryUntil - Date.now() < 600000 || noBoundaryUntil - Date.now() > 1800000) {
    throw new Error('Execution requires an exact expected target and an independently verified 10–30 minute boundary-free window.');
  }
  journal.noBoundaryUntil = new Date(noBoundaryUntil).toISOString();
  proceed();
  try {
    if (discriminator) {
      const attemptedAt = await issue('prepare-temporary-smart-target', { SetTemp: 195 });
      const prepared = await confirm('confirm-temporary-smart-target', 'target', 195, attemptedAt, baseline.targetReportedAt);
      if (prepared.mode !== 'smart') throw new Error('Mode changed while preparing the temporary Smart target.');
      journal.preparedSmartTarget = prepared;
    }
    let attemptedAt = await issue('enter-hold-only', { ControlMode: 'hold' });
    let report = await confirm('confirm-hold-only', 'mode', 'hold', attemptedAt, baseline.modeReportedAt);
    journal.holdRecall = report;
    // Hold can recall its prior 22°C target. Once mode is freshly confirmed,
    // replace that recalled target promptly rather than dwelling at it.
    const priorTarget = lastReading.targetReportedAt;
    attemptedAt = await issue('set-boost-target-only', { SetTemp: baseline.target + 5 });
    report = await confirm('confirm-boost-target', 'target', baseline.target + 5, attemptedAt, priorTarget);
    if (report.mode !== 'hold') throw new Error('Mode changed before boosted Hold was verified.');
    await stabilize('observe-boosted-hold', 'hold', baseline.target + 5);
    const priorMode = lastReading.modeReportedAt;
    const priorResumeTarget = lastReading.targetReportedAt;
    attemptedAt = await issue('resume-smart-only', { ControlMode: 'smart' });
    const resumeAt = attemptedAt;
    report = await confirm('confirm-smart-only', 'mode', 'smart', attemptedAt, priorMode);
    journal.smartRecall = report;
    const observedSmart = await stabilize('observe-smart-recall', 'smart', report.target, true);
    if (discriminator) {
      const classification = { 195: 'remembered-smart-target', 200: 'programme-target', 205: 'retained-hold-target' }[observedSmart.target];
      const targetVerified = observedSmart.target === 205
        ? observedSmart.targetReportedAt >= priorResumeTarget
        : fresh(observedSmart, 'target', observedSmart.target, resumeAt, priorResumeTarget);
      journal.discriminatorObservation = { classification: classification || 'unexpected-target',
        targetVerified, smartAttemptedAt: resumeAt, reading: observedSmart };
      save();
      if (!classification || !targetVerified) throw new Error('The Smart-target discriminator did not establish a recognized, sufficiently fresh result.');
    }
    attemptedAt = await issue('restore-original-target-only', { SetTemp: baseline.target });
    await confirm('confirm-original-target', 'target', baseline.target, resumeAt, priorResumeTarget);
    await stabilize('observe-original-smart-target', 'smart', baseline.target);
    journal.outcome = discriminator ? 'smart-target-discriminator-observed' : 'sequential-hold-boost-smart-original-observed';
  } finally {
    if (writesAttempted) await recover();
  }
}
main().catch(error => {
  journal.outcome = 'failed'; journal.failedStage = stage; journal.error = scrub(error.message); process.exitCode = 1;
}).finally(() => {
  journal.finishedAt = new Date().toISOString();
  if (stage !== 'initialize') { try { save(); } catch { process.exitCode = 1; } }
  if (journal.persistenceErrors?.length) process.exitCode = 1;
  console.log(JSON.stringify(scrub({ outcome: journal.outcome, baseline: journal.baseline, holdRecall: journal.holdRecall,
    smartRecall: journal.smartRecall, preparedSmartTarget: journal.preparedSmartTarget,
    discriminatorObservation: journal.discriminatorObservation, recovery: journal.recovery, error: journal.error, failedStage: journal.failedStage,
    persistenceErrors: journal.persistenceErrors, journalPath: JOURNAL }), null, 2));
});
