import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import vm from 'vm';
import * as helpers from '../src/device/lan/FastWarmLanConfiguration';
import {TuyaPlatform} from '../src/platform';
import {
  createLocalSetupHandlers, configuredDevices, instanceIdForPlatform, readConfiguration, ERROR_MESSAGE,
} from '../homebridge-ui/server';

const KEY = 'SECRET_KEY_12345';
const ACCOUNT = 'ACCOUNT_CANARY';
const BRIDGE = 'AA:BB:CC:DD:EE:01';
const local = {deviceId: 'fixture-device', address: '192.168.1.50', version: '3.5'};
const platform = () => ({platform: 'TuyaPlatform', name: 'Tuya', _bridge: {username: BRIDGE}, options: {
  projectType: '2', endpoint: 'https://endpoint.invalid', accessId: 'ACCESS_ID_CANARY', accessKey: KEY,
  username: ACCOUNT, password: 'PASSWORD_CANARY', fastWarmLocalDevices: [{...local}],
}});

function childRuntimeInstance(raw: object): string {
  // Homebridge childBridgeFork.loadPlugin removes _bridge before constructing the plugin.
  const config = structuredClone(raw) as {options: object; _bridge?: unknown};
  delete config._bridge;
  const runtime = Object.assign(Object.create(TuyaPlatform.prototype), {config, options: config.options});
  return runtime.programmeInstanceId();
}

