import { ChildProcess, fork } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { once } from 'events';
import ThermostatRuntimeServer, { ThermostatRuntimeDescriptor } from '../src/device/schedule/ThermostatRuntimeServer';

interface UiResponse {
  success: boolean;
  data: unknown;
}

/** Exercise the real ESM UI SDK and its IPC protocol without Homebridge or Tuya. */
describe('Homebridge custom UI runtime relay', () => {
  let directory: string;
  let persistPath: string;
  let descriptorPath: string;
  let descriptor: ThermostatRuntimeDescriptor;
  let runtime: ThermostatRuntimeServer;
  let child: ChildProcess;
  let handler: jest.Mock;
  let requestId = 0;
  let output = '';

  const call = (requestPath: string, body: Record<string, unknown> = {}) => new Promise<UiResponse>((resolve, reject) => {
    const id = `test-${++requestId}`;
    const timeout = setTimeout(() => {
      child.removeListener('message', receive);
      reject(new Error(`UI request ${requestPath} timed out.`));
    }, 5000);
    const receive = (message: unknown) => {
      const response = message as { action?: string; payload?: { requestId?: string } & UiResponse };
      if (response.action === 'response' && response.payload?.requestId === id) {
        clearTimeout(timeout);
        child.removeListener('message', receive);
        resolve({ success: response.payload.success, data: response.payload.data });
      }
    };
    child.on('message', receive);
    child.send({ action: 'request', requestId: id, path: requestPath, body }, error => {
      if (error) {
        clearTimeout(timeout);
        child.removeListener('message', receive);
        reject(error);
      }
    });
  });

  beforeEach(async () => {
    directory = await fs.mkdtemp('/tmp/tuya-ui-');
    persistPath = path.join(directory, 'persist');
    output = '';
    handler = jest.fn(async () => ({
      thermostats: [{ id: 'fixture-room', name: 'Fixture room', currentTemperature: 19.5 }],
      presence: { home: null }, holiday: { active: false },
    }));
    runtime = new ThermostatRuntimeServer(persistPath, '0123456789abcdef', handler);
    await runtime.start();
    descriptorPath = path.join(persistPath, 'TuyaRuntime.0123456789abcdef.json');
    descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
    child = fork(path.resolve(__dirname, '../homebridge-ui/server.js'), [], {
      execPath: process.execPath,
      execArgv: [],
      env: {
        ...process.env,
        HOMEBRIDGE_STORAGE_PATH: directory,
        HOMEBRIDGE_CONFIG_PATH: path.join(directory, 'config.json'),
        HOMEBRIDGE_UI_VERSION: '4.73.0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout!.on('data', data => { output += data.toString(); });
    child.stderr!.on('data', data => { output += data.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`The UI SDK did not start: ${output}`));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timeout);
        child.removeListener('message', ready);
        child.removeListener('exit', exited);
      };
      const ready = (message: unknown) => {
        if ((message as { action?: string }).action === 'ready') {
          cleanup();
          resolve();
        }
      };
      const exited = () => {
        cleanup();
        reject(new Error(`The UI SDK exited before ready: ${output}`));
      };
      child.on('message', ready);
      child.on('exit', exited);
    });
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await runtime?.close();
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('loads the real ESM SDK from the CommonJS wrapper and exposes only instance IDs', async () => {
    const response = await call('/instances');
    expect(response).toEqual({ success: true, data: { instances: [{ id: descriptor.instanceId }] } });
    expect(JSON.stringify(response)).not.toContain(descriptor.token);
    expect(JSON.stringify(response)).not.toContain(descriptor.socketPath);
    expect(handler).not.toHaveBeenCalled();
  });

  test('authenticates a local request, strips routing metadata and returns sanitized runtime data', async () => {
    const response = await call('/thermostats', { instanceId: descriptor.instanceId });
    expect(response).toEqual({
      success: true,
      data: {
        thermostats: [{ id: 'fixture-room', name: 'Fixture room', currentTemperature: 19.5 }],
        presence: { home: null }, holiday: { active: false },
      },
    });
    expect(handler).toHaveBeenCalledWith('/thermostats', {});
    expect(JSON.stringify(response)).not.toContain(descriptor.token);
    expect(output).not.toContain(descriptor.token);
  });

  test('rejects a descriptor pointing at a socket outside its expected runtime path', async () => {
    await fs.writeFile(descriptorPath, JSON.stringify({ ...descriptor, socketPath: path.join(directory, 'unrelated.sock') }));
    expect(await call('/instances')).toEqual({ success: true, data: { instances: [] } });
    const response = await call('/thermostats', { instanceId: descriptor.instanceId });
    expect(response).toMatchObject({ success: false, data: { message: expect.stringContaining('No heating runtime') } });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(descriptor.token);
  });

  test('rejects descriptors with noncanonical secrets', async () => {
    await fs.writeFile(descriptorPath, JSON.stringify({ ...descriptor, token: 'invalid-runtime-token' }));
    expect(await call('/instances')).toEqual({ success: true, data: { instances: [] } });
    expect(handler).not.toHaveBeenCalled();
  });

  test('ignores a group-readable discovery file on Unix', async () => {
    if (process.platform === 'win32') {
      return;
    }
    await fs.chmod(descriptorPath, 0o640);
    expect(await call('/instances')).toEqual({ success: true, data: { instances: [] } });
    expect(handler).not.toHaveBeenCalled();
  });

  test('does not forward arbitrary route names to the runtime', async () => {
    const response = await call('/arbitrary/command', { instanceId: descriptor.instanceId });
    expect(response).toMatchObject({ success: false, data: { message: 'Not Found' } });
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    ['/controls/settings', { awayDelayMinutes: 30 }],
    ['/rooms/save', { deviceId: 'fixture-room', name: 'Kitchen', timeZone: 'Europe/London', clockVerified: true }],
    ['/presence/hold', { until: 2000000000000 }],
    ['/holiday', { active: true, returnAt: 2000000000000, preheatMinutes: 60 }],
    ['/overrides/preview', { deviceId: 'fixture-room', temperature: 21, endsAt: 'next-period' }],
    ['/overrides/start', { previewId: 'fixture-preview', acceptHostDependentExpiry: true }],
    ['/overrides/cancel', { deviceId: 'fixture-room' }],
    ['/temperatures/history', { deviceId: 'fixture-room', hours: 24 }],
    ['/profiles/history', { deviceId: 'fixture-room' }],
    ['/profiles/restore', { deviceId: 'fixture-room', versionId: 'fixture-version', profile: 'holiday' }],
    ['/controls/recover', { confirm: true }],
  ])('relays the explicit heating control route %s without routing metadata', async (requestPath, payload) => {
    const response = await call(requestPath as string, { ...payload as Record<string, unknown>, instanceId: descriptor.instanceId });
    expect(response.success).toBe(true);
    expect(handler).toHaveBeenCalledWith(requestPath, payload);
    expect(output).not.toContain(descriptor.token);
  });

  test('requires an explicit instance when several descriptors exist', async () => {
    const secondId = 'fedcba9876543210';
    const secondPath = path.join(persistPath, `TuyaRuntime.${secondId}.json`);
    await fs.writeFile(secondPath, JSON.stringify({
      ...descriptor,
      instanceId: secondId,
      socketPath: process.platform === 'win32'
        ? `\\\\.\\pipe\\homebridge-tuya-${secondId}`
        : path.join(persistPath, `tuya-${secondId}.sock`),
    }), { mode: 0o600 });
    const response = await call('/thermostats');
    expect(response).toMatchObject({ success: false, data: { message: 'Choose the Tuya instance to manage.' } });
    expect(handler).not.toHaveBeenCalled();
    expect((await call('/thermostats', { instanceId: descriptor.instanceId })).success).toBe(true);
    expect(handler).toHaveBeenCalledWith('/thermostats', {});
  });
});
