'use strict';
// No credentials/network: exercise the diagnostic's actual command/recovery
// paths with a fake native shadow, monotonic clock, filesystem and HTTPS.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'fastwarm-heating-sequence-probe.cjs'), 'utf8');
async function simulate(scenario) {
  const discriminator = scenario.startsWith('discriminator-');
  const uncertainPrepare = scenario.startsWith('discriminator-uncertain-prepare');
  const unresolved = scenario === 'uncertain-stale-unresolved' || scenario === 'discriminator-uncertain-prepare-stale';
  let clock = Date.parse('2026-11-07T14:00:00Z');
  const initialTime = clock - 100000;
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const timers = new Map(); let timerId = 0;
  const timeout = (callback, ms) => { const id = ++timerId; timers.set(id, setTimeout(() => { timers.delete(id); clock += ms; callback(); }, 0)); return id; };
  const clear = id => { clearTimeout(timers.get(id)); timers.delete(id); };
  let mode = 'smart'; let target = scenario === 'discriminator-non20-baseline' ? 195 : 200; let modeTime = initialTime; let targetTime = initialTime;
  let preparedTargetTime;
  let journal; let diskFailed = false; let mutations = []; let stopped = false; let recovered = false;
  const signals = {};
  const fakeFs = {
    existsSync: () => false,
    writeFileSync(file, value) {
      if (diskFailed) { const error = new Error('Simulated disk full'); error.code = 'ENOSPC'; throw error; }
      journal = JSON.parse(value);
    }, renameSync() {},
    readFileSync: () => JSON.stringify({ platforms: [{ platform: 'TuyaPlatform', options: { accessId: 'fake-project', accessKey: 'fake-key', endpoint: 'https://example.invalid' } }] }),
  };
  class API {
    constructor(endpoint, accessId, accessKey) { Object.assign(this, { endpoint, accessId, accessKey, tokenInfo: {} }); }
    _getSign() { return 'fake-sign'; } _getStringToSign() { return 'fake-string'; }
    async request(method, url, params, payload, options) {
      if (method !== 'get' || options.attempts !== 1) throw new Error('Unexpected request or retry');
      clock += 50;
      if (url === '/v1.0/token') return { success: true, result: { access_token: 'fake-token', expire_time: 3600 } };
      if (url.includes('/cloud/timer/')) return { success: true, result: scenario === 'nonempty-timer' ? [{}] : [] };
      if (url.endsWith('/shadow/properties')) {
        if (scenario === 'signal-after-hold' && mode === 'hold' && !stopped) { stopped = true; signals.SIGTERM(); }
        const stale = (scenario.startsWith('uncertain-stale') || scenario === 'discriminator-uncertain-prepare-stale')
          && mutations.length > 0 && !recovered;
        return { success: true, result: { properties: [
          { code: 'ControlMode', value: stale ? 'smart' : mode, time: stale ? initialTime : modeTime },
          { code: 'SetTemp', value: stale ? 200 : target, time: stale ? initialTime : targetTime },
          { code: 'power1', value: true }, { code: 'TemperUnitChange', value: false }, { code: 'type', value: '0' },
          { code: 'RoomTemper', value: 180 },
        ] } };
      }
      return { success: true, result: { online: true, product_id: 'lmtejj3f4kafi2k1' } };
    }
  }
  const https = {
    request(url, options, callback) {
      const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
      req.end = wire => queueMicrotask(() => {
        if (url.pathname.includes('/timer/') || !url.pathname.endsWith('/issue') || options.method !== 'POST') throw new Error('Unexpected mutation');
        const properties = JSON.parse(JSON.parse(wire).properties);
        if (Object.keys(properties).length !== 1) throw new Error('Combined write');
        clock += 50;
        const first = mutations.length === 0;
        mutations.push(properties);
        if (properties.ControlMode) {
          if (properties.ControlMode !== mode) { mode = properties.ControlMode; modeTime = clock; }
          // An acknowledged recovery can report unchanged Smart anew; unresolved
          // scenarios still return stale pre-test shadow timestamps to the probe.
          if (uncertainPrepare && properties.ControlMode === 'smart') modeTime = clock;
          if (properties.ControlMode === 'hold') { target = scenario === 'over-cap' ? 225 : 220; targetTime = clock; }
          if (properties.ControlMode === 'smart' && scenario === 'smart-restores-original' && target !== 200) { target = 200; targetTime = clock; }
          if (properties.ControlMode === 'smart' && ['discriminator-memory', 'discriminator-programme', 'discriminator-stale-memory'].includes(scenario)) {
            const recalledTarget = scenario === 'discriminator-programme' ? 200 : 195;
            if (target !== recalledTarget) { target = recalledTarget; targetTime = scenario === 'discriminator-stale-memory' ? preparedTargetTime : clock; }
          }
        } else if ([200, 205].includes(properties.SetTemp) || discriminator && properties.SetTemp === 195) {
          if (properties.SetTemp !== target) { target = properties.SetTemp; targetTime = clock; }
          if (properties.SetTemp === 195) preparedTargetTime = targetTime;
          if (properties.SetTemp === 200) recovered = !unresolved;
        } else throw new Error('Unexpected temperature');
        if (scenario === 'happy-disk-failure') diskFailed = true;
        if ((scenario.startsWith('uncertain-stale') || uncertainPrepare) && first) {
          req.emit('error', new Error(uncertainPrepare ? 'Simulated uncertain accepted preparation' : 'Simulated uncertain accepted Hold')); return;
        }
        const res = new EventEmitter(); res.setEncoding = () => {}; res.statusCode = 200;
        callback(res); res.emit('data', JSON.stringify({ success: true, result: true })); res.emit('end');
      });
      return req;
    },
  };
  let finished;
  const complete = new Promise(resolve => { finished = resolve; });
  const proc = {
    argv: ['node', 'probe', ...(scenario === 'read-only' ? [] : [discriminator ? '--execute-discriminator' : '--execute-sequence'])],
    env: { FASTWARM_PROBE_DEVICE_ID: 'bf00000000000000cdrjgm', FASTWARM_EXPECTED_TARGET: '20', FASTWARM_SEQUENCE_NO_BOUNDARY_UNTIL: new FakeDate(clock + 1200000).toISOString() },
    getuid: () => 0, on: (name, callback) => { signals[name] = callback; }, exitCode: 0,
  };
  vm.runInNewContext(source, {
    require(name) { if (name === 'node:fs') return fakeFs; if (name === 'node:https') return https; if (name === 'node:crypto') return require(name);
      if (name.endsWith('/dist/util/Logger')) return { initLogger() {} }; if (name.endsWith('/dist/core/TuyaOpenAPI')) return { default: API };
      throw new Error('Unexpected require'); },
    process: proc, console: { log: value => finished(JSON.parse(value)), error() {} }, Date: FakeDate, URL, Buffer,
    setTimeout: timeout, clearTimeout: clear,
  });
  const report = await complete;
  const happy = ['happy', 'happy-disk-failure', 'smart-restores-original', 'discriminator-memory', 'discriminator-programme', 'discriminator-retain-hold'].includes(scenario);
  if (scenario === 'read-only' || scenario === 'nonempty-timer' || scenario === 'discriminator-non20-baseline') {
    if (mutations.length !== 0 || (scenario === 'read-only' && report.outcome !== 'read-only-preflight-passed')) throw new Error('Unexpected read-only mutation');
  } else {
    if (mode !== 'smart' || target !== 200 || (!uncertainPrepare && !mutations.some(p => p.ControlMode === 'hold'))
        || !mutations.some(p => p.ControlMode === 'smart') || !mutations.some(p => p.SetTemp === 200)) throw new Error('Recovery commands/state missing');
    if (unresolved) {
      if (report.recovery.verified || report.outcome !== 'failed') throw new Error('Stale recovery incorrectly accepted');
    } else if (!report.recovery.verified) throw new Error('Recovery not verified: ' + JSON.stringify(report));
    const expectedOutcome = discriminator ? 'smart-target-discriminator-observed' : 'sequential-hold-boost-smart-original-observed';
    if (happy && (report.outcome !== expectedOutcome || mutations.filter(p => p.SetTemp === 205).length !== 1)) throw new Error('Happy sequence failed');
    if (!happy && scenario !== 'discriminator-stale-memory' && mutations.some(p => p.SetTemp === 205)) throw new Error('Continued boost after aborted/uncertain Hold');
    if (uncertainPrepare && mutations.some(p => p.ControlMode === 'hold')) throw new Error('Entered Hold after uncertain preparation');
    if (discriminator && mutations.filter(p => p.SetTemp === 195).length !== 1) throw new Error('Discriminator preparation missing or repeated');
    if (!discriminator && mutations.some(p => p.SetTemp === 195)) throw new Error('Normal sequence issued discriminator target');
    const expectedClass = { 'discriminator-memory': 'remembered-smart-target', 'discriminator-programme': 'programme-target', 'discriminator-retain-hold': 'retained-hold-target' }[scenario];
    if (expectedClass && (report.discriminatorObservation?.classification !== expectedClass || report.discriminatorObservation?.targetVerified !== true)) throw new Error('Discriminator result not established');
    if (scenario === 'discriminator-stale-memory' && (report.outcome !== 'failed' || report.discriminatorObservation?.targetVerified !== false)) throw new Error('Stale recalled Smart target incorrectly established');
    if (scenario === 'happy-disk-failure' && !report.persistenceErrors?.length) throw new Error('Disk failure not recorded');
  }
  if (clock - Date.parse('2026-11-07T14:00:00Z') > 180000) throw new Error('Exceeded three-minute bound');
  if (JSON.stringify(report).includes('fake-key') || JSON.stringify(report).includes('fake-token') || JSON.stringify(report).includes('bf00000000000000cdrjgm')) throw new Error('Sensitive value leaked');
  if (discriminator && report.journalPath !== '/tmp/fastwarm-heating-discriminator-probe.json') throw new Error('Discriminator replaced the immediate sequence journal');
  return { scenario, passed: true, outcome: report.outcome, recoveryVerified: report.recovery.verified, writes: mutations, elapsedMs: clock - Date.parse('2026-11-07T14:00:00Z') };
}
(async () => { for (const scenario of ['read-only', 'nonempty-timer', 'happy', 'happy-disk-failure', 'smart-restores-original', 'over-cap', 'signal-after-hold', 'uncertain-stale', 'uncertain-stale-unresolved', 'discriminator-memory', 'discriminator-programme', 'discriminator-retain-hold', 'discriminator-stale-memory', 'discriminator-uncertain-prepare', 'discriminator-uncertain-prepare-stale', 'discriminator-non20-baseline']) console.log(JSON.stringify(await simulate(scenario))); })().catch(error => { console.error(error.stack); process.exitCode = 1; });
