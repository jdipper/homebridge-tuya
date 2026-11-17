/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs/promises';
import path from 'path';
import TuyaDevice from '../../src/device/TuyaDevice';
import {readFastWarmLanMetadata, saveFastWarmLanMetadata} from '../../src/device/lan/FastWarmLanBootstrap';

const INSTANCE = '0123456789abcdef';
const roots: string[] = [];
const device = (id = 'fixture-room', product_id = 'lmtejj3f4kafi2k1') => new TuyaDevice({
  id, uuid: 'uuid-' + id, name: 'Thermostat', product_id, product_name: 'ET-63 WIFI thermostat',
  category: 'wk', owner_id: 'household', room_id: 'room-1', room_name: 'Fixture Room', time_zone: '+00:00',
  create_time: 1700000000, active_time: 1700000010, update_time: 1700000020, online: true,
  schema: [
    {code: 'switch', type: 'Boolean', mode: 'rw', property: {}},
    {code: 'temp_set', type: 'Integer', mode: 'rw', property: {min: 50, max: 400, step: 5, scale: 1, unit: ''}},
    {code: 'temp_unit_convert', type: 'Enum', mode: 'rw', property: {range: ['c', 'f']}},
  ] as any,
  status: [{code: 'switch', value: true}, {code: 'temp_set', value: 180}, {code: 'temp_unit_convert', value: 'c'}],
});

async function fixture() {
  const root = await fs.mkdtemp('/private/tmp/fw-bootstrap-'); roots.push(root);
  const persist = path.join(root, 'persist'), file = path.join(persist, `FastWarmLocalMetadata.${INSTANCE}.json`);
  return {root, persist, file};
}

afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true});
});

test('round trips only exact FastWarm inventory with stable identities, room metadata and offline availability', async () => {
  const data = await fixture(), source = device();
  await saveFastWarmLanMetadata(data.persist, INSTANCE, [source, device('other-vendor', 'different-product')]);
  const saved = JSON.parse(await fs.readFile(data.file, 'utf8'));
  expect(saved.version).toBe(1); expect(saved.devices).toHaveLength(1);
  expect(saved.devices[0]).not.toHaveProperty('online');
  const restored = await readFastWarmLanMetadata(data.persist, INSTANCE);
  expect(restored).toHaveLength(1); expect(restored[0]).toBeInstanceOf(TuyaDevice);
  expect(restored[0]).toMatchObject({id: 'fixture-room', uuid: 'uuid-fixture-room', room_name: 'Fixture Room',
    product_id: 'lmtejj3f4kafi2k1', online: false, status: source.status, schema: source.schema});
  expect(source.online).toBe(true);
  expect((await fs.stat(data.file)).mode & 0o077).toBe(0);
});

test('omits credentials, addresses, coordinates, extra descriptors and unknown status values from saved metadata', async () => {
  const data = await fixture(), source: any = device();
  Object.assign(source, {local_key: 'private-key-never-cache', localKey: 'another-private-key', ip: '192.168.1.50',
    lat: '51.123', lon: '-1.123', endpoint: 'https://example.invalid', nested: {password: 'nested-secret'}});
  source.schema[1].onGet = 'arbitrary executable text';
  source.schema[1].property.access_token = 'property-secret';
  source.schema.push({code: 'local_key', mode: 'rw', type: 'String', property: {}});
  source.status.push({code: 'local_key', value: 'status-secret'}, {code: 'unknown_status', value: 'not-standard'});
  await saveFastWarmLanMetadata(data.persist, INSTANCE, [source]);
  const text = await fs.readFile(data.file, 'utf8');
  for (const forbidden of ['private-key', '192.168.1.50', '51.123', '-1.123', 'endpoint', 'nested-secret',
    'arbitrary executable', 'property-secret', 'status-secret', 'unknown_status', 'local_key']) expect(text).not.toContain(forbidden);
  expect((await readFastWarmLanMetadata(data.persist, INSTANCE))[0].status).toHaveLength(3);
});

test('a missing private cache or persist directory returns no devices', async () => {
  const data = await fixture();
  expect(await readFastWarmLanMetadata(data.persist, INSTANCE)).toEqual([]);
  await fs.mkdir(data.persist, {mode: 0o700});
  expect(await readFastWarmLanMetadata(data.persist, INSTANCE)).toEqual([]);
});

