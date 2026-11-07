'use strict';
// The actual probe runs in a VM with fake credentials, HTTPS, filesystem and
// clock. Nothing connects to Tuya or writes the real host's filesystem.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'fastwarm-heating-timer-probe.cjs'), 'utf8');
async function simulate(scenario) {
  const started = Date.parse('2026-11-07T15:00:01Z'); let clock = started;
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const timers = new Map(); let timerId = 0;
  const timeout = (callback, ms) => { const id = ++timerId; timers.set(id, setTimeout(() => { timers.delete(id); clock += ms; callback(); }, 0)); return id; };
  const clear = id => { clearTimeout(timers.get(id)); timers.delete(id); };
  let tasks = []; let due = Infinity; let mode = 'smart'; let target = 200;
  const oldTime = clock - 100000; let modeTime = oldTime; let targetTime = oldTime;
  const mutations = []; let heatingWritten = false; let diskFailed = false; let journal;
  const fakeFs = {
    existsSync: () => false,
    writeFileSync(file, text) { if (diskFailed) { const error = new Error('Simulated disk full'); error.code = 'ENOSPC'; throw error; } journal = JSON.parse(text); },
    renameSync() {},
    readFileSync: () => JSON.stringify({ platforms: [{ platform: 'TuyaPlatform', options: { accessId: 'fake-project', accessKey: 'fake-secret', endpoint: 'https://example.invalid' } }] }),
  };
  class API {
    constructor(endpoint, accessId, accessKey) { Object.assign(this, { endpoint, accessId, accessKey, tokenInfo: {} }); }
    _getSign() { return 'fake-sign'; } _getStringToSign() { return 'fake-string'; }
    async request(method, url, params, payload, options) {
      if (method !== 'get' || options.attempts !== 1) throw new Error('Unexpected request or automatic retry');
      clock += 50;
      if (url === '/v1.0/token') return { success: true, result: { access_token: 'fake-token', refresh_token: 'fake-refresh', expire_time: 3600 } };
      if (url.includes('/cloud/timer/')) {
        let selected = tasks;
        if (params?.category) selected = selected.filter(item => item.category === params.category);
        if (params?.timer_ids) selected = selected.filter(item => item.timer_id === params.timer_ids);
        return { success: true, result: selected };
      }
      if (url.endsWith('/shadow/properties')) {
        if (['normal', 'disk-failure'].includes(scenario) && clock >= due && mode === 'hold') {
          mode = 'smart'; target = 200; modeTime = due + 1500; targetTime = due + 1501;
        }
        if (scenario === 'early-smart' && heatingWritten && clock > started + 45000 && mode === 'hold') {
          mode = 'smart'; target = 200; modeTime = clock; targetTime = clock;
        }
        const stale = scenario === 'unverified-recovery' && heatingWritten;
        return { success: true, result: { properties: [
          { code: 'ControlMode', value: stale ? 'smart' : mode, time: stale ? oldTime : modeTime },
          { code: 'SetTemp', value: stale ? 200 : target, time: stale ? oldTime : targetTime },
          { code: 'power1', value: true }, { code: 'TemperUnitChange', value: false }, { code: 'type', value: '0' },
        ] } };
      }
      if (url.endsWith('/logs')) {
        if (params.codes !== undefined || params.type !== '5,7,10') throw new Error('Wrong logs filter');
        return { success: true, result: { logs: [], has_next: false } };
      }
      return { success: true, result: { online: true, product_id: 'lmtejj3f4kafi2k1' } };
    }
  }
  const https = {
    request(url, options, callback) {
      const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
      req.end = wire => queueMicrotask(() => {
        clock += 50; const body = JSON.parse(wire); let response = { success: true, result: true };
        if (options.method === 'POST' && url.pathname.endsWith('/issue')) {
          const properties = JSON.parse(body.properties); heatingWritten = true;
          if (Object.keys(properties).length !== 1) throw new Error('Combined heating command');
          mutations.push({ kind: 'heating', properties, at: clock });
          if (properties.ControlMode) {
            if (!['hold', 'smart'].includes(properties.ControlMode)) throw new Error('Unapproved mode');
            if (mode !== properties.ControlMode) { mode = properties.ControlMode; modeTime = clock; }
            if (mode === 'hold') { target = 220; targetTime = clock; }
          } else if ([200, 205].includes(properties.SetTemp)) {
            if (properties.SetTemp !== target) { target = properties.SetTemp; targetTime = clock; }
          } else throw new Error('Unapproved target');
        } else if (options.method === 'POST' && url.pathname.includes('/cloud/timer/')) {
          if (JSON.stringify(body.functions) !== JSON.stringify([{ code: 'ControlMode', value: 'smart' }])) throw new Error('Non-Smart or combined timer action');
          if (body.alias_name.length > 11 || !/^[a-z0-9]+$/i.test(body.alias_name)) throw new Error('Invalid alias');
          mutations.push({ kind: 'create', at: clock });
          if (scenario === 'rejected-create') response = { success: false, code: 40004002 };
          else {
            tasks = [{ ...body, timer_id: 'probe1', enable: true }];
            due = Date.parse(`${body.date.slice(0, 4)}-${body.date.slice(4, 6)}-${body.date.slice(6, 8)}T${body.time}:00Z`);
            response.result = { timer_id: 'probe1' };
            if (scenario === 'disk-failure') diskFailed = true;
            if (scenario === 'uncertain-create') { req.emit('error', new Error('Simulated create response loss after acceptance')); return; }
          }
        } else if (options.method === 'DELETE') {
          if (heatingWritten && (mode !== 'smart' || target !== 200)) throw new Error('Deleted fail-safe before physical recovery');
          if (body.timer_ids !== 'probe1' || url.searchParams.get('timer_ids') !== 'probe1') throw new Error('Wrong timer deletion ownership/body');
          tasks = []; mutations.push({ kind: 'delete', at: clock });
        } else throw new Error('Unexpected mutation');
        const res = new EventEmitter(); res.setEncoding = () => {}; res.statusCode = 200;
        callback(res); res.emit('data', JSON.stringify(response)); res.emit('end');
      });
      return req;
    },
  };
  let done; const complete = new Promise(resolve => { done = resolve; });
  const processMock = {
    argv: ['node', 'probe', ...(scenario === 'read-only' ? [] : ['--execute-timer'])],
    env: { FASTWARM_PROBE_DEVICE_ID: 'bf00000000000000cdrjgm', FASTWARM_EXPECTED_TARGET: '20', FASTWARM_SEQUENCE_NO_BOUNDARY_UNTIL: new FakeDate(clock + 1200000).toISOString() },
    getuid: () => 0, on() {}, exitCode: 0,
  };
  vm.runInNewContext(source, {
    require(name) { if (name === 'node:fs') return fakeFs; if (name === 'node:https') return https; if (name === 'node:crypto') return require(name);
      if (name.endsWith('/dist/util/Logger')) return { initLogger() {} }; if (name.endsWith('/dist/core/TuyaOpenAPI')) return { default: API }; throw new Error('Unexpected require'); },
    process: processMock, console: { log: value => done(JSON.parse(value)), error() {} }, Date: FakeDate, Intl, URL, URLSearchParams, Buffer,
    setTimeout: timeout, clearTimeout: clear,
  });
  const report = await complete;
  const heat = mutations.filter(item => item.kind === 'heating');
  const successful = ['normal', 'disk-failure'].includes(scenario);
  if (scenario === 'read-only') {
    if (mutations.length !== 0 || report.outcome !== 'read-only-preflight-passed') throw new Error('Read-only run mutated state');
  } else if (scenario === 'unverified-recovery') {
    if (report.recovery.verified || !report.cleanup.retainedTimerForSafety || tasks.length !== 1 || mutations.some(item => item.kind === 'delete')) throw new Error('Unverified recovery did not retain the Smart timer');
  } else {
    if (tasks.length !== 0 || !report.cleanup.verified || !report.recovery.verified || mode !== 'smart' || target !== 200) throw new Error('Cleanup/recovery failed ' + JSON.stringify(report));
    if (successful && (!report.scheduledSmartConfirmed || report.recovery.fallbackAttempted || heat.length !== 2 || report.outcome !== 'native-smart-timer-restored-original-target')) throw new Error('Timer restoration was not independently observed');
    if (scenario === 'fallback' && (!report.recovery.fallbackAttempted || heat.length !== 4 || report.scheduledSmartConfirmed)) throw new Error('Fallback not executed correctly');
    if (['rejected-create', 'uncertain-create'].includes(scenario) && heat.length !== 0) throw new Error('Hold sent after rejected/uncertain timer creation');
    if (scenario === 'early-smart' && (report.executionResult !== 'early-smart-restoration-inconclusive' || report.scheduledSmartConfirmed)) throw new Error('Early Smart mistaken for timer success');
  }
  if (scenario === 'disk-failure' && !report.persistenceErrors?.length) throw new Error('Disk failure not recorded');
  const serialized = JSON.stringify({ journal, report });
  for (const secret of ['fake-secret', 'fake-token', 'fake-refresh', 'bf00000000000000cdrjgm']) if (serialized.includes(secret)) throw new Error('Secret leaked into journal/summary');
  return { scenario, passed: true, outcome: report.outcome, scheduledSmartConfirmed: report.scheduledSmartConfirmed === true,
    fallback: report.recovery.fallbackAttempted === true, recoveryVerified: report.recovery.verified, retained: report.cleanup.retainedTimerForSafety === true,
    writes: mutations.map(({ kind, properties }) => ({ kind, ...(properties ? { properties } : {}) })), elapsedMs: clock - started };
}
(async () => { for (const scenario of ['read-only', 'normal', 'fallback', 'rejected-create', 'unverified-recovery', 'uncertain-create', 'early-smart', 'disk-failure']) console.log(JSON.stringify(await simulate(scenario))); })().catch(error => { console.error(error.stack); process.exitCode = 1; });
