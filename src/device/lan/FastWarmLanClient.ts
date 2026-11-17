import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';
import { isIP, Socket } from 'net';
import { decodeFastWarmSchedule, FASTWARM_SCHEDULE_DAYS } from '../schedule/FastWarmSchedule';

export interface FastWarmLanReport {
  dps: Record<string, unknown>;
  receivedAt: number;
  generation?: number;
}

export interface FastWarmLanConnectionEvent {
  connected: boolean;
  generation: number;
}

export interface FastWarmLanRequestOptions {
  shouldProceed?: () => boolean;
  timeoutMs?: number;
}

export interface FastWarmLanClientOptions {
  deviceId: string;
  address: string;
  localKey: string;
  port?: number;
  timeoutMs?: number;
}

export type FastWarmLanErrorCode = 'invalid-configuration' | 'invalid-command' | 'cancelled' | 'unavailable' | 'timeout' | 'protocol';

/** Deliberately contains no raw socket error, key, device identifier, address or frame. */
export class FastWarmLanError extends Error {
  constructor(public readonly code: FastWarmLanErrorCode, public readonly writeAttempted = false) {
    super('FastWarm LAN request failed.');
    this.name = 'FastWarmLanError';
  }
}

const PREFIX = 0x6699, SUFFIX = 0x9966, HEADER_BYTES = 18, MIN_BODY_BYTES = 28, MAX_BODY_BYTES = 65536;
const VERSION_HEADER = Buffer.concat([Buffer.from('3.5'), Buffer.alloc(12)]);
const STATUS_KEYS = ['101', '102', '103', '105', '107', '110'];

function timeout(value: number | undefined, fallback: number): number {
  const milliseconds = value ?? fallback;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 60000) {
    throw new FastWarmLanError('invalid-configuration');
  }
  return milliseconds;
}

function permitted(callback: (() => boolean) | undefined): boolean {
  try {
    return callback?.() !== false;
  } catch {
    return false;
  }
}

export function isFastWarmLanCommand(properties: Record<string, unknown>): boolean {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return false;
  }
  const keys = Object.keys(properties);
  if (keys.length === 0 || keys.length > 4) {
    return false;
  }
  if (keys.includes('122')) {
    return keys.length === 1 && properties['122'] === true;
  }
  if (keys.includes('119')) {
    try {
      if (keys.length !== 1 || typeof properties['119'] !== 'string') {
        return false;
      }
      const packet = decodeFastWarmSchedule(properties['119']);
      return packet.events.length === 1 && FASTWARM_SCHEDULE_DAYS.some(day => day === packet.dayMask);
    } catch {
      return false;
    }
  }
  return keys.every(key => {
    const value = properties[key];
    if (key === '101' || key === '108') {
      return typeof value === 'boolean';
    }
    if (key === '103') {
      return value === 'smart' || value === 'hold' || value === 'holiday';
    }
    return key === '102' && typeof value === 'number' && Number.isSafeInteger(value)
      && value >= 50 && value <= 400 && value % 5 === 0;
  });
}

/**
 * Restricted protocol-3.5 transport. Wire layout/session derivation follow TinyTuya 1.19.0;
 * framing, nonce generation and transport ownership are implemented here with Node primitives.
 * No command is retried, no failed write reconnects, and no cloud client is imported.
 */
export default class FastWarmLanClient extends EventEmitter {
  private readonly key: Buffer;
  private readonly address: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private socket?: Socket;
  private connected = false;
  private connecting?: Promise<void>;
  private generationValue = 0;
  private sequence = 1;
  private sessionKey?: Buffer;
  private localNonce?: Buffer;
  private buffer: Buffer = Buffer.alloc(0);
  private ivStart = 0n;
  private ivCount = 0;
  private connectReject?: (error: FastWarmLanError) => void;
  private challenge?: {resolve: (payload: Buffer) => void; reject: (error: FastWarmLanError) => void};
  private query?: {resolve: (report: FastWarmLanReport) => void; reject: (error: FastWarmLanError) => void};
  private pendingWrites = new Set<(code: FastWarmLanErrorCode) => void>();
  private queue: Promise<void> = Promise.resolve();
  private heartbeatInterval?: NodeJS.Timeout;
  private heartbeatDeadline?: NodeJS.Timeout;

