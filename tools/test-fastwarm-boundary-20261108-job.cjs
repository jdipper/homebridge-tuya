'use strict';

// Exercise the actual scheduler source in a VM. The filesystem, crontab,
// clock, and probe child are fake; no host jobs or devices are touched.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'fastwarm-boundary-20261108-job.cjs'), 'utf8');
const DIR = '/var/lib/homebridge/fastwarm-investigation/boundary-20261108';
const LINE = `58 21 8 11 * /opt/homebridge/bin/node '${DIR}/job.cjs' --launch >> '${DIR}/job-cron.log' 2>&1 # fastwarm-boundary-20261108-cdrjgm`;
const OTHER = 'MAILTO=household\n17 * * * * /usr/local/bin/existing-job\n';
const TARGET = 'bf00000000000000cdrjgm';
const PLAN = { version: 1, date: '2026-11-08', target: TARGET, expectedFingerprint: 'a'.repeat(64),
  launchAt: '2026-11-08T21:58:00.000Z', holdAt: '2026-11-08T21:59:00.000Z',
  boundaryAt: '2026-11-08T22:00:00.000Z', resumeAt: '2026-11-08T22:01:00.000Z' };

function machine(options = {}) {
  const files = new Map();
  const entry = (contents, type = 'file') => ({ contents, type, uid: 1000, mode: type === 'directory' ? 0o700 : 0o600 });
  files.set(DIR, entry('', 'directory'));
  files.set(`${DIR}/plan.json`, entry(JSON.stringify(PLAN)));
  files.set(`${DIR}/job.cjs`, entry(source)); files.set(`${DIR}/probe.cjs`, entry('// fake reviewed probe'));
  let cron = options.cron ?? OTHER; let now = Date.parse('2026-11-08T16:00:00Z');
  const calls = []; const children = []; const results = []; let fd = 20;
  function missing() { const error = new Error('missing'); error.code = 'ENOENT'; return error; }
  const fakeFs = {
    existsSync: file => files.has(file),
    lstatSync(file) {
      const item = files.get(file); if (!item) throw missing();
      return { uid: item.uid, mode: item.mode, size: Buffer.byteLength(item.contents),
        isFile: () => item.type === 'file', isDirectory: () => item.type === 'directory', isSymbolicLink: () => item.type === 'symlink' };
    },
    readFileSync(file) { const item = files.get(file); if (!item) throw missing(); return item.contents; },
    writeFileSync(file, contents, opts) {
      if (opts?.flag === 'wx' && files.has(file)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error; }
      files.set(file, { ...entry(String(contents)), mode: opts?.mode ?? 0o600 });
    },
    renameSync(from, to) { const item = files.get(from); if (!item) throw missing(); files.set(to, item); files.delete(from); },
    openSync(file, flags, mode) { if (!files.has(file)) files.set(file, { ...entry(''), mode }); return ++fd; },
    closeSync() {},
  };
  const fakeChildProcess = {
    execFileSync(executable, args, opts) {
      assert.equal(executable, '/usr/bin/crontab');
      assert.equal(opts.env.LC_ALL, 'C'); calls.push({ args, input: opts.input });
      if (args[0] === '-l') {
        if (options.changeBeforeWrite && calls.filter(call => call.args[0] === '-l').length === 3) cron += '42 6 * * * /usr/bin/concurrent-edit\n';
        if (!cron && options.noCrontab) { const error = new Error('no crontab'); error.status = 1; error.stderr = 'no crontab for homebridge\n'; throw error; }
        return cron;
      }
      assert.deepEqual(Array.from(args), ['-']);
      cron = opts.input; return '';
    },
    spawn(executable, args, opts) {
      assert.equal(executable, '/opt/homebridge/bin/node');
      assert.deepEqual(Array.from(args), [`${DIR}/probe.cjs`, '--execute-boundary']);
      assert.equal(opts.env.FASTWARM_PROBE_DEVICE_ID, TARGET);
      assert.equal(opts.env.FASTWARM_BOUNDARY_PROGRAMME_FINGERPRINT, PLAN.expectedFingerprint);
      assert.equal(opts.env.FASTWARM_BOUNDARY_OUTPUT_DIR, DIR);
      assert.ok(!cron.includes(LINE), 'Cron must be removed before probe launch');
      const child = new EventEmitter(); child.kill = signal => { child.signal = signal; };
      children.push(child);
      queueMicrotask(() => {
        if (options.childCronEdit) cron += '25 4 * * * /usr/bin/added-during-test\n';
        child.emit('exit', options.childFailure ? 1 : 0, null);
      });
      return child;
    },
  };
  async function run(operation) {
    let resolve; const done = new Promise(r => { resolve = r; });
    const processMock = new EventEmitter(); Object.assign(processMock, {
      argv: ['node', `${DIR}/job.cjs`, ...(operation ? [operation] : [])], env: {}, getuid: () => 1000, exitCode: 0,
    });
    class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    vm.runInNewContext(source, {
      require(name) { if (name === 'node:fs') return fakeFs; if (name === 'node:path') return path;
        if (name === 'node:crypto') return crypto; if (name === 'node:child_process') return fakeChildProcess; throw new Error(name); },
      process: processMock, Date: FakeDate, Buffer,
      console: { log(value) { const result = JSON.parse(value); results.push(result); resolve(result); },
        error(value) { const result = JSON.parse(value); results.push(result); resolve(result); } },
    });
    const result = await done;
    assert.ok(!JSON.stringify(result).includes(TARGET), 'Full device ID leaked in wrapper output');
    return result;
  }
  return { run, files, calls, children, results, get cron() { return cron; }, set clock(value) { now = Date.parse(value); } };
}

