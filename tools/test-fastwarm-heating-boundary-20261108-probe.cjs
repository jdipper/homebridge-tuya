'use strict';
// Execute the real diagnostic in a VM: fake network, private runtime socket,
// clock, credentials and filesystem. No test contacts or controls a device.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, 'fastwarm-heating-boundary-20261108-probe.cjs'), 'utf8');
const due = Date.parse('2026-11-08T22:01:00Z');
const boundary = Date.parse('2026-11-08T22:00:00Z');
const pilot = 'bf00000000000000cdrjgm';
const days = [1, 2, 4, 8, 16, 32, 64].map(day => ({ day, complete: true, events: [
  { event: 0, hour: 5, minute: 30, temperature: 20 },
  { event: 1, hour: 8, minute: 30, temperature: 20 },
  { event: 2, hour: 17, minute: 0, temperature: 20 },
  { event: 3, hour: 22, minute: 0, temperature: 12 },
] }));
const fingerprint = createHash('sha256').update(JSON.stringify(days.map(day => [day.day, day.events]))).digest('hex');
async function simulate(scenario) {
  const preflight = ['read-only', 'read-only-tonight-12', 'preflight-wrong-sunday', 'preflight-wrong-mode'].includes(scenario);
  const started = Date.parse(scenario === 'read-only-tonight-12' ? '2026-11-07T22:20:00Z' : scenario === 'late' ? '2026-11-08T22:00:00Z' : scenario === 'wrong-date' ? '2026-11-09T21:58:00Z' : '2026-11-08T21:58:00Z');
  let clock = started; let runtimeUpdated = started - 10000; let programmeReads = 0;
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const timers = new Map(); let timeoutId = 0;
  const timeout = (callback, ms) => { const id = ++timeoutId; timers.set(id, setTimeout(() => { timers.delete(id); clock += ms; callback(); }, 0)); return id; };
  const clear = id => { clearTimeout(timers.get(id)); timers.delete(id); };
  let tasks = []; let mode = scenario === 'preflight-wrong-mode' ? 'hold' : 'smart'; let target = ['read-only-tonight-12', 'baseline-not-20'].includes(scenario) ? 120 : 200; let modeTime = started - 100000; let targetTime = started - 100000;
  if (scenario === 'baseline-timer-present') tasks.push({ timer_id: 'unrelated', alias_name: 'unrelated', category: 'other' });
  const oldTime = modeTime; const mutations = []; let heatWritten = false; let diskFailed = false; let journal;
  let manualChanged = false; let primaryFired = false; let categoryReadFailed = false;
  const files = new Map(); const directory = '/fake-boundary'; const descriptorName = 'TuyaRuntime.0123456789abcdef.json';
  const descriptor = { version: 1, plugin: '@homebridge-plugins/homebridge-tuya', instanceId: '0123456789abcdef',
    token: 'a'.repeat(64), pid: 101, socketPath: '/var/lib/homebridge/persist/tuya-0123456789abcdef.sock' };
  const stat = { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o600, size: 1000 };
  const fakeFs = {
    mkdirSync() {}, lstatSync: () => stat, readdirSync: () => [descriptorName],
    existsSync(file) {
      if (file.endsWith('/cancelled.json')) return scenario === 'cancel-before-hold' && tasks.length === 2
        || scenario === 'cancel-after-hold' && heatWritten && target === 205;
      return files.has(file);
    },
    writeFileSync(file, text) {
      if (diskFailed) { const error = new Error('Simulated disk full'); error.code = 'ENOSPC'; throw error; }
      files.set(file, text); journal = JSON.parse(text);
    },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    readFileSync(file) {
      if (file.endsWith(descriptorName)) return JSON.stringify(descriptor);
      if (files.has(file)) return files.get(file);
      return JSON.stringify({ platforms: [{ platform: 'TuyaPlatform', options: { accessId: 'fake-project', accessKey: 'fake-secret', endpoint: 'https://example.invalid' } }] });
    },
  };
  function state() {
    if (heatWritten && clock >= due && !primaryFired && !['timer-failure', 'manual-change', 'programme-change'].includes(scenario)) {
      primaryFired = true; mode = 'smart'; target = scenario === 'wrong-target' ? 200 : 120; modeTime = due + 500; targetTime = due + 501;
    }
    if (heatWritten && scenario === 'manual-change' && clock >= boundary && !manualChanged) { target = 190; targetTime = clock; manualChanged = true; }
    const stale = scenario === 'stale-recovery' && heatWritten;
    return { success: true, result: { properties: [
      { code: 'ControlMode', value: stale ? 'smart' : mode, time: stale ? oldTime : modeTime },
      { code: 'SetTemp', value: stale ? 200 : target, time: stale ? oldTime : targetTime },
      { code: 'power1', value: true }, { code: 'TemperUnitChange', value: false }, { code: 'type', value: '0' },
    ] } };
  }
  class API {
    constructor(endpoint, accessId, accessKey) { Object.assign(this, { endpoint, accessId, accessKey, tokenInfo: {} }); }
    _getSign() { return 'fake-sign'; } _getStringToSign() { return 'fake-string'; }
    async request(method, url, params, payload, options) {
      if (method !== 'get' || options.attempts !== 1) throw new Error('Unexpected request/retry'); clock += 30;
      if (url === '/v1.0/token') return { success: true, result: { access_token: 'fake-token', refresh_token: 'fake-refresh', expire_time: 3600 } };
      if (url.includes('/cloud/timer/')) {
        if (scenario === 'programme-change-category-query-failure' && params?.category && programmeReads >= 2 && !categoryReadFailed) {
          categoryReadFailed = true; throw new Error('Simulated category query failure after programme changed');
        }
        let selected = tasks;
        if (params?.category) selected = selected.filter(item => item.category === params.category);
        if (params?.timer_ids) selected = selected.filter(item => item.timer_id === params.timer_ids);
        return { success: true, result: selected };
      }
      if (url.endsWith('/shadow/properties')) return state();
      if (url.endsWith('/logs')) {
        if (params.codes !== undefined || params.type !== '5,7,10') throw new Error('Wrong log query');
        return { success: true, result: { logs: [], has_next: false } };
      }
      return { success: true, result: { online: true, product_id: 'lmtejj3f4kafi2k1' } };
    }
  }
  function response(callback, value) {
    const res = new EventEmitter(); res.setEncoding = () => {}; res.statusCode = 200;
    callback(res); res.emit('data', JSON.stringify(value)); res.emit('end');
  }
  const http = { request(options, callback) {
    const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
    req.end = wire => queueMicrotask(() => {
      clock += 30;
      if (options.headers.Authorization !== 'Bearer ' + descriptor.token) throw new Error('Missing private runtime authentication');
      if (options.path === '/schedules/read') {
        if (JSON.stringify(JSON.parse(wire).deviceIds) !== JSON.stringify([pilot])) throw new Error('Read scoped to wrong device');
        programmeReads++; runtimeUpdated = clock;
      } else if (options.path !== '/thermostats') throw new Error('Runtime route outside read whitelist');
      const changed = ['programme-change', 'programme-change-smart-unconfirmed', 'programme-change-category-query-failure'].includes(scenario) && programmeReads >= 2;
      const dayCopy = JSON.parse(JSON.stringify(days)); if (changed || scenario === 'preflight-wrong-sunday') dayCopy[6].events[3].temperature = 13;
      if (scenario === 'saturday-different') dayCopy[5].events[3].temperature = 13;
      const actual = createHash('sha256').update(JSON.stringify(dayCopy.map(day => [day.day, day.events]))).digest('hex');
      response(callback, { thermostats: [{ id: pilot, online: true, timeZone: 'Europe/London', clockVerified: false,
        sync: { status: 'verified' }, lastUpdated: runtimeUpdated, scheduleFingerprint: actual,
        schedule: { complete: true, days: dayCopy, missing: [] } }] });
    }); return req;
  } };
  const https = { request(url, options, callback) {
    const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
    req.end = wire => queueMicrotask(() => {
      clock += 30; const body = JSON.parse(wire); let result = { success: true, result: true };
      if (options.method === 'POST' && url.pathname.endsWith('/issue')) {
        const properties = JSON.parse(body.properties); heatWritten = true;
        if (Object.keys(properties).length !== 1) throw new Error('Combined mode/target command');
        if (properties.SetTemp === 200 && clock >= boundary - 15000) throw new Error('Stale20°C recovery near boundary');
        mutations.push({ kind: 'heating', properties, at: clock });
        if (properties.ControlMode) {
          if (!['hold', 'smart'].includes(properties.ControlMode)) throw new Error('Unapproved mode');
          if (!(scenario === 'programme-change-smart-unconfirmed' && programmeReads >= 2 && properties.ControlMode === 'smart')) {
            mode = properties.ControlMode; modeTime = clock;
          }
          if (properties.ControlMode === 'hold') { target = scenario === 'high-hold-recall' ? 240 : 220; targetTime = clock; }
        } else if ([120, 200, 205].includes(properties.SetTemp)) { target = properties.SetTemp; targetTime = clock; }
        else throw new Error('Unapproved target');
      } else if (options.method === 'POST' && url.pathname.includes('/cloud/timer/')) {
        const index = tasks.length;
        if (body.time !== (index ? '22:02' : '22:01') || body.date !== '20261108' || body.loops !== '0000000'
            || JSON.stringify(body.functions) !== JSON.stringify(index ? [{ code: 'SetTemp', value: 120 }] : [{ code: 'ControlMode', value: 'smart' }])) throw new Error('Unexpected native timer action or deadline');
        if (!/^[a-z0-9]{11}$/i.test(body.alias_name)) throw new Error('Invalid timer alias');
        mutations.push({ kind: 'create', at: clock, time: body.time });
        if (scenario === 'second-create-rejected' && index === 1) result = { success: false, code: 40004002 };
        else {
          const timer_id = 'probe' + (index + 1); tasks.push({ ...body, timer_id, enable: scenario !== 'disabled-timer' }); result.result = { timer_id };
          if (scenario === 'disk-failure') diskFailed = true;
          if (scenario === 'uncertain-create' && index === 0) { req.emit('error', new Error('Create response lost after acceptance')); return; }
        }
      } else if (options.method === 'DELETE') {
        const ids = body.timer_ids.split(',');
        if (url.searchParams.get('timer_ids') !== body.timer_ids || !ids.every(id => ['probe1', 'probe2'].includes(id))) throw new Error('Unowned deletion');
        if (heatWritten && !['manual-change', 'programme-change', 'programme-change-smart-unconfirmed', 'programme-change-category-query-failure'].includes(scenario)
            && (mode !== 'smart' || target !== (clock >= boundary ? 120 : 200))) throw new Error('Deleted fail-safes before heating recovery');
        tasks = tasks.filter(item => !ids.includes(item.timer_id)); mutations.push({ kind: 'delete', ids, at: clock });
      } else throw new Error('Unexpected device mutation');
      response(callback, result);
    }); return req;
  } };
  let done; const complete = new Promise(resolve => { done = resolve; });
  const initialDays = JSON.parse(JSON.stringify(days));
  if (scenario === 'preflight-wrong-sunday') initialDays[6].events[3].temperature = 13;
  if (scenario === 'saturday-different') initialDays[5].events[3].temperature = 13;
  const expectedFingerprint = scenario === 'wrong-fingerprint' ? 'f'.repeat(64) : createHash('sha256').update(JSON.stringify(initialDays.map(day => [day.day, day.events]))).digest('hex');
  const mockProcess = { argv: ['node', 'probe', preflight ? '--preflight' : '--execute-boundary'],
    env: { FASTWARM_PROBE_DEVICE_ID: pilot, FASTWARM_BOUNDARY_PROGRAMME_FINGERPRINT: expectedFingerprint, FASTWARM_BOUNDARY_OUTPUT_DIR: directory },
    getuid: () => 0, on() {}, exitCode: 0 };
  vm.runInNewContext(source, {
    require(name) { if (name === 'node:fs') return fakeFs; if (name === 'node:http') return http; if (name === 'node:https') return https;
      if (name === 'node:crypto') return require(name); if (name.endsWith('/dist/util/Logger')) return { initLogger() {} };
      if (name.endsWith('/dist/core/TuyaOpenAPI')) return { default: API }; throw new Error('Unexpected require'); },
    process: mockProcess, console: { log: text => done(JSON.parse(text)), error() {} }, Date: FakeDate, Intl, URL, URLSearchParams, Buffer,
    setTimeout: timeout, clearTimeout: clear,
  });
  const report = await complete; const heat = mutations.filter(item => item.kind === 'heating');
  if (['read-only', 'read-only-tonight-12'].includes(scenario)) {
    if (mutations.length || programmeReads || report.outcome !== 'read-only-preflight-passed') throw new Error('Read-only preflight mutated state');
  } else if (['late', 'wrong-date', 'baseline-not-20', 'baseline-timer-present', 'wrong-fingerprint', 'preflight-wrong-sunday', 'preflight-wrong-mode'].includes(scenario)) {
    if (mutations.length || report.outcome !== 'failed') throw new Error('Dated execution gate permitted catch-up');
  } else if (scenario === 'stale-recovery') {
    if (report.recovery.verified || !report.cleanup.retainedTimerForSafety || tasks.length !== 2 || mutations.some(item => item.kind === 'delete')) throw new Error('Unverified recovery removed fail-safes');
  } else if (scenario === 'programme-change-smart-unconfirmed') {
    if (report.recovery.verified || report.recovery.smartOnlyVerified || !report.recovery.smartOnly || !report.recovery.targetNotVerified
        || !report.cleanup.retainedTimerForSafety || !report.cleanup.fixedBackupAbsent || tasks.length !== 1 || tasks[0].timer_id !== 'probe1'
        || heat.length !== 3 || heat.some(item => item.properties.SetTemp === 120) || mode !== 'hold' || target !== 205) throw new Error('Unconfirmed Smart-only recovery removed its remaining safety timer or retained the fixed backup');
  } else {
    if (tasks.length || !report.cleanup.verified) throw new Error('Owned timer cleanup failed: ' + JSON.stringify(report));
    if (['normal', 'saturday-different', 'disk-failure'].includes(scenario) && (!report.scheduledSmartConfirmed || !report.holdObservedAfterBoundary || report.recovery.fallbackAttempted || heat.length !== 2 || report.outcome !== 'native-smart-timer-selected-new-programme-period')) throw new Error('Boundary success not independently observed');
    if (['wrong-target', 'timer-failure'].includes(scenario) && (!report.recovery.fallbackAttempted || !report.recovery.verified || target !== 120 || mode !== 'smart' || report.scheduledSmartConfirmed)) throw new Error('Wrong/missing timer target not recovered');
    if (scenario === 'manual-change' && (!report.externalConflict || !report.recovery.skippedForExternalConflict || heat.length !== 2)) throw new Error('External state was overwritten');
    if (['programme-change', 'programme-change-category-query-failure'].includes(scenario) && (!report.programmeConflict || report.externalConflict || !report.recovery.smartOnlyVerified
        || !report.recovery.targetNotVerified || report.recovery.verified || !report.cleanup.fixedBackupAbsent
        || heat.length !== 3 || heat.some(item => item.properties.SetTemp === 120) || mode !== 'smart')) throw new Error('Programme-only change did not leave our Hold using Smart only');
    if (scenario === 'programme-change-category-query-failure' && (!categoryReadFailed || !report.cleanup.backupReconcileError
        || !mutations.some(item => item.kind === 'delete' && JSON.stringify(item.ids) === JSON.stringify(['probe2'])))) throw new Error('Failed reconciliation prevented known fixed-backup cancellation');
    if (scenario === 'cancel-after-hold' && (!report.recovery.verified || target !== 200 || mode !== 'smart' || heat.length !== 4)) throw new Error('Cancellation did not safely recover pre-boundary state');
    if (scenario === 'high-hold-recall' && (!report.recovery.verified || report.externalConflict || target !== 200 || mode !== 'smart'
        || heat.length !== 3 || heat.some(item => item.properties.SetTemp === 205))) throw new Error('Unsafe test-induced Hold recall was not recovered');
    if (['uncertain-create', 'second-create-rejected', 'disabled-timer', 'cancel-before-hold'].includes(scenario) && heat.length) throw new Error('Hold sent without both confirmed fail-safes');
  }
  if (scenario === 'disk-failure' && !report.persistenceErrors?.length) throw new Error('Post-mutation disk error not surfaced');
  for (const item of heat.filter(item => item.properties.ControlMode === 'hold')) if (item.at < Date.parse('2026-11-08T21:59:00Z') || item.at > Date.parse('2026-11-08T21:59:20Z')) throw new Error('Hold outside fixed activation window');
  const serialized = JSON.stringify({ journal, report });
  for (const secret of ['fake-secret', 'fake-token', 'fake-refresh', pilot, descriptor.token]) if (serialized.includes(secret)) throw new Error('Private credentials leaked');
  return { scenario, passed: true, outcome: report.outcome, scheduledSmartConfirmed: report.scheduledSmartConfirmed === true,
    fallback: report.recovery.fallbackAttempted === true, externalConflict: !!report.externalConflict, retained: !!report.cleanup.retainedTimerForSafety,
    writes: mutations.map(({ kind, properties, time }) => ({ kind, ...(properties ? { properties } : {}), ...(time ? { time } : {}) })), elapsedMs: clock - started };
}
(async () => {
  for (const scenario of ['read-only', 'read-only-tonight-12', 'preflight-wrong-mode', 'preflight-wrong-sunday', 'baseline-not-20', 'baseline-timer-present', 'wrong-fingerprint', 'saturday-different', 'late', 'wrong-date', 'normal', 'wrong-target', 'timer-failure', 'manual-change', 'programme-change', 'programme-change-smart-unconfirmed', 'programme-change-category-query-failure',
    'cancel-before-hold', 'cancel-after-hold', 'high-hold-recall', 'uncertain-create', 'second-create-rejected', 'disabled-timer', 'stale-recovery', 'disk-failure']) console.log(JSON.stringify(await simulate(scenario)));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
