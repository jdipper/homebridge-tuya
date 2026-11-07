import fs from 'fs/promises';
import path from 'path';
import { request } from 'http';
import ThermostatRuntimeServer, { ThermostatRuntimeDescriptor } from '../../src/device/schedule/ThermostatRuntimeServer';

describe('Private thermostat runtime IPC', () => {
  let directory: string;
  let server: ThermostatRuntimeServer;
  let descriptor: ThermostatRuntimeDescriptor;
  let handler: jest.Mock;

  const call = (token: string, body = '{}', method = 'POST') => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const operation = request({
      socketPath: descriptor.socketPath, path: '/thermostats', method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(data) }));
      response.on('error', reject);
    });
    operation.on('error', reject);
    operation.end(body);
  });

  beforeEach(async () => {
    directory = await fs.mkdtemp('/tmp/tuya-ipc-');
    handler = jest.fn(async () => ({ thermostats: [{ id: 'room', currentTemperature: 19.5 }] }));
    server = new ThermostatRuntimeServer(directory, '0123456789abcdef', handler);
    await server.start();
    descriptor = JSON.parse(await fs.readFile(path.join(directory, 'TuyaRuntime.0123456789abcdef.json'), 'utf8'));
  });

  afterEach(async () => {
    await server?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('relays authenticated local requests without returning its runtime token', async () => {
    const result = await call(descriptor.token);
    expect(result).toEqual({ status: 200, body: { thermostats: [{ id: 'room', currentTemperature: 19.5 }] } });
    expect(handler).toHaveBeenCalledWith('/thermostats', {});
    expect(JSON.stringify(result)).not.toContain(descriptor.token);
  });

  test('rejects an unauthorized caller before running a handler', async () => {
    expect((await call('wrong-token')).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  test('rejects unsupported methods and malformed JSON', async () => {
    expect((await call(descriptor.token, '{}', 'GET')).status).toBe(405);
    expect((await call(descriptor.token, '{')).status).toBe(400);
    expect((await call(descriptor.token, '[]')).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  test('protects discovery and socket files with owner-only permissions', async () => {
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(directory, 'TuyaRuntime.0123456789abcdef.json'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(descriptor.socketPath)).mode & 0o777).toBe(0o600);
    }
  });

  test('does not replace another running runtime with the same configuration', async () => {
    const duplicate = new ThermostatRuntimeServer(directory, descriptor.instanceId, handler);
    await expect(duplicate.start()).rejects.toThrow('already running');
    await duplicate.close();
    expect((await call(descriptor.token)).status).toBe(200);
  });

  test('removes discovery when the runtime closes', async () => {
    await server.close();
    await expect(fs.stat(path.join(directory, 'TuyaRuntime.0123456789abcdef.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