(async () => {
  let passed = 0;
  async function test(name, fn) { await fn(); passed++; console.log(JSON.stringify({ scenario: name, passed: true })); }
  await test('default-status-is-read-only', async () => {
    const m = machine(); const before = m.files.size; const result = await m.run();
    assert.equal(result.planValid, true); assert.equal(result.cronLinePresent, false);
    assert.equal(m.files.size, before); assert.ok(m.calls.every(call => call.args[0] === '-l')); assert.equal(m.children.length, 0);
  });
  await test('arm-preserves-existing-cron-and-private-backup', async () => {
    const m = machine(); const result = await m.run('--arm');
    assert.equal(result.state, 'armed'); assert.equal(m.cron, OTHER + LINE + '\n');
    assert.equal(m.files.get(`${DIR}/crontab-before-arm.private.txt`).contents, OTHER);
    assert.equal(m.files.get(`${DIR}/arm-receipt.json`).mode, 0o600); assert.equal(m.children.length, 0);
    assert.equal(m.files.get(`${DIR}/job-cron.log`).mode, 0o600);
  });
  await test('tonight-can-arm-tomorrows-fixed-test', async () => {
    const m = machine(); m.clock = '2026-11-07T22:20:00Z';
    const result = await m.run('--arm'); assert.equal(result.state, 'armed'); assert.equal(m.children.length, 0);
    assert.equal(m.cron, OTHER + LINE + '\n');
  });
  for (const time of ['2026-11-07T21:59:59Z', '2026-11-08T21:57:30Z', '2026-11-09T10:00:00Z']) {
    await test('arm-refuses-outside-explicit-window-' + time, async () => {
      const m = machine(); m.clock = time; assert.equal((await m.run('--arm')).error, 'FW_ARM_WINDOW_CLOSED');
      assert.equal(m.cron, OTHER); assert.equal(m.children.length, 0);
    });
  }
  await test('arm-preserves-prior-dated-test-marker', async () => {
    const prior = '# fastwarm-boundary-20261107-cdrjgm completed test\n';
    const m = machine({ cron: OTHER + prior }); await m.run('--arm');
    assert.equal(m.cron, OTHER + prior + LINE + '\n');
    await m.run('--cancel'); assert.equal(m.cron, OTHER + prior);
  });
  await test('repeat-arm-does-not-duplicate-entry', async () => {
    const m = machine(); await m.run('--arm'); await m.run('--arm');
    assert.equal(m.cron.split(LINE).length, 2);
    assert.equal(m.files.get(`${DIR}/crontab-before-arm.private.txt`).contents, OTHER);
  });
  await test('no-crontab-is-not-an-error', async () => {
    const m = machine({ cron: '', noCrontab: true }); await m.run('--arm'); assert.equal(m.cron, LINE + '\n');
  });
  await test('preserves-unrelated-edit-during-arm', async () => {
    const m = machine({ changeBeforeWrite: true }); await m.run('--arm');
    assert.ok(m.cron.includes('42 6 * * * /usr/bin/concurrent-edit\n')); assert.ok(m.cron.startsWith(OTHER));
  });
  await test('invalid-plan-refuses-arm', async () => {
    const m = machine(); m.files.get(`${DIR}/plan.json`).contents = JSON.stringify({ ...PLAN, resumeAt: '2026-11-09T22:01:00.000Z' });
    assert.equal((await m.run('--arm')).error, 'FW_INVALID_PLAN'); assert.equal(m.cron, OTHER); assert.equal(m.children.length, 0);
  });
  await test('unsafe-script-permissions-refuse-arm', async () => {
    const m = machine(); m.files.get(`${DIR}/probe.cjs`).mode = 0o644;
    assert.equal((await m.run('--arm')).error, 'FW_UNSAFE_FILE'); assert.equal(m.cron, OTHER);
  });
  await test('unsafe-cron-log-permissions-refuse-arm', async () => {
    const m = machine(); m.files.set(`${DIR}/job-cron.log`, { contents: '', uid: 1000, mode: 0o644, type: 'file' });
    assert.equal((await m.run('--arm')).error, 'FW_UNSAFE_FILE'); assert.equal(m.cron, OTHER); assert.equal(m.children.length, 0);
  });
  await test('conflicting-marker-is-preserved-and-not-overwritten', async () => {
    const conflict = OTHER + '# fastwarm-boundary-20261108-cdrjgm manually changed\n'; const m = machine({ cron: conflict });
    assert.equal((await m.run('--arm')).error, 'FW_CRON_MARKER_CONFLICT'); assert.equal(m.cron, conflict);
  });
  await test('cancel-removes-only-own-line-and-prevents-launch', async () => {
    const m = machine(); await m.run('--arm'); assert.equal((await m.run('--cancel')).cancelled, true);
    assert.equal(m.cron, OTHER); assert.equal(m.files.get(`${DIR}/cancelled.json`).mode, 0o600);
    m.clock = '2026-11-08T21:58:00Z'; assert.equal((await m.run('--launch')).error, 'FW_JOB_CANCELLED'); assert.equal(m.children.length, 0);
  });
  for (const [name, time] of [['late', '2026-11-08T21:58:46Z'], ['wrong-year', '2027-11-08T21:58:00Z'], ['wrong-date', '2026-11-07T21:58:00Z'], ['early', '2026-11-08T21:57:29Z']]) {
    await test(name + '-launch-refuses-and-removes-entry', async () => {
      const m = machine(); await m.run('--arm'); m.clock = time;
      assert.equal((await m.run('--launch')).error, 'FW_LAUNCH_WINDOW_CLOSED'); assert.equal(m.children.length, 0); assert.equal(m.cron, OTHER);
    });
  }
  await test('changed-source-after-arm-refuses-launch', async () => {
    const m = machine(); await m.run('--arm'); m.files.get(`${DIR}/probe.cjs`).contents += '\n// changed'; m.clock = '2026-11-08T21:58:00Z';
    assert.equal((await m.run('--launch')).error, 'FW_ARMED_SOURCES_CHANGED'); assert.equal(m.children.length, 0); assert.equal(m.cron, OTHER);
  });
  await test('launch-once-logs-privately-and-preserves-concurrent-edit', async () => {
    const m = machine({ childCronEdit: true }); await m.run('--arm'); m.clock = '2026-11-08T21:58:00Z';
    assert.equal((await m.run('--launch')).state, 'completed'); assert.equal(m.children.length, 1);
    assert.equal(m.files.get(`${DIR}/probe-stdout.log`).mode, 0o600); assert.equal(m.files.get(`${DIR}/probe-stderr.log`).mode, 0o600);
    assert.equal(m.cron, OTHER + '25 4 * * * /usr/bin/added-during-test\n');
    const receipt = m.files.get(`${DIR}/launch-receipt.json`).contents;
    assert.equal((await m.run('--launch')).error, 'FW_JOB_ALREADY_CLAIMED'); assert.equal(m.children.length, 1);
    assert.equal(m.files.get(`${DIR}/launch-receipt.json`).contents, receipt);
  });
  await test('probe-failure-is-recorded-without-wrapper-device-commands', async () => {
    const m = machine({ childFailure: true }); await m.run('--arm'); m.clock = '2026-11-08T21:58:00Z';
    const result = await m.run('--launch'); assert.equal(result.state, 'probe-failed'); assert.equal(result.exitCode, 1); assert.equal(m.cron, OTHER);
  });
  console.log(JSON.stringify({ passed, allPassed: true }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