  constructor(options: FastWarmLanClientOptions) {
    super();
    if (typeof options.deviceId !== 'string' || options.deviceId.length === 0 || options.deviceId.length > 128
      || typeof options.address !== 'string' || isIP(options.address) === 0
      || typeof options.localKey !== 'string' || Buffer.byteLength(options.localKey, 'utf8') !== 16) {
      throw new FastWarmLanError('invalid-configuration');
    }
    this.port = options.port ?? 6668;
    if (!Number.isSafeInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new FastWarmLanError('invalid-configuration');
    }
    this.timeoutMs = timeout(options.timeoutMs, 5000);
    this.key = Buffer.from(options.localKey, 'utf8');
    this.address = options.address;
  }

  get generation(): number {
    return this.generationValue;
  }

  isConnected(): boolean {
    return this.connected && this.socket !== undefined && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    const operation = this.open();
    this.connecting = operation;
    try {
      await operation;
    } finally {
      if (this.connecting === operation) {
        this.connecting = undefined;
      }
    }
  }

  queryStatus(options: FastWarmLanRequestOptions = {}): Promise<FastWarmLanReport> {
    const generation = this.generationValue;
    return this.enqueue(async () => {
      this.requireConnected(generation, options.shouldProceed);
      const milliseconds = timeout(options.timeoutMs, this.timeoutMs);
      let deadline: NodeJS.Timeout | undefined;
      const response = new Promise<FastWarmLanReport>((resolve, reject) => {
        this.query = {resolve, reject};
        deadline = setTimeout(() => this.terminate('timeout'), milliseconds);
      });
      try {
        const [, report] = await Promise.all([
          this.writeFrame(16, Buffer.from('{}'), milliseconds, false, options.shouldProceed),
          response,
        ]);
        return report;
      } finally {
        clearTimeout(deadline);
        this.query = undefined;
      }
    });
  }

  issueOnce(properties: Record<string, unknown>, options: FastWarmLanRequestOptions = {}): Promise<{sentAt: number}> {
    // Snapshot before entering a queue, so callers cannot alter a pending command.
    const values = properties && typeof properties === 'object' ? {...properties} : properties;
    if (!isFastWarmLanCommand(values)) {
      return Promise.reject(new FastWarmLanError('invalid-command'));
    }
    const generation = this.generationValue;
    return this.enqueue(async () => {
      this.requireConnected(generation, options.shouldProceed);
      const milliseconds = timeout(options.timeoutMs, this.timeoutMs);
      const payload = Buffer.concat([VERSION_HEADER, Buffer.from(JSON.stringify({
        protocol: 5, t: Math.floor(Date.now() / 1000), data: {dps: values},
      }))]);
      const sentAt = Date.now();
      await this.writeFrame(13, payload, milliseconds, true, options.shouldProceed);
      return {sentAt}; // A dispatch receipt only; the owner must verify the resulting device state.
    });
  }

