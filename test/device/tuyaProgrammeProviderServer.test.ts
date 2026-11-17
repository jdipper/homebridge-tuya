import fs from 'fs/promises';
import path from 'path';
import { request } from 'http';
import TuyaProgrammeProviderServer from '../../src/device/schedule/TuyaProgrammeProviderServer';

const instance = '0123456789abcdef';
const fixtures: { directory: string; storage: string; server: TuyaProgrammeProviderServer }[] = [];
async function fixture(automatic = false) {
  const storage = await fs.mkdtemp('/tmp/tpp-');
  const directory = path.join(storage, 'persist');
  await fs.mkdir(directory, { mode: 0o700 });
  const handler = jest.fn(async () => ({ zones: [] }));
  const server = new TuyaProgrammeProviderServer(directory, instance, handler, automatic);
  fixtures.push({ directory, storage, server });
  return { directory, server, handler };
}
afterEach(async () => {
  for (const data of fixtures.splice(0)) {
    await data.server.close();
    await fs.rm(data.storage, { recursive: true, force: true });
  }
});

function call(socketPath: string, token: string, route = '/provider/list', body = '{}'): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: route, method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

test('uses private files and a versioned authenticated socket without exposing its token in replies', async () => {
  const data = await fixture(); await data.server.start();
  const file = path.join(data.directory, `TuyaProgrammeProvider.${instance}.json`);
  const descriptor = JSON.parse(await fs.readFile(file, 'utf8'));
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(descriptor.socketPath)).mode & 0o777).toBe(0o600);
  expect(path.dirname(descriptor.socketPath)).toBe(await fs.realpath(path.join(path.dirname(data.directory), 'heating-runtime')));
  expect((await fs.stat(path.dirname(descriptor.socketPath))).mode & 0o777).toBe(0o700);
  // Homebridge's node-persist can safely scan every entry during a child-bridge restart.
  for (const name of await fs.readdir(data.directory)) {
    expect((await fs.lstat(path.join(data.directory, name))).isFile()).toBe(true);
    JSON.parse(await fs.readFile(path.join(data.directory, name), 'utf8'));
  }
  expect(descriptor).toMatchObject({ version: 1, protocolVersion: 1, plugin: '@jdipper/homebridge-tuya', instanceId: instance });
  const result = await call(descriptor.socketPath, descriptor.token);
  expect(result).toEqual({ status: 200, body: { protocolVersion: 1, instanceId: instance, zones: [] } });
  expect(data.handler).toHaveBeenCalledWith('/provider/list', {});
  expect(JSON.stringify(result)).not.toContain(descriptor.token);
  await data.server.close();
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects a symlink or readable socket directory outside persist before exposing a socket', async () => {
  const data = await fixture();
  const runtime = path.join(path.dirname(data.directory), 'heating-runtime');
  const other = path.join(path.dirname(data.directory), 'other');
  await fs.mkdir(other, { mode: 0o700 });
  await fs.symlink(other, runtime);
  await expect(data.server.start()).rejects.toThrow('private runtime directory');
  await fs.unlink(runtime);
  await fs.mkdir(runtime, { mode: 0o755 });
  await expect(data.server.start()).rejects.toThrow('private runtime directory');
  expect(await fs.readdir(data.directory)).toEqual([]);
});

test('rejects missing authentication, unknown routes and malformed/oversized requests before calling the device', async () => {
  const data = await fixture(); await data.server.start();
  const descriptor = JSON.parse(await fs.readFile(path.join(data.directory, `TuyaProgrammeProvider.${instance}.json`), 'utf8'));
  expect((await call(descriptor.socketPath, 'wrong')).status).toBe(403);
  expect((await call(descriptor.socketPath, descriptor.token, '/presence')).status).toBe(405);
  expect((await call(descriptor.socketPath, descriptor.token, '/provider/list', '[]')).status).toBe(400);
  expect((await call(descriptor.socketPath, descriptor.token, '/provider/list', JSON.stringify({ data: 'x'.repeat(131072) }))).status).toBe(413);
  expect(data.handler).not.toHaveBeenCalled();
});

test('a live provider with the same identity prevents replacing its socket or descriptor', async () => {
  const data = await fixture(); await data.server.start();
  const second = new TuyaProgrammeProviderServer(data.directory, instance, async () => ({}));
  await expect(second.start()).rejects.toThrow('already running');
  await second.close();
});

