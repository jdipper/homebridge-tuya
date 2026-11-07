// Offline simulations only: filesystem, HTTPS and clock are replaced in the VM.
// No credentials are read and no network connection is made.
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, 'fastwarm-timer-metadata-probe.cjs'), 'utf8');
async function simulate(mode) {
  let clock = Date.parse('2026-11-07T14:00:01Z');
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const timers = new Map(); let nextTimer = 0;
  function fastTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, setTimeout(() => { timers.delete(id); clock += ms; callback(); }, 0)); return id; }
  function fastClear(id) { clearTimeout(timers.get(id)); timers.delete(id); }
  let tasks = []; let locked = false; let due = Infinity; let diskFailed = false; let propertyTime = clock - 100000; let fallbackSeen = false; const initialPropertyTime = propertyTime;
  const mutations = []; const signals = {}; let captured;
  const fakeFs = {
    existsSync: () => false,
    writeFileSync() { if (diskFailed) { const e = new Error('Simulated disk full'); e.code = 'ENOSPC'; throw e; } }, renameSync() {},
    readFileSync: () => JSON.stringify({ platforms: [{ platform: 'TuyaPlatform', options: { accessId: 'fake-project', accessKey: 'fake-secret', endpoint: 'https://example.invalid' } }] }),
  };
  class API {
    constructor(endpoint, accessId, accessKey) { Object.assign(this, { endpoint, accessId, accessKey, tokenInfo: {} }); }
    async request(method, path, params) {
      clock += 50;
      if (path === '/v1.0/token') return { success: true, result: { access_token: 'fake-token', refresh_token: 'fake-refresh', expire_time: 3600 } };
      if (path.includes('/cloud/timer/')) return { success: true, result: tasks };
      if (path.endsWith('/shadow/properties')) {
        if (mode === 'happy-disk-failure' && clock >= due && locked) { locked = false; propertyTime = due; }
        if (mode === 'signal-abort' && locked) { signals.SIGTERM(); }
        const stale = mode.startsWith('uncertain-lock-stale-false') && (!fallbackSeen || mode.endsWith('unresolved'));
        return { success: true, result: { properties: [{ code: 'Lock', value: stale ? false : locked, time: stale ? initialPropertyTime : propertyTime }] } };
      }
      if (path.endsWith('/status')) return { success: true, result: [{ code: 'child_lock', value: false }] };
      if (path.endsWith('/timers')) return { success: true, result: [] };
      if (path.endsWith('/logs')) return { success: true, result: { logs: [], has_next: false } };
      return { success: true, result: { online: true, product_id: 'lmtejj3f4kafi2k1' } };
    }
    _getSign() { return 'fake-sign'; } _getStringToSign() { return 'fake-string'; }
  }
  const fakeHttps = {
    request(url, options, callback) {
      const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
      req.end = data => queueMicrotask(() => {
        const body = JSON.parse(data); clock += 50; let result = true;
        if (options.method === 'POST' && url.pathname.endsWith('/issue')) {
          const props = JSON.parse(body.properties);
          if (Object.keys(props).join() !== 'Lock') throw new Error('Non-lock device mutation');
          if (props.Lock === false) fallbackSeen = true;
          if (!(mode.endsWith('unresolved') && props.Lock === false)) { locked = props.Lock; propertyTime = clock; }
          mutations.push({ method: 'issue', value: props.Lock, at: clock });
          if (mode.startsWith('uncertain-lock-stale-false')) result = { simulatedUnknown: true };
        } else if (options.method === 'POST') {
          tasks = [{ ...body, timer_id: 'probe1', enable: true }]; result = { timer_id: 'probe1' };
          due = Date.parse(`${body.date.slice(0,4)}-${body.date.slice(4,6)}-${body.date.slice(6,8)}T${body.time}:00Z`);
          mutations.push({ method: 'create', at: clock });
          if (mode === 'happy-disk-failure') diskFailed = true;
        } else if (options.method === 'DELETE') {
          if (locked) throw new Error('Deleted fail-safe while locked');
          tasks = []; mutations.push({ method: 'delete', at: clock });
        } else throw new Error('Unexpected mutation ' + options.method);
        const res = new EventEmitter(); res.setEncoding = () => {}; res.statusCode = 200;
        callback(res); res.emit('data', JSON.stringify({ success: !(result && result.simulatedUnknown), result, code: 500 })); res.emit('end');
      });
      return req;
    },
  };
  const fakeProcess = { argv: ['node', 'probe', '--execute-online'], env: { FASTWARM_PROBE_DEVICE_ID: 'bf00000000000000cdrjgm' }, getuid: () => 0, exitCode: 0, on: (name, callback) => { signals[name] = callback; } };
  const finished = new Promise(resolve => { captured = resolve; });
  vm.runInNewContext(source, {
    require(name) { if (name === 'node:fs') return fakeFs; if (name === 'node:https') return fakeHttps;
      if (name === 'node:crypto') return require(name); if (name.endsWith('/dist/util/Logger')) return { initLogger() {} };
      if (name.endsWith('/dist/core/TuyaOpenAPI')) return { default: API }; throw new Error('Unexpected require'); },
    process: fakeProcess, console: { log: value => captured(JSON.parse(value)), error() {} },
    Intl, URL, URLSearchParams, Buffer, Date: FakeDate, setTimeout: fastTimeout, clearTimeout: fastClear,
  });
  const report = await finished;
  const issue = mutations.filter(m => m.method === 'issue');
  let valid = !locked && tasks.length === 0 && report.cleanup.verified === true
    && issue.filter(m => m.value === true).length === 1
    && (mode === 'happy-disk-failure'
      ? issue.length === 1 && report.execution.scheduledUnlockConfirmed === true && report.persistenceErrors.length > 0
      : issue.length === 2 && issue[1].value === false && report.execution.scheduledUnlockConfirmed !== true);
  if (mode === 'uncertain-lock-stale-false-unresolved') valid = locked && tasks.length === 1 && report.cleanup.retainedTimerForSafety === true && report.execution.unlockedVerified === false && issue.length === 2 && issue[1].value === false && !mutations.some(m => m.method === 'delete');
  if (!valid) throw new Error(JSON.stringify({ mode, report, mutations }));
  return { mode, passed: valid, cleanupVerified: report.cleanup.verified, result: report.execution.result, lockSeconds: (report.execution.unlockObservedAt - report.execution.lockAttemptedAt) / 1000, mutations: mutations.map(({method,value}) => ({method,...(value === undefined ? {} : {value})})) };
}
(async () => { for (const mode of ['happy-disk-failure', 'fallback', 'signal-abort', 'uncertain-lock-stale-false', 'uncertain-lock-stale-false-unresolved']) console.log(JSON.stringify(await simulate(mode))); })().catch(e => { console.error(e.message); process.exitCode = 1; });
