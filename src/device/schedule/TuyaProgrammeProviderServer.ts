import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { constants, lstatSync, unlinkSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { writePrivateJson } from '../../util/PrivateFile';

interface Descriptor {
  version: 1; protocolVersion: 1; plugin: '@jdipper/homebridge-tuya';
  instanceId: string; socketPath: string; token: string; pid: number;
  capabilities?: {automaticFreshBaseline: true};
}
type Handler = (route: string, body: Record<string, unknown>) => Promise<unknown>;
const ROUTES = ['/provider/list', '/provider/refresh', '/provider/read', '/provider/prepare', '/provider/apply',
  '/provider/prepare-automatic', '/provider/apply-automatic', '/provider/discard'];

/** Owner-only local IPC. The provider never opens a LAN listener or exposes Tuya credentials. */
export default class TuyaProgrammeProviderServer {
  private server?: Server;
  private descriptor?: Descriptor;
  private descriptorPath?: string;
  private ownerToken?: string;
  private runtimePath = '';

  constructor(private persistPath: string, private instanceId: string, private handler: Handler,
    private automaticFreshBaseline = false) {
    if (!/^[a-f0-9]{16}$/.test(instanceId)) {
      throw new Error('Invalid programme provider instance ID.');
    }
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    if (process.platform === 'win32') {
      throw new Error('The shared programme provider requires a private Unix socket.');
    }
    await fs.mkdir(this.persistPath, { recursive: true });
    this.persistPath = await fs.realpath(this.persistPath);
    const directory = await fs.stat(this.persistPath);
    if (!directory.isDirectory() || directory.mode & 0o022 || (process.getuid && directory.uid !== process.getuid())) {
      throw new Error('The programme provider requires an owner-controlled persistence directory.');
    }
    this.runtimePath = path.join(path.dirname(this.persistPath), 'heating-runtime');
    try {
      await fs.mkdir(this.runtimePath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const runtime = await fs.lstat(this.runtimePath);
    if (!runtime.isDirectory() || runtime.isSymbolicLink() || runtime.mode & 0o077
      || (process.getuid && runtime.uid !== process.getuid())) {
      throw new Error('The programme provider requires a private runtime directory.');
    }
    await this.acquireOwner();
    try {
      await this.startOwned();
    } catch (error) {
      await this.releaseOwner();
      throw error;
    }
  }

  private async startOwned(): Promise<void> {
    const descriptorPath = path.join(this.persistPath, `TuyaProgrammeProvider.${this.instanceId}.json`);
    try {
      const file = await fs.open(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let previous: unknown;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.mode & 0o077 || info.size > 16_384 || (process.getuid && info.uid !== process.getuid())) {
          throw new Error('The previous programme provider descriptor is not private.');
        }
        previous = JSON.parse(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
      const pid = (previous as Partial<Descriptor>)?.pid;
      if (!Number.isInteger(pid) || !pid || pid <= 0) {
        throw new Error('The previous programme provider descriptor is invalid.');
      }
      try {
        process.kill(pid, 0);
        throw new Error('A programme provider with the same configuration is already running.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const socketPath = path.join(this.runtimePath, `tuya-programmes-${this.instanceId}.sock`);
    try {
      const socket = await fs.lstat(socketPath);
      if (!socket.isSocket() || socket.mode & 0o077 || (process.getuid && socket.uid !== process.getuid())) {
        throw new Error('The previous programme provider socket is not private.');
      }
      await fs.rm(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const descriptor: Descriptor = {
      version: 1, protocolVersion: 1, plugin: '@jdipper/homebridge-tuya', instanceId: this.instanceId,
      socketPath, token: randomBytes(32).toString('hex'), pid: process.pid,
      ...(this.automaticFreshBaseline ? {capabilities: {automaticFreshBaseline: true as const}} : {}),
    };
    const server = createServer((request, response) => {
      void this.onRequest(request, response, descriptor);
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
      await fs.chmod(socketPath, 0o600);
      await writePrivateJson(descriptorPath, descriptor);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private ownerPath() {
    return path.join(this.persistPath, `TuyaProgrammeProviderOwner.${this.instanceId}.json`);
  }

  private async readOwner() {
    const file = await fs.open(this.ownerPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.mode & 0o077 || info.size > 1024 || (process.getuid && info.uid !== process.getuid())) {
        throw new Error('The programme provider owner file is not private.');
      }
      const owner = JSON.parse(await file.readFile('utf8')) as { pid?: number; token?: string };
      if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid <= 0
        || typeof owner.token !== 'string' || !/^[a-f0-9]{64}$/.test(owner.token)) {
        throw new Error('The programme provider owner file needs review.');
      }
      return { pid: owner.pid, token: owner.token, ino: info.ino, mtimeMs: info.mtimeMs };
    } finally {
      await file.close();
    }
  }

  private async acquireOwner(): Promise<void> {
    const file = this.ownerPath();
    const token = randomBytes(32).toString('hex');
    const claim = async () => {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.ownerToken = token;
    };
    try {
      await claim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const previous = await this.readOwner();
      try {
        process.kill(previous.pid, 0);
        throw new Error('A programme provider with the same configuration is already running.');
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw failure;
        }
      }
      // Only retire the exact dead-process lock that was inspected; a contender's new lock wins.
      const current = lstatSync(file);
      if (current.ino !== previous.ino || current.mtimeMs !== previous.mtimeMs) {
        throw new Error('Programme provider ownership changed. Retry startup.');
      }
      unlinkSync(file);
      await claim();
    }
  }

  private async releaseOwner(): Promise<void> {
    if (!this.ownerToken) {
      return;
    }
    try {
      const owner = await this.readOwner();
      if (owner.token === this.ownerToken) {
        const current = lstatSync(this.ownerPath());
        if (current.ino === owner.ino && current.mtimeMs === owner.mtimeMs) {
          unlinkSync(this.ownerPath());
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    } finally {
      this.ownerToken = undefined;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    try {
      if (this.descriptorPath && this.descriptor) {
        try {
          const current = JSON.parse(await fs.readFile(this.descriptorPath, 'utf8')) as Descriptor;
          if (current.token === this.descriptor.token) {
            await fs.rm(this.descriptorPath, { force: true });
            await fs.rm(this.descriptor.socketPath, { force: true });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
    } finally {
      this.descriptor = undefined;
      await this.releaseOwner();
    }
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse, descriptor: Descriptor): Promise<void> {
    const reply = (status: number, body: object) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ protocolVersion: 1, instanceId: this.instanceId, ...body }));
    };
    const received = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${descriptor.token}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      request.resume(); reply(403, { error: 'Programme provider access denied.' }); return;
    }
    if (request.method !== 'POST' || !request.url || !ROUTES.includes(request.url)) {
      request.resume(); reply(405, { error: 'Use a supported programme provider operation.' }); return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 128 * 1024) {
          reply(413, { error: 'The programme request is too large.' }); return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('The programme request must be an object.');
      }
      const result = await this.handler(request.url, body);
      reply(200, result as object);
    } catch (error) {
      if (!response.headersSent) {
        reply(400, { error: error instanceof Error ? error.message : 'The programme operation failed.' });
      }
    }
  }
}
