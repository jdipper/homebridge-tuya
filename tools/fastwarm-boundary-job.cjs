#!/usr/bin/env node
'use strict';

// A durable, single-date host scheduler for the separately reviewed boundary
// probe. This wrapper never sends a thermostat command or prints credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const DIR = '/var/lib/homebridge/fastwarm-investigation/boundary-20261107';
const NODE = '/opt/homebridge/bin/node';
const CRONTAB = '/usr/bin/crontab';
const MARKER = 'fastwarm-boundary-20261107-cdrjgm';
const CRON_LINE = `58 21 7 11 * ${NODE} '${DIR}/job.cjs' --launch >> '${DIR}/job-cron.log' 2>&1 # ${MARKER}`;
const FIXED = {
  date: '2026-11-07',
  launchAt: '2026-11-07T21:58:00.000Z',
  holdAt: '2026-11-07T21:59:00.000Z',
  boundaryAt: '2026-11-07T22:00:00.000Z',
  resumeAt: '2026-11-07T22:01:00.000Z',
};
const EARLIEST = Date.parse('2026-11-07T21:57:30.000Z');
const LATEST = Date.parse('2026-11-07T21:58:45.000Z');
const args = process.argv.slice(2);
const operation = args[0] ?? '--status';
if (args.length > 1 || !['--status', '--arm', '--cancel', '--launch'].includes(operation)) {
  console.error('Use --status, --arm, --cancel, or --launch.');
  process.exitCode = 2;
} else {
  void main().catch(error => {
    // Error text from crontab or a child might contain private input. Only our
    // fixed diagnostic codes are suitable for terminal output.
    console.error(JSON.stringify({ operation, error: /^FW_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'FW_JOB_FAILED' }));
    process.exitCode = 1;
  });
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function file(name) { return path.join(DIR, name); }
function exists(name) { return fs.existsSync(file(name)); }
function ownedPrivate(filename, directory = false) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || !directory && stat.size > 1024 * 1024) fail('FW_UNSAFE_FILE');
  return stat;
}
function directory() { ownedPrivate(DIR, true); }
function readPlan() {
  directory();
  for (const name of ['plan.json', 'job.cjs', 'probe.cjs']) ownedPrivate(file(name));
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file('plan.json'), 'utf8')); }
  catch { fail('FW_INVALID_PLAN'); }
  if (plan?.version !== 1 || typeof plan.target !== 'string'
      || !/^[a-z0-9]{16,40}$/.test(plan.target) || !plan.target.endsWith('cdrjgm')
      || !/^[a-f0-9]{64}$/.test(plan.expectedFingerprint ?? '')
      || Object.entries(FIXED).some(([key, value]) => plan[key] !== value)) fail('FW_INVALID_PLAN');
  return plan;
}
function hashes() {
  return Object.fromEntries(['plan.json', 'job.cjs', 'probe.cjs'].map(name => [name,
    crypto.createHash('sha256').update(fs.readFileSync(file(name))).digest('hex')]));
}
function verifyArmedSources() {
  ownedPrivate(file('arm-receipt.json'));
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file('arm-receipt.json'), 'utf8')); }
  catch { fail('FW_INVALID_ARM_RECEIPT'); }
  const current = hashes();
  if (receipt?.state !== 'armed' || receipt.marker !== MARKER
      || Object.entries(current).some(([name, hash]) => receipt.sourceSha256?.[name] !== hash)) fail('FW_ARMED_SOURCES_CHANGED');
}
function writePrivate(name, value, exclusive = false) {
  const contents = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) { fs.writeFileSync(file(name), contents, { flag: 'wx', mode: 0o600 }); return; }
  const temporary = file(`${name}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file(name));
}
function crontab() {
  try {
    return execFileSync(CRONTAB, ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  } catch (error) {
    if (error.status === 1 && /^no crontab for [^\n]+\n?$/i.test(String(error.stderr ?? ''))) return '';
    fail('FW_CRONTAB_READ_FAILED');
  }
}
function ownLines(text) { return text.split('\n').filter(line => line === CRON_LINE).length; }
function withoutOwn(text) { return text.split('\n').filter(line => line !== CRON_LINE).join('\n'); }
function conflictingMarker(text) {
  return text.split('\n').some(line => line.includes(MARKER) && line !== CRON_LINE);
}
function editCron(arm) {
  // Re-read directly before replacing to preserve edits made since the first
  // read. crontab has no compare-and-swap API; no unrelated line is transformed.
  crontab();
  const current = crontab();
  if (arm && conflictingMarker(current)) fail('FW_CRON_MARKER_CONFLICT');
  let next = withoutOwn(current);
  if (arm) next = next + (next && !next.endsWith('\n') ? '\n' : '') + CRON_LINE + '\n';
  if (next !== current) {
    try { execFileSync(CRONTAB, ['-'], { input: next, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } }); }
    catch { fail('FW_CRONTAB_WRITE_FAILED'); }
  }
  const confirmed = crontab();
  if (arm ? ownLines(confirmed) !== 1 : ownLines(confirmed) !== 0) fail('FW_CRONTAB_NOT_CONFIRMED');
}
function summary(plan, extra = {}) {
  return { version: 1, marker: MARKER, date: FIXED.date, targetSuffix: plan?.target.slice(-6) ?? 'cdrjgm',
    launchAt: FIXED.launchAt, holdAt: FIXED.holdAt, boundaryAt: FIXED.boundaryAt, resumeAt: FIXED.resumeAt,
    ...extra };
}
function openPrivateLog(name) {
  if (exists(name)) ownedPrivate(file(name));
  return fs.openSync(file(name), 'ax', 0o600);
}
async function main() {
  if (operation === '--status') {
    let plan; let valid = false;
    try { plan = readPlan(); valid = true; } catch { /* Report only whether the private plan validates. */ }
    console.log(JSON.stringify(summary(plan, { planValid: valid, cronLinePresent: ownLines(crontab()) > 0,
      cancelled: exists('cancelled.json'), claimed: exists('launch-claim.json'),
      ...(valid ? { sourceSha256: hashes() } : {}) })));
    return;
  }
  directory();
  if (operation === '--cancel') {
    writePrivate('cancelled.json', { version: 1, marker: MARKER, cancelledAt: new Date().toISOString() });
    editCron(false);
    console.log(JSON.stringify(summary(undefined, { cancelled: true, cronLinePresent: false,
      note: 'The probe observes the cancellation marker and performs its own recovery if already running.' })));
    return;
  }
  if (operation === '--arm') {
    const plan = readPlan();
    if (Date.now() < Date.parse(FIXED.date + 'T00:00:00.000Z') || Date.now() >= EARLIEST) fail('FW_ARM_WINDOW_CLOSED');
    if (exists('cancelled.json') || exists('launch-claim.json')) fail('FW_JOB_ALREADY_FINISHED_OR_CANCELLED');
    // Cron opens its redirection before Node starts. Create and validate this
    // private file now so cron never falls back to mailing diagnostic output.
    fs.closeSync(openPrivateLog('job-cron.log'));
    const current = crontab();
    try { fs.writeFileSync(file('crontab-before-arm.private.txt'), current, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; ownedPrivate(file('crontab-before-arm.private.txt')); }
    const receipt = summary(plan, { armedAt: new Date().toISOString(), cronLine: CRON_LINE,
      sourceSha256: hashes(), cancelCommand: `${NODE} '${DIR}/job.cjs' --cancel` });
    // A writeable journal is required before creating the durable host task.
    writePrivate('arm-receipt.json', { ...receipt, state: 'arming' });
    editCron(true);
    writePrivate('arm-receipt.json', { ...receipt, state: 'armed', verifiedAt: new Date().toISOString() });
    console.log(JSON.stringify({ ...receipt, state: 'armed' }));
    return;
  }
  let plan; let claim = false; let result = { state: 'not-started' };
  try {
    plan = readPlan();
    if (Date.now() < EARLIEST || Date.now() > LATEST) fail('FW_LAUNCH_WINDOW_CLOSED');
    if (exists('cancelled.json')) fail('FW_JOB_CANCELLED');
    verifyArmedSources();
    ownedPrivate(file('job-cron.log'));
    try { writePrivate('launch-claim.json', { version: 1, claimedAt: new Date().toISOString(), marker: MARKER }, true); claim = true; }
    catch (error) { if (error.code === 'EEXIST') fail('FW_JOB_ALREADY_CLAIMED'); throw error; }
    // Remove the one-shot entry before spawning. A host reboot cannot replay it.
    editCron(false);
    const output = openPrivateLog('probe-stdout.log');
    let errors;
    try {
      errors = openPrivateLog('probe-stderr.log');
      const child = spawn(NODE, [file('probe.cjs'), '--execute-boundary'], { cwd: DIR,
        env: { ...process.env, FASTWARM_PROBE_DEVICE_ID: plan.target,
          FASTWARM_BOUNDARY_PROGRAMME_FINGERPRINT: plan.expectedFingerprint, FASTWARM_BOUNDARY_OUTPUT_DIR: DIR },
        stdio: ['ignore', output, errors] });
      const forward = signal => { child.kill(signal); };
      const onInterrupt = () => forward('SIGINT'); const onTerminate = () => forward('SIGTERM');
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
      try {
        const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
        result = { state: exit.code === 0 ? 'completed' : 'probe-failed', exitCode: exit.code, signal: exit.signal };
        if (exit.code !== 0) process.exitCode = 1;
      } finally { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); }
    } finally { fs.closeSync(output); if (errors !== undefined) fs.closeSync(errors); }
  } catch (error) {
    result = { state: 'refused', error: /^FW_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'FW_LAUNCH_FAILED' };
    process.exitCode = 1;
  } finally {
    editCron(false);
    // A duplicate invocation must not overwrite the active invocation's receipt.
    if (claim || !exists('launch-claim.json')) writePrivate('launch-receipt.json', summary(plan, { ...result,
      finishedAt: new Date().toISOString() }));
  }
  console.log(JSON.stringify(summary(plan, result)));
}