  close(): void {
    this.terminate('unavailable');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireConnected(generation: number, shouldProceed?: () => boolean): void {
    if (!permitted(shouldProceed)) {
      throw new FastWarmLanError('cancelled');
    }
    if (!this.isConnected() || generation !== this.generationValue) {
      throw new FastWarmLanError('unavailable');
    }
  }

  private async open(): Promise<void> {
    const socket = new Socket();
    this.socket = socket;
    const generation = ++this.generationValue;
    this.buffer = Buffer.alloc(0);
    this.sequence = 1;
    this.localNonce = randomBytes(16);
    this.ivStart = BigInt('0x' + randomBytes(12).toString('hex'));
    this.ivCount = 0;
    const current = () => this.socket === socket && this.generationValue === generation;
    socket.setNoDelay(true);
    socket.on('data', data => {
      if (current()) {
        this.receive(data);
      }
    });
    socket.on('error', () => {
      if (current()) {
        this.terminate('unavailable');
      }
    });
    socket.on('close', () => {
      if (current()) {
        this.terminate('unavailable');
      }
    });
    const deadline = setTimeout(() => {
      if (current()) {
        this.terminate('timeout');
      }
    }, this.timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        this.connectReject = reject;
        socket.once('connect', () => {
          if (current()) {
            this.connectReject = undefined;
            resolve();
          }
        });
        socket.connect(this.port, this.address);
      });
      const challenge = new Promise<Buffer>((resolve, reject) => {
        this.challenge = {resolve, reject};
      });
      const [, answer] = await Promise.all([
        this.writeFrame(3, this.localNonce, this.timeoutMs, false), challenge,
      ]);
      if (answer.length !== 48) {
        throw new FastWarmLanError('protocol');
      }
      const remoteNonce = answer.subarray(0, 16);
      const hmac = createHmac('sha256', this.key).update(this.localNonce).digest();
      if (!timingSafeEqual(hmac, answer.subarray(16))) {
        throw new FastWarmLanError('protocol');
      }
      const finish = this.encode(5, createHmac('sha256', this.key).update(remoteNonce).digest());
      const xored = Buffer.alloc(16);
      for (let index = 0; index < 16; index++) {
        xored[index] = this.localNonce[index] ^ remoteNonce[index];
      }
      const derive = createCipheriv('aes-128-gcm', this.key, this.localNonce.subarray(0, 12));
      this.sessionKey = Buffer.concat([derive.update(xored), derive.final()]);
      xored.fill(0);
      await this.writeBytes(finish, this.timeoutMs, false);
      if (!current()) {
        throw new FastWarmLanError('unavailable');
      }
      this.connected = true;
      this.heartbeatInterval = setInterval(() => this.heartbeat(), 10000);
      this.heartbeatInterval.unref();
      this.emit('connection', {connected: true, generation: this.generationValue} satisfies FastWarmLanConnectionEvent);
    } catch (error) {
      const code = error instanceof FastWarmLanError ? error.code : 'unavailable';
      if (current()) {
        this.terminate(code);
      }
      throw new FastWarmLanError(code);
    } finally {
      clearTimeout(deadline);
      this.connectReject = undefined;
      this.challenge = undefined;
    }
  }

  private encode(command: number, payload: Buffer): Buffer {
    if (payload.length + MIN_BODY_BYTES > MAX_BODY_BYTES || this.sequence > 0xffffffff) {
      throw new FastWarmLanError('protocol');
    }
    let iv: Buffer;
    do {
      if (this.ivCount > 0xffffffff) {
        throw new FastWarmLanError('protocol');
      }
      // A random 96-bit starting point plus a bounded counter gives unique nonces without an ever-growing Set.
      const value = (this.ivStart + BigInt(this.ivCount++)) % (1n << 96n);
      iv = Buffer.from(value.toString(16).padStart(24, '0'), 'hex');
    } while (this.localNonce?.subarray(0, 12).equals(iv));
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(PREFIX, 0);
    header.writeUInt32BE(this.sequence++, 6);
    header.writeUInt32BE(command, 10);
    header.writeUInt32BE(payload.length + MIN_BODY_BYTES, 14);
    const cipher = createCipheriv('aes-128-gcm', this.sessionKey ?? this.key, iv);
    cipher.setAAD(header.subarray(4));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE(SUFFIX);
    return Buffer.concat([header, iv, ciphertext, cipher.getAuthTag(), suffix]);
  }

  private writeFrame(command: number, payload: Buffer, milliseconds: number, mutation: boolean,
    shouldProceed?: () => boolean): Promise<void> {
    const frame = this.encode(command, payload);
    return this.writeBytes(frame, milliseconds, mutation, shouldProceed);
  }

  private writeBytes(frame: Buffer, milliseconds: number, mutation: boolean, shouldProceed?: () => boolean): Promise<void> {
    if (!permitted(shouldProceed)) {
      return Promise.reject(new FastWarmLanError('cancelled'));
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new FastWarmLanError('unavailable'));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false, attempted = false;
      const finish = (code?: FastWarmLanErrorCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        this.pendingWrites.delete(cancel);
        if (code) {
          reject(new FastWarmLanError(code, mutation && attempted));
        } else {
          resolve();
        }
      };
      const cancel = (code: FastWarmLanErrorCode) => finish(code);
      const deadline = setTimeout(() => this.terminate('timeout'), milliseconds);
      this.pendingWrites.add(cancel);
      try {
        // No await/reconnect/retry exists between the final cancellation check and this one write.
        if (!permitted(shouldProceed)) {
          finish('cancelled');
          return;
        }
        attempted = true;
        socket.write(frame, error => {
          if (error) {
            this.terminate('unavailable');
          } else {
            finish();
          }
        });
      } catch {
        this.terminate('unavailable');
      }
    });
  }

  private receive(chunk: Buffer): void {
    try {
      if (this.buffer.length + chunk.length > (MAX_BODY_BYTES + HEADER_BYTES + 4) * 2) {
        throw new FastWarmLanError('protocol');
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= HEADER_BYTES) {
        if (this.buffer.readUInt32BE(0) !== PREFIX || this.buffer.readUInt16BE(4) !== 0) {
          throw new FastWarmLanError('protocol');
        }
        const length = this.buffer.readUInt32BE(14);
        if (length < MIN_BODY_BYTES || length > MAX_BODY_BYTES) {
          throw new FastWarmLanError('protocol');
        }
        const total = HEADER_BYTES + length + 4;
        if (this.buffer.length < total) {
          return;
        }
        const frame = this.buffer.subarray(0, total);
        this.buffer = this.buffer.subarray(total);
        this.decode(frame);
        if (!this.socket) {
          return;
        }
      }
    } catch {
      this.terminate('protocol');
    }
  }

  private decode(frame: Buffer): void {
    if (frame.readUInt32BE(frame.length - 4) !== SUFFIX) {
      throw new FastWarmLanError('protocol');
    }
    const command = frame.readUInt32BE(10);
    const decipher = createDecipheriv('aes-128-gcm', this.sessionKey ?? this.key, frame.subarray(18, 30));
    decipher.setAAD(frame.subarray(4, 18));
    decipher.setAuthTag(frame.subarray(frame.length - 20, frame.length - 4));
    let payload = Buffer.concat([decipher.update(frame.subarray(30, frame.length - 20)), decipher.final()]);
    // Device replies normally prefix a uint32 return code. A few firmwares omit it on the binary challenge.
    if (!(command === 4 && payload.length === 48) && payload.length >= 4 && payload.readUInt32BE(0) <= 255) {
      if (payload.readUInt32BE(0) !== 0) {
        throw new FastWarmLanError('protocol');
      }
      payload = payload.subarray(4);
    }
    if (command === 4) {
      if (!this.challenge || payload.length !== 48) {
        throw new FastWarmLanError('protocol');
      }
      const challenge = this.challenge;
      this.challenge = undefined;
      challenge.resolve(Buffer.from(payload));
      return;
    }
    if (command === 9) {
      clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = undefined;
    }
    if (payload.length === 0) {
      return;
    }
    // The remaining header bytes carry device metadata on unsolicited reports; they are not required to be zero.
    if (payload.subarray(0, 3).equals(VERSION_HEADER.subarray(0, 3))) {
      if (payload.length < VERSION_HEADER.length) {
        throw new FastWarmLanError('protocol');
      }
      payload = payload.subarray(VERSION_HEADER.length);
    }
    const message = JSON.parse(payload.toString('utf8')) as {dps?: unknown; data?: {dps?: unknown}};
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new FastWarmLanError('protocol');
    }
    const values = message.dps ?? message.data?.dps;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return;
    }
    const entries = Object.entries(values);
    if (entries.length > 256 || entries.some(([key]) => !/^\d{1,3}$/.test(key))) {
      throw new FastWarmLanError('protocol');
    }
    const report: FastWarmLanReport = {dps: Object.fromEntries(entries), receivedAt: Date.now(), generation: this.generationValue};
    if (!this.connected) {
      return;
    }
    this.emit('report', report);
    if (this.query && STATUS_KEYS.every(key => Object.prototype.hasOwnProperty.call(report.dps, key))) {
      if (typeof report.dps['101'] !== 'boolean' || typeof report.dps['107'] !== 'boolean'
        || !['smart', 'hold', 'holiday'].includes(String(report.dps['103']))
        || !['102', '105', '110'].every(key => typeof report.dps[key] === 'number' && Number.isSafeInteger(report.dps[key]))) {
        throw new FastWarmLanError('protocol');
      }
      const query = this.query;
      this.query = undefined;
      query.resolve(report);
    }
  }

  private heartbeat(): void {
    if (!this.isConnected() || this.heartbeatDeadline) {
      return;
    }
    this.heartbeatDeadline = setTimeout(() => this.terminate('timeout'), this.timeoutMs);
    this.heartbeatDeadline.unref();
    void this.writeFrame(9, Buffer.alloc(0), this.timeoutMs, false).catch(() => this.terminate('unavailable'));
  }

  private terminate(code: FastWarmLanErrorCode): void {
    const existed = this.socket !== undefined || this.connected;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    clearInterval(this.heartbeatInterval);
    clearTimeout(this.heartbeatDeadline);
    this.heartbeatInterval = undefined;
    this.heartbeatDeadline = undefined;
    this.connectReject?.(new FastWarmLanError(code));
    this.connectReject = undefined;
    this.challenge?.reject(new FastWarmLanError(code));
    this.challenge = undefined;
    this.query?.reject(new FastWarmLanError(code));
    this.query = undefined;
    for (const cancel of Array.from(this.pendingWrites)) {
      cancel(code);
    }
    socket?.destroy();
    this.sessionKey?.fill(0);
    this.sessionKey = undefined;
    this.localNonce?.fill(0);
    this.localNonce = undefined;
    this.buffer = Buffer.alloc(0);
    this.ivStart = 0n;
    this.ivCount = 0;
    if (existed) {
      this.generationValue++;
      this.emit('connection', {connected: false, generation: this.generationValue} satisfies FastWarmLanConnectionEvent);
    }
  }
}

export { FastWarmLanClient };