describe('private FastWarm LAN setup routes', () => {
  let directory: string;
  let configPath: string;
  let handlers: ReturnType<typeof createLocalSetupHandlers>;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fastwarm-ui-')));
    configPath = path.join(directory, 'config.json');
    await fs.mkdir(path.join(directory, 'persist'), {mode: 0o700});
    handlers = createLocalSetupHandlers({storagePath: directory, configPath}, helpers);
    await fs.writeFile(configPath, JSON.stringify({platforms: [platform()]}), {mode: 0o600});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, {recursive: true, force: true});
  });

  function payload() {
    return {instanceId: instanceIdForPlatform(platform()), deviceId: local.deviceId, localKey: KEY};
  }

  function noSecrets(value: unknown) {
    const text = JSON.stringify(value);
    for (const secret of [KEY, ACCOUNT, BRIDGE, 'ACCESS_ID_CANARY', 'PASSWORD_CANARY', directory]) {
      expect(text).not.toContain(secret);
    }
  }

  test('raw child-bridge configuration resolves to the actual normalized platform identity', () => {
    const raw = platform();
    for (const entry of [raw, {...raw, _bridge: {username: 'AA:BB:CC:DD:EE:99'}}, {...raw, _bridge: undefined}]) {
      expect(instanceIdForPlatform(entry)).toBe(childRuntimeInstance(entry));
    }
  });

  test('finds and updates an existing runtime key without creating a second raw-bridge namespace', async () => {
    const runtimeId = childRuntimeInstance(platform());
    const persist = path.join(directory, 'persist');
    const store = new helpers.FastWarmLanKeyStore(persist, runtimeId);
    await store.set(local.deviceId, KEY);
    const result = await handlers['/local/devices']();
    expect(result).toEqual({devices: [{instanceId: runtimeId, ...local, enabled: true, keyStored: true}]});
    noSecrets(result);
    await expect(handlers['/local/key']({instanceId: runtimeId, deviceId: local.deviceId, localKey: KEY}))
      .resolves.toEqual({stored: true, restartRequired: true});
    expect(await fs.readdir(persist)).toEqual([`FastWarmLocalKeys.${runtimeId}.json`]);
    expect(await store.read(local.deviceId)).toBe(KEY);
  });

  test('lists configured connection metadata and a Boolean key status only', async () => {
    const result = await handlers['/local/devices']({});
    expect(result).toEqual({devices: [{instanceId: payload().instanceId, ...local, enabled: true, keyStored: false}]});
    noSecrets(result);
    expect(await fs.readdir(path.join(directory, 'persist'))).toEqual([]);
  });

  test('stores the selected configured key privately, never returning it or restarting a bridge', async () => {
    expect(await handlers['/local/key'](payload())).toEqual({stored: true, restartRequired: true});
    const store = new helpers.FastWarmLanKeyStore(path.join(directory, 'persist'), payload().instanceId);
    expect(await store.read(local.deviceId)).toBe(KEY);
    const result = await handlers['/local/devices']();
    expect(result.devices[0].keyStored).toBe(true);
    noSecrets(result);
    noSecrets(await handlers['/local/key'](payload()));
  });

  test('routes coexisting Tuya instances separately and excludes unrelated plugins or accounts', async () => {
    const first = platform();
    const second = {...platform(), _bridge: {username: 'AA:BB:CC:DD:EE:02'}, options: {
      ...platform().options, username: 'SECOND_ACCOUNT', fastWarmLocalDevices: [{...local, address: '10.0.0.5', enabled: false}],
    }};
    const unrelated = {...platform(), platform: 'HiveHome', options: {fastWarmLocalDevices: [{address: 'https://trap.invalid'}]}};
    const otherPlugin = {...platform(), plugin: 'another-plugin'};
    await fs.writeFile(configPath, JSON.stringify({platforms: [unrelated, first, otherPlugin, second]}));
    const result = await handlers['/local/devices']();
    expect(result.devices).toHaveLength(2);
    expect(result.devices.map(device => device.instanceId)).toEqual([instanceIdForPlatform(first), instanceIdForPlatform(second)]);
    expect(result.devices[1].enabled).toBe(false);
    await handlers['/local/key']({...payload(), instanceId: instanceIdForPlatform(second)});
    const firstStore = new helpers.FastWarmLanKeyStore(path.join(directory, 'persist'), instanceIdForPlatform(first));
    const secondStore = new helpers.FastWarmLanKeyStore(path.join(directory, 'persist'), instanceIdForPlatform(second));
    expect(await firstStore.has(local.deviceId)).toBe(false);
    expect(await secondStore.has(local.deviceId)).toBe(true);
    noSecrets(result);
    expect(JSON.stringify(result)).not.toContain('SECOND_ACCOUNT');
  });

  test.each([
    {instanceId: 'f'.repeat(16)}, {deviceId: 'unknown-device'}, {deviceId: '../outside'}, {localKey: 'é'.repeat(16)},
    {localKey: 'short'}, {localKey: 'a'.repeat(16) + '\n'}, {configPath: '/outside'}, {address: '10.0.0.99'},
  ])('unknown identity, extra fields and malformed keys cannot create a key file', async override => {
    await expect(handlers['/local/key']({...payload(), ...override})).rejects.toThrow(ERROR_MESSAGE);
    expect(await fs.readdir(path.join(directory, 'persist'))).toEqual([]);
  });

  test('rejects missing fields, prototype entries, accessors and list payload selectors', async () => {
    for (const value of [null, [], {}, {instanceId: payload().instanceId, deviceId: local.deviceId},
      Object.assign(Object.create({localKey: KEY}), payload()), Object.defineProperty(payload(), 'localKey', {get: () => {
        throw Error(KEY);
      }})]) {
      await expect(handlers['/local/key'](value)).rejects.toThrow(ERROR_MESSAGE);
    }
    await expect(handlers['/local/devices']({instanceId: payload().instanceId})).rejects.toThrow(ERROR_MESSAGE);
    expect(await fs.readdir(path.join(directory, 'persist'))).toEqual([]);
  });

  test('rechecks saved configuration before key storage and rejects ambiguous instances', async () => {
    await handlers['/local/devices']();
    await fs.writeFile(configPath, JSON.stringify({platforms: []}));
    await expect(handlers['/local/key'](payload())).rejects.toThrow(ERROR_MESSAGE);
    expect(configuredDevices({platforms: []}, helpers.parseFastWarmLocalDevices)).toEqual([]);
    await fs.writeFile(configPath, JSON.stringify({platforms: [platform(), platform()]}));
    await expect(handlers['/local/devices']()).rejects.toThrow(ERROR_MESSAGE);
    expect(await fs.readdir(path.join(directory, 'persist'))).toEqual([]);
  });

  test('supports the trusted UI configuration path without accepting a browser-selected path', async () => {
    const another = path.join(directory, 'selected-config.json');
    await fs.writeFile(another, JSON.stringify({platforms: []}), {mode: 0o600});
    const selected = createLocalSetupHandlers({storagePath: directory, configPath: another}, helpers);
    expect(await selected['/local/devices']()).toEqual({devices: []});
    await expect(selected['/local/key']({...payload(), configPath})).rejects.toThrow(ERROR_MESSAGE);
  });

  test('rejects config symlinks, non-files, oversized data and writable files without leaking errors', async () => {
    const target = path.join(directory, 'actual-config.json');
    await fs.rename(configPath, target);
    await fs.symlink(target, configPath);
    await expect(readConfiguration(configPath)).rejects.toThrow(ERROR_MESSAGE);
    await fs.unlink(configPath);
    await fs.mkdir(configPath);
    await expect(readConfiguration(configPath)).rejects.toThrow(ERROR_MESSAGE);
    await fs.rmdir(configPath);
    await fs.writeFile(configPath, 'x'.repeat(1024 * 1024 + 1), {mode: 0o600});
    await expect(readConfiguration(configPath)).rejects.toThrow(ERROR_MESSAGE);
    await fs.writeFile(configPath, JSON.stringify({platforms: []}));
    await fs.chmod(configPath, 0o666);
    await expect(readConfiguration(configPath)).rejects.toThrow(ERROR_MESSAGE);
  });

  test('checks configuration ownership and sanitizes JSON and key-store failures', async () => {
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      jest.spyOn(process, 'getuid').mockReturnValueOnce(uid).mockReturnValue(uid + 1);
      await expect(readConfiguration(configPath)).rejects.toThrow(ERROR_MESSAGE);
      jest.restoreAllMocks();
    }
    await fs.writeFile(configPath, '{' + KEY);
    for (const operation of [() => handlers['/local/devices'](), () => handlers['/local/key'](payload())]) {
      try {
        await operation(); throw Error('Expected rejection');
      } catch (error) {
        expect((error as Error).message).toBe(ERROR_MESSAGE);
        noSecrets({message: (error as Error).message});
        expect((error as Error & {cause?: unknown}).cause).toBeUndefined();
      }
    }
    await fs.writeFile(configPath, JSON.stringify({platforms: [platform()]}));
    const injected = createLocalSetupHandlers({storagePath: directory, configPath}, {...helpers,
      FastWarmLanKeyStore: class {
        async has() {
          throw Error(KEY + directory);
        }

        async set() {
          throw Error(KEY + ACCOUNT);
        }
      },
    });
    await expect(injected['/local/devices']()).rejects.toThrow(ERROR_MESSAGE);
    await expect(injected['/local/key'](payload())).rejects.toThrow(ERROR_MESSAGE);
  });
});

