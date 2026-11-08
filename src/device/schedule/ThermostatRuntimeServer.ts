import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PLUGIN_NAME } from '../../settings';

export interface ThermostatRuntimeDescriptor {
  version: 1;
  instanceId: string;
  plugin: string;
  socketPath: string;
  token: string;
  pid: number;
}

export type ThermostatRuntimeHandler = (route: string, body: Record<string, unknown>) => Promise<unknown>;

/** Private IPC for Homebridge's temporary UI server; it does not listen on the LAN. */
export default class ThermostatRuntimeServer {
  private server?: Server;
  private descriptor?: ThermostatRuntimeDescriptor;
  private descriptorPath?: string;

  constructor(private persistPath: string, private instanceId: string, private handler: ThermostatRuntimeHandler) {
    if (!/^[a-f0-9]{16}$/.test(instanceId)) {
      throw new Error('Invalid thermostat runtime instance ID.');
    }
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    await fs.mkdir(this.persistPath, { recursive: true });
    const descriptorPath = path.join(this.persistPath, `TuyaRuntime.${this.instanceId}.json`);
    try {
      const previous = JSON.parse(await fs.readFile(descriptorPath, 'utf8')) as ThermostatRuntimeDescriptor;
      if (Number.isInteger(previous.pid) && previous.pid > 0) {
        try {
          process.kill(previous.pid, 0);
          throw new Error('A thermostat runtime with the same configuration is already running.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\homebridge-tuya-${this.instanceId}`
      : path.join(this.persistPath, `tuya-${this.instanceId}.sock`);
    // Keep the path supplied by the runtime local to its own persist directory.
    if (process.platform !== 'win32') {
      await fs.rm(socketPath, { force: true });
    }
    const descriptor: ThermostatRuntimeDescriptor = {
      version: 1, instanceId: this.instanceId, plugin: PLUGIN_NAME,
      socketPath, token: randomBytes(32).toString('hex'), pid: process.pid,
    };
    const server = createServer((request, response) => {
      void this.onRequest(request, response, descriptor.token);
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject); resolve();
      });
    });
    this.server = server;
    this.descriptor = descriptor;
    this.descriptorPath = descriptorPath;
    try {
      if (process.platform !== 'win32') {
        await fs.chmod(socketPath, 0o600);
      }
      const temporary = `${descriptorPath}.${randomBytes(8).toString('hex')}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, descriptorPath);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (this.descriptorPath && this.descriptor) {
      try {
        const current = JSON.parse(await fs.readFile(this.descriptorPath, 'utf8')) as ThermostatRuntimeDescriptor;
        if (current.token === this.descriptor.token) {
          await fs.rm(this.descriptorPath, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (process.platform !== 'win32') {
        await fs.rm(this.descriptor.socketPath, { force: true });
      }
    }
    this.descriptor = undefined;
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    const authorization = request.headers.authorization ?? '';
    const expected = Buffer.from(`Bearer ${token}`);
    const received = Buffer.from(authorization);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      request.resume();
      reply(403, { error: 'Thermostat runtime access denied.' });
      return;
    }
    if (request.method !== 'POST' || !request.url || !/^\/[a-z/]+$/.test(request.url)) {
      request.resume();
      reply(405, { error: 'Use a supported thermostat operation.' });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256 * 1024) {
          reply(413, { error: 'Thermostat request is too large.' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Thermostat request must be an object.');
      }
      reply(200, await this.handler(request.url, body));
    } catch (error) {
      if (!response.headersSent) {
        reply(400, { error: error instanceof Error ? error.message : 'Thermostat operation failed.' });
      }
    }
  }
}