test('concurrent startup admits exactly one owner and the losing instance cannot unlink the winner', async () => {
  const data = await fixture();
  const other = new TuyaProgrammeProviderServer(data.directory, instance, async () => ({ zones: [] }));
  const outcomes = await Promise.allSettled([data.server.start(), other.start()]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const winner = outcomes[0].status === 'fulfilled' ? data.server : other;
  const loser = winner === data.server ? other : data.server;
  const ownerFile = path.join(data.directory, `TuyaProgrammeProviderOwner.${instance}.json`);
  const descriptorFile = path.join(data.directory, `TuyaProgrammeProvider.${instance}.json`);
  const before = await fs.readFile(ownerFile, 'utf8');
  expect((await fs.stat(ownerFile)).mode & 0o777).toBe(0o600);
  await loser.close();
  expect(await fs.readFile(ownerFile, 'utf8')).toBe(before);
  const descriptor = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
  expect((await call(descriptor.socketPath, descriptor.token)).status).toBe(200);
  await winner.close();
  await expect(fs.stat(ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('the private allowlist exposes explicit room refresh without exposing household routes', async () => {
  const data = await fixture(); await data.server.start();
  const descriptor = JSON.parse(await fs.readFile(path.join(data.directory, `TuyaProgrammeProvider.${instance}.json`), 'utf8'));
  expect((await call(descriptor.socketPath, descriptor.token, '/provider/refresh')).status).toBe(200);
  expect(data.handler).toHaveBeenCalledWith('/provider/refresh', {});
  expect((await call(descriptor.socketPath, descriptor.token, '/holiday')).status).toBe(405);
  expect(data.handler).toHaveBeenCalledTimes(1);
});

test('a private dead-process owner can be replaced and shutdown preserves a replacement token', async () => {
  const data = await fixture();
  const ownerFile = path.join(data.directory, `TuyaProgrammeProviderOwner.${instance}.json`);
  await fs.writeFile(ownerFile, JSON.stringify({ pid: 99_999_999, token: 'a'.repeat(64) }), { mode: 0o600 });
  await data.server.start();
  const original = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  expect(original.pid).toBe(process.pid);
  expect(original.token).not.toBe('a'.repeat(64));
  const replacement = JSON.stringify({ pid: process.pid, token: 'b'.repeat(64) });
  await fs.writeFile(ownerFile, replacement, { mode: 0o600 });
  await data.server.close();
  expect(await fs.readFile(ownerFile, 'utf8')).toBe(replacement);
});

test('unsafe or malformed owner admission records block socket creation', async () => {
  const data = await fixture();
  const ownerFile = path.join(data.directory, `TuyaProgrammeProviderOwner.${instance}.json`);
  await fs.writeFile(ownerFile, '{}', { mode: 0o600 });
  await expect(data.server.start()).rejects.toThrow('needs review');
  await fs.rm(ownerFile);
  const target = path.join(data.directory, 'outside-owner.json');
  await fs.writeFile(target, JSON.stringify({ pid: 99_999_999, token: 'a'.repeat(64) }), { mode: 0o600 });
  await fs.symlink(target, ownerFile);
  await expect(data.server.start()).rejects.toThrow();
  await expect(fs.stat(path.join(data.directory, `tuya-programmes-${instance}.sock`))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects symlink descriptors and group-writable persistence directories', async () => {
  const data = await fixture();
  const target = path.join(data.directory, 'target.json');
  await fs.writeFile(target, '{}', { mode: 0o600 });
  await fs.symlink(target, path.join(data.directory, `TuyaProgrammeProvider.${instance}.json`));
  await expect(data.server.start()).rejects.toThrow();
  await fs.rm(path.join(data.directory, `TuyaProgrammeProvider.${instance}.json`));
  await fs.chmod(data.directory, 0o770);
  await expect(data.server.start()).rejects.toThrow('owner-controlled');
});


test('only an explicitly capable backend advertises queue-owned automatic baseline support', async () => {
  const data = await fixture(true); await data.server.start();
  const descriptor = JSON.parse(await fs.readFile(path.join(data.directory, `TuyaProgrammeProvider.${instance}.json`), 'utf8'));
  expect(descriptor.capabilities).toEqual({automaticFreshBaseline: true});
  const reply = await call(descriptor.socketPath, descriptor.token, '/provider/prepare-automatic', '{}');
  expect(reply.status).toBe(200);
  expect(data.handler).toHaveBeenCalledWith('/provider/prepare-automatic', {});
});