class Element {
  children: Element[] = [];
  listeners: Record<string, (event?: unknown) => unknown> = {};
  attributes: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  disabled = false;
  constructor(readonly tag: string) {}
  appendChild(child: Element) {
    this.children.push(child); return child;
  }

  replaceChildren() {
    this.children = [];
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  addEventListener(name: string, listener: (event?: unknown) => unknown) {
    this.listeners[name] = listener;
  }

  set innerHTML(_value: string) {
    throw Error('HTML interpolation is forbidden');
  }
}

function descendants(element: Element): Element[] {
  return [element, ...element.children.flatMap(descendants)];
}

describe('FastWarm key setup page', () => {
  test.each([false, true])('uses safe text and clears password on submission, including a server error: %s', async fail => {
    const html = await fs.readFile(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const nodes = Object.fromEntries(['settings', 'refresh', 'notice', 'devices'].map(id => [id, new Element('div')]));
    const selected = {instanceId: '0123456789abcdef', ...local, enabled: true, keyStored: false};
    const request = jest.fn(async route => {
      if (route === '/local/devices') {
        return {devices: [selected]};
      }
      if (fail) {
        throw Error(KEY + ACCOUNT);
      }
      return {stored: true, restartRequired: true};
    });
    const homebridge = {request, showSchemaForm: jest.fn()};
    const fakeConsole = {log: jest.fn(), error: jest.fn()};
    vm.runInNewContext(script!, {window: {homebridge}, console: fakeConsole, document: {
      getElementById: (id: string) => nodes[id], createElement: (tag: string) => new Element(tag),
    }});
    await new Promise(resolve => setImmediate(resolve));
    const all = descendants(nodes.devices), input = all.find(node => node.tag === 'input')!, form = all.find(node => node.tag === 'form')!;
    expect(input.type).toBe('password');
    input.value = KEY;
    const submission = form.listeners.submit({preventDefault: jest.fn()});
    expect(input.value).toBe('');
    await submission;
    expect(input.value).toBe('');
    expect(request).toHaveBeenCalledWith('/local/key', {instanceId: selected.instanceId, deviceId: selected.deviceId, localKey: KEY});
    const shown = descendants(nodes.devices).map(node => node.textContent).join(' ');
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(ACCOUNT);
    expect(shown).toContain(fail ? 'could not be saved' : 'Restart the Tuya child bridge');
    expect(fakeConsole.log).not.toHaveBeenCalled();
    expect(fakeConsole.error).not.toHaveBeenCalled();
    nodes.settings.listeners.click();
    expect(homebridge.showSchemaForm).toHaveBeenCalledTimes(1);
    expect(script).not.toMatch(/innerHTML|localStorage|sessionStorage|console\.(?:log|error)|\.restart\(/);
    expect(html).toContain('Heating Programmes');
  });
});
