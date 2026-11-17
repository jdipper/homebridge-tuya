import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FastWarmLanKeyStore, parseFastWarmLocalDevices } from '../../src/device/lan/FastWarmLanConfiguration';

const INSTANCE = '0123456789abcdef';
const KEY = 'SECRET_KEY_12345';
const OTHER_KEY = 'OTHER_KEY_123456';
const config = {deviceId: 'fixture-device', address: '192.168.1.50', version: '3.5'};
const CONFIG_ERROR = 'FastWarm local device configuration is invalid.';
const STORE_ERROR = 'FastWarm local key storage is unavailable.';

describe('FastWarm local device configuration', () => {
  test('absence disables local devices; valid entries are copied without credentials', () => {
    expect(parseFastWarmLocalDevices(undefined)).toEqual([]);
    const input = [{...config, enabled: false}];
    const parsed = parseFastWarmLocalDevices(input);
    expect(parsed).toEqual(input);
    expect(parsed[0]).not.toBe(input[0]);
    expect(parseFastWarmLocalDevices([config])).toEqual([config]);
  });

  test.each(['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.2'])(
    'accepts RFC1918 address %s', address => {
      expect(parseFastWarmLocalDevices([{...config, address}])[0].address).toBe(address);
    });

  test.each([
    '127.0.0.1', '0.0.0.0', '8.8.8.8', '100.64.0.1', '169.254.1.1', '172.15.1.1', '172.32.1.1',
    '192.169.1.1', '10.0.0.256', '010.0.0.1', '192.168.1', '192.168.1.1:6668', 'localhost',
    'https://192.168.1.1', '192.168.1.1/path', '192.168.1.1\n', ' 192.168.1.1', '::1', 'fc00::1',
  ])('rejects a URL, name, public, ambiguous or non-IPv4 address %s', address => {
    expect(() => parseFastWarmLocalDevices([{...config, address}])).toThrow(CONFIG_ERROR);
  });

  test.each([null, {}, 'devices', [null], [undefined], new Array(1)])('rejects malformed configuration %j', value => {
    expect(() => parseFastWarmLocalDevices(value)).toThrow(CONFIG_ERROR);
  });

  test('rejects duplicate device IDs and duplicate addresses, including disabled entries', () => {
    expect(() => parseFastWarmLocalDevices([config, {...config, address: '10.0.0.2', enabled: false}])).toThrow(CONFIG_ERROR);
    expect(() => parseFastWarmLocalDevices([config, {...config, deviceId: 'another-device'}])).toThrow(CONFIG_ERROR);
  });

  test.each([
    {...config, localKey: KEY}, {...config, local_key: KEY}, {...config, protocol: '3.5'},
    {...config, version: '3.4'}, {...config, version: 3.5}, {...config, enabled: 'true'},
    {...config, deviceId: '../outside'}, {...config, deviceId: 'a'.repeat(129)}, {...config, deviceId: 'room\n'},
    {...config, deviceId: 'røom'}, JSON.parse('{"__proto__":{},"deviceId":"fixture-device","address":"10.0.0.1","version":"3.5"}'),
  ])('rejects unknown properties, credentials and invalid types without exposing values', value => {
    expect(() => parseFastWarmLocalDevices([value])).toThrow(CONFIG_ERROR);
    try {
      parseFastWarmLocalDevices([value]);
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
  });

  test('rejects custom prototypes, symbols and accessors without executing getters', () => {
    const getter = jest.fn(() => {
      throw Error(KEY);
    });
    const accessor = Object.defineProperty({...config}, 'deviceId', {get: getter});
    for (const value of [Object.assign(Object.create({localKey: KEY}), config), {...config, [Symbol('extra')]: KEY}, accessor]) {
      expect(() => parseFastWarmLocalDevices([value])).toThrow(CONFIG_ERROR);
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('FastWarm local key store', () => {
  let directory: string;
  let store: FastWarmLanKeyStore;
  let file: string;

  beforeEach(async () => {
    // macOS exposes its temp location through a system /var symlink; use the actual supplied directory.
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fastwarm-keys-')));
    file = path.join(directory, `FastWarmLocalKeys.${INSTANCE}.json`);
    store = new FastWarmLanKeyStore(directory, INSTANCE);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, {recursive: true, force: true});
  });

  async function save(value: unknown) {
    await fs.writeFile(file, JSON.stringify(value), {mode: 0o600});
  }

  test('missing keys return undefined/false without creating a file', async () => {
    expect(await store.read('fixture-device')).toBeUndefined();
    expect(await store.has('fixture-device')).toBe(false);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  test('writes only a version and keys at a fixed private filename without changing persist permissions', async () => {
    await fs.chmod(directory, 0o755);
    await store.set('fixture-device', KEY);
    expect(await store.read('fixture-device')).toBe(KEY);
    expect(await store.has('fixture-device')).toBe(true);
    expect(await fs.readdir(directory)).toEqual([path.basename(file)]);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({version: 1, keys: {'fixture-device': KEY}});
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
  });

  test('updates preserve other keys and prototype-named device IDs remain ordinary own entries', async () => {
    await store.set('fixture-device', KEY);
    await store.set('__proto__', OTHER_KEY);
    await store.set('constructor', KEY);
    await store.set('fixture-device', OTHER_KEY);
    expect(await store.read('fixture-device')).toBe(OTHER_KEY);
    expect(await store.read('__proto__')).toBe(OTHER_KEY);
    expect(await store.read('constructor')).toBe(KEY);
    expect(await store.read('toString')).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('fixture-device');
  });

  test('serializes concurrent read-modify-writes across instances without dropping keys', async () => {
    const other = new FastWarmLanKeyStore(directory, INSTANCE.toUpperCase());
    await Promise.all(Array.from({length: 20}, (_, i) => (i % 2 ? store : other).set('fixture-' + i, KEY)));
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(saved.keys)).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(await store.read('fixture-' + i)).toBe(KEY);
    }
    expect(await fs.readdir(directory)).toEqual([path.basename(file)]);
  });

  test.each(['short', 'a'.repeat(17), 'a'.repeat(15) + 'é', 'a'.repeat(15) + '\n', 'a'.repeat(15) + '\x7f', 'a'.repeat(16) + '\n'])(
    'rejects non-printable, Unicode and incorrectly sized keys without exposing them', async key => {
      await expect(store.set('fixture-device', key)).rejects.toThrow(STORE_ERROR);
      expect(await fs.readdir(directory)).toEqual([]);
    });

  test.each(['../escape', '', 'a'.repeat(129), 'fixture\n', 'fixture/name'])(
    'rejects device IDs before filesystem operations', async id => {
      await expect(store.read(id)).rejects.toThrow(STORE_ERROR);
      await expect(store.set(id, KEY)).rejects.toThrow(STORE_ERROR);
    });

  test('constructor rejects filename/path escapes without disclosing the supplied path', () => {
    for (const instance of ['../outside', '', INSTANCE + '/outside']) {
      expect(() => new FastWarmLanKeyStore(directory, instance)).toThrow(STORE_ERROR);
    }
    for (const root of ['relative', directory + '/../outside', directory + '\0outside']) {
      expect(() => new FastWarmLanKeyStore(root, INSTANCE)).toThrow(STORE_ERROR);
    }
  });

  test.each([
    null, [], {}, {version: 2, keys: {}}, {version: 1, keys: [], secret: KEY},
    {version: 1, keys: {}, metadata: KEY}, {version: 1, keys: {'../escape': KEY}},
    {version: 1, keys: {'fixture-device': 'a'.repeat(15) + 'é'}},
    {version: 1, keys: {'fixture-device': {localKey: KEY}}},
  ])('rejects the entire malformed stored schema without discarding it', async value => {
    await save(value);
    const original = await fs.readFile(file, 'utf8');
    await expect(store.read('fixture-device')).rejects.toThrow(STORE_ERROR);
    await expect(store.set('another-device', OTHER_KEY)).rejects.toThrow(STORE_ERROR);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  test('rejects permissive files without repairing or overwriting them', async () => {
    await save({version: 1, keys: {'fixture-device': KEY}});
    await fs.chmod(file, 0o640);
    await expect(store.read('fixture-device')).rejects.toThrow(STORE_ERROR);
    await expect(store.set('another-device', OTHER_KEY)).rejects.toThrow(STORE_ERROR);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
  });

  test('rejects a writable persist directory without changing its permissions', async () => {
    await fs.chmod(directory, 0o777);
    await expect(store.set('fixture-device', KEY)).rejects.toThrow(STORE_ERROR);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o777);
  });

  test('does not follow an existing key-file symlink or replace its target', async () => {
    const target = path.join(directory, 'target.json');
    const contents = JSON.stringify({version: 1, keys: {'fixture-device': KEY}});
    await fs.writeFile(target, contents, {mode: 0o600});
    await fs.symlink(target, file);
    await expect(store.read('fixture-device')).rejects.toThrow(STORE_ERROR);
    await expect(store.set('fixture-device', OTHER_KEY)).rejects.toThrow(STORE_ERROR);
    expect(await fs.readFile(target, 'utf8')).toBe(contents);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  });

  test('rejects symlinked persist directories and intermediate path components', async () => {
    const actual = path.join(directory, 'actual'), linked = path.join(directory, 'linked');
    await fs.mkdir(path.join(actual, 'nested'), {recursive: true, mode: 0o700});
    await fs.symlink(actual, linked);
    for (const root of [linked, path.join(linked, 'nested')]) {
      const escaped = new FastWarmLanKeyStore(root, INSTANCE);
      await expect(escaped.read('fixture-device')).rejects.toThrow(STORE_ERROR);
      await expect(escaped.set('fixture-device', KEY)).rejects.toThrow(STORE_ERROR);
    }
  });

  test('rejects directories, oversized files and hard-linked key files', async () => {
    await fs.mkdir(file);
    await expect(store.read('fixture-device')).rejects.toThrow(STORE_ERROR);
    await fs.rmdir(file);
    await fs.writeFile(file, 'x'.repeat(65_537), {mode: 0o600});
    await expect(store.read('fixture-device')).rejects.toThrow(STORE_ERROR);
    await fs.unlink(file);
    await save({version: 1, keys: {'fixture-device': KEY}});
    await fs.link(file, path.join(directory, 'alias.json'));
    await expect(store.read('fixture-device')).rejects.toThrow(STORE_ERROR);
  });

  test('refuses a key file owned by another user', async () => {
    if (typeof process.getuid !== 'function') {
      return;
    }
    await save({version: 1, keys: {'fixture-device': KEY}});
    const uid = process.getuid();
    jest.spyOn(process, 'getuid').mockReturnValueOnce(uid).mockReturnValue(uid + 1);
    await expect(store.read('fixture-device')).rejects.toThrow(STORE_ERROR);
  });

  test('bounds new serialized files as well as existing files', async () => {
    const keys = Object.fromEntries(Array.from({length: 430}, (_, i) => [('fixture-' + i).padEnd(128, 'x'), KEY]));
    await save({version: 1, keys});
    expect((await fs.stat(file)).size).toBeLessThan(65_536);
    const original = await fs.readFile(file, 'utf8');
    await expect(store.set('another-device', OTHER_KEY)).rejects.toThrow(STORE_ERROR);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  test('errors never include malformed JSON, key material, device IDs or filesystem paths', async () => {
    await fs.writeFile(file, '{' + KEY, {mode: 0o600});
    const operations = [() => store.read('fixture-device'), () => store.set('fixture-device', KEY), () => store.has('fixture-device')];
    for (const operation of operations) {
      try {
        await operation();
        throw Error('Expected rejection');
      } catch (error) {
        expect((error as Error).message).toBe(STORE_ERROR);
        expect(String(error)).not.toContain(KEY);
        expect(String(error)).not.toContain('fixture-device');
        expect(String(error)).not.toContain(directory);
        expect((error as Error & {cause?: unknown}).cause).toBeUndefined();
      }
    }
  });
});