test.each(['../elsewhere', '0123456789abcdef/../../file', 'ABCDEF0123456789', '', '0'.repeat(17)])(
  'rejects invalid or traversing instance identifier %s before creating files', async instance => {
    const data = await fixture();
    await expect(saveFastWarmLanMetadata(data.persist, instance, [device()])).rejects.toThrow('invalid');
    await expect(readFastWarmLanMetadata(data.persist, instance)).rejects.toThrow('invalid');
    expect(await fs.readdir(data.root)).toEqual([]);
  },
);

test.each([0o644, 0o640, 0o602])('rejects a cache readable or writable by other users: %s', async mode => {
  const data = await fixture(); await saveFastWarmLanMetadata(data.persist, INSTANCE, [device()]);
  await fs.chmod(data.file, mode);
  await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.toThrow('invalid');
});

test('rejects symlink cache files without following or overwriting their target', async () => {
  const data = await fixture(); await fs.mkdir(data.persist, {mode: 0o700});
  const target = path.join(data.root, 'unrelated.json'); await fs.writeFile(target, 'unrelated', {mode: 0o600});
  await fs.symlink(target, data.file);
  await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.toThrow();
  await expect(saveFastWarmLanMetadata(data.persist, INSTANCE, [device()])).rejects.toThrow('invalid');
  expect(await fs.readFile(target, 'utf8')).toBe('unrelated');
});

test('rejects symlink or other-writable parent directories', async () => {
  const data = await fixture(), target = path.join(data.root, 'real'); await fs.mkdir(target, {mode: 0o700});
  await fs.symlink(target, data.persist);
  await expect(saveFastWarmLanMetadata(data.persist, INSTANCE, [device()])).rejects.toThrow('invalid');
  await fs.unlink(data.persist); await fs.mkdir(data.persist, {mode: 0o777}); await fs.chmod(data.persist, 0o777);
  await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.toThrow('invalid');
});

test('rejects metadata files owned by another account', async () => {
  const data = await fixture(); await saveFastWarmLanMetadata(data.persist, INSTANCE, [device()]);
  if (process.getuid) {
    const actual = process.getuid(); jest.spyOn(process, 'getuid').mockReturnValue(actual + 1);
    await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.toThrow('invalid');
  }
});

test.each(['wrong-product', 'duplicate-id', 'bad-schema', 'bad-status', 'extra-field', 'online-field', 'wrong-version']) (
  'rejects altered cache metadata: %s', async alteration => {
    const data = await fixture(); await saveFastWarmLanMetadata(data.persist, INSTANCE, [device()]);
    const value = JSON.parse(await fs.readFile(data.file, 'utf8'));
    if (alteration === 'wrong-product') value.devices[0].product_id = 'other-vendor';
    if (alteration === 'duplicate-id') value.devices.push(value.devices[0]);
    if (alteration === 'bad-schema') value.devices[0].schema[0].onSet = 'unreviewed code';
    if (alteration === 'bad-status') value.devices[0].status[0].value = {local_key: 'malicious'};
    if (alteration === 'extra-field') value.devices[0].ip = '192.168.1.9';
    if (alteration === 'online-field') value.devices[0].online = true;
    if (alteration === 'wrong-version') value.version = 2;
    await fs.writeFile(data.file, JSON.stringify(value), {mode: 0o600});
    await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.toThrow('invalid');
  },
);

test('bounds file reads and reports malformed JSON without echoing its contents', async () => {
  const data = await fixture(); await fs.mkdir(data.persist, {mode: 0o700});
  await fs.writeFile(data.file, 'x'.repeat(1024 * 1024 + 1), {mode: 0o600});
  await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.toThrow('invalid');
  await fs.writeFile(data.file, '{"password":"never-echo-this-secret",BROKEN}', {mode: 0o600});
  await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.not.toThrow('never-echo-this-secret');
  await expect(readFastWarmLanMetadata(data.persist, INSTANCE)).rejects.toThrow('invalid');
});

test('an invalid update does not replace an existing valid cache', async () => {
  const data = await fixture(); await saveFastWarmLanMetadata(data.persist, INSTANCE, [device()]);
  const before = await fs.readFile(data.file, 'utf8'), invalid: any = device(); invalid.status[0].value = {not: 'scalar'};
  await expect(saveFastWarmLanMetadata(data.persist, INSTANCE, [invalid])).rejects.toThrow('invalid');
  expect(await fs.readFile(data.file, 'utf8')).toBe(before);
});
