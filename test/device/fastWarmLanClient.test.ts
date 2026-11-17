import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { AddressInfo, createServer, Server, Socket } from 'net';
import FastWarmLanClient, { FastWarmLanError, FastWarmLanReport } from '../../src/device/lan/FastWarmLanClient';
import { collectFastWarmSchedule, decodeFastWarmSchedule } from '../../src/device/schedule/FastWarmSchedule';

// Public dummy fixtures only. The peer implements the device side independently of the client.
const KEY = Buffer.from('0123456789abcdef');
const STATUS = {'101': true, '102': 180, '103': 'smart', '105': 185, '107': false, '110': 0};
const HEADER = Buffer.concat([Buffer.from('3.5'), Buffer.alloc(12)]);
// Real 3.5 push-header shape, using public counter fixtures rather than an all-zero reserved field.
const PUSH_HEADER = Buffer.from('332e350000000000012c7500000001', 'hex');
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function frame(key: Buffer, command: number, body: Buffer, iv = randomBytes(12)): Buffer {
  const plain = Buffer.concat([Buffer.alloc(4), body]); // Replies contain a zero return code.
  const header = Buffer.alloc(18);
  header.writeUInt32BE(0x6699, 0);
  header.writeUInt32BE(876, 6); // Deliberately does not echo the request sequence number.
  header.writeUInt32BE(command, 10);
  header.writeUInt32BE(12 + plain.length + 16, 14); // Suffix is outside the declared body length.
  const cipher = createCipheriv('aes-128-gcm', key, iv);
  cipher.setAAD(header.subarray(4));
  return Buffer.concat([header, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag(), Buffer.from('00009966', 'hex')]);
}

interface PeerOptions {
  fragment?: boolean;
  silentQuery?: boolean;
  corruptStatus?: boolean;
  badChallenge?: boolean;
  oversizedHeader?: boolean;
  embedSuffix?: boolean;
  statusHeader?: Buffer;
  scheduleReports?: boolean;
}

class Peer {
  readonly server: Server;
  readonly sockets = new Set<Socket>();
  readonly commands: {command: number; iv: string; dps?: Record<string, unknown>}[] = [];
  readonly nonces: string[] = [];
  readonly errors: Error[] = [];
  connections = 0;
  port = 0;

  constructor(private readonly options: PeerOptions = {}) {
    this.server = createServer(socket => this.accept(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.connections++;
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0), key = KEY, localNonce: Buffer;
    let remoteNonce = Buffer.from('fedcba9876543210');
    const challengeIv = Buffer.from('101112131415161718191a1b', 'hex');
    if (this.options.embedSuffix) {
      const cipher = createCipheriv('aes-128-gcm', KEY, challengeIv);
      const keystream = cipher.update(Buffer.alloc(52));
      for (let index = 0; index < 4; index++) {
        remoteNonce[index] = keystream[index + 4] ^ Buffer.from('00009966', 'hex')[index];
      }
    }
    const send = async (bytes: Buffer) => {
      if (this.options.fragment) {
        for (const part of [bytes.subarray(0, 3), bytes.subarray(3, 15), bytes.subarray(15)]) {
          socket.write(part);
          await delay(3);
        }
      } else {
        socket.write(bytes);
      }
    };
    const handle = async (bytes: Buffer) => {
      const command = bytes.readUInt32BE(10), iv = bytes.subarray(18, 30);
      expect(bytes.readUInt32BE(0)).toBe(0x6699);
      expect(bytes.readUInt32BE(bytes.length - 4)).toBe(0x9966);
      const decipher = createDecipheriv('aes-128-gcm', key, iv);
      decipher.setAAD(bytes.subarray(4, 18));
      decipher.setAuthTag(bytes.subarray(bytes.length - 20, bytes.length - 4));
      let payload = Buffer.concat([decipher.update(bytes.subarray(30, bytes.length - 20)), decipher.final()]);
      const record: {command: number; iv: string; dps?: Record<string, unknown>} = {command, iv: iv.toString('hex')};
      this.commands.push(record);
      if (command === 3) {
        expect(payload).toHaveLength(16);
        localNonce = Buffer.from(payload);
        this.nonces.push(localNonce.toString('hex'));
        const hmac = createHmac('sha256', KEY).update(localNonce).digest();
        if (this.options.badChallenge) {
          hmac[0] ^= 1;
        }
        const reply = frame(KEY, 4, Buffer.concat([remoteNonce, hmac]), challengeIv);
        if (this.options.embedSuffix) {
          expect(reply.indexOf(Buffer.from('00009966', 'hex'))).toBeLessThan(reply.length - 4);
        }
        await send(reply);
      } else if (command === 5) {
        expect(payload).toEqual(createHmac('sha256', KEY).update(remoteNonce).digest());
        const mixed = Buffer.from(localNonce);
        for (let index = 0; index < 16; index++) {
          mixed[index] ^= remoteNonce[index];
        }
        const cipher = createCipheriv('aes-128-gcm', KEY, localNonce.subarray(0, 12));
        key = Buffer.concat([cipher.update(mixed), cipher.final()]);
      } else if (command === 16 && !this.options.silentQuery) {
        expect(JSON.parse(payload.toString())).toEqual({});
        if (this.options.oversizedHeader) {
          const header = Buffer.alloc(18);
          header.writeUInt32BE(0x6699);
          header.writeUInt32BE(65537, 14);
          socket.write(header);
          return;
        }
        const partial = frame(key, 8, Buffer.from(JSON.stringify({dps: {'119': 'QAEIHgC0'}})));
        const full = frame(key, 8, Buffer.concat([
          this.options.statusHeader ?? HEADER, Buffer.from(JSON.stringify({protocol: 4, data: {dps: STATUS}})),
        ]));
        if (this.options.corruptStatus) {
          full[full.length - 5] ^= 1;
        }
        await send(Buffer.concat([partial, full]));
      } else if (command === 13) {
        expect(payload.subarray(0, 15)).toEqual(HEADER);
        payload = payload.subarray(15);
        const json = JSON.parse(payload.toString());
        expect(Object.keys(json).sort()).toEqual(['data', 'protocol', 't']);
        expect(json.protocol).toBe(5);
        expect(Object.keys(json.data)).toEqual(['dps']);
        record.dps = json.data.dps;
        if (this.options.scheduleReports && record.dps?.['122'] === true) {
          const replies = [frame(key, 13, Buffer.alloc(0))];
          for (const day of [1, 2, 4, 8, 16, 32, 64]) {
            for (let event = 0; event < 4; event++) {
              const packet = Buffer.from([day, event, [5, 8, 17, 22][event], [30, 30, 0, 0][event], 0, event === 3 ? 120 : 180]);
              replies.push(frame(key, 8, Buffer.concat([
                PUSH_HEADER, Buffer.from(JSON.stringify({dps: {'119': packet.toString('base64')}})),
              ])));
            }
          }
          await send(Buffer.concat(replies));
        }
        // No control acknowledgement: issueOnce is a send receipt, never a claim of state confirmation.
      } else if (command === 9) {
        socket.write(frame(key, 9, Buffer.alloc(0)));
      }
    };
    let pipeline: Promise<void> = Promise.resolve();
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 18) {
        const total = 18 + buffer.readUInt32BE(14) + 4;
        if (buffer.length < total) {
          break;
        }
        const next = Buffer.from(buffer.subarray(0, total));
        buffer = buffer.subarray(total);
        pipeline = pipeline.then(() => handle(next)).catch(error => {
          this.errors.push(error);
          socket.destroy();
        });
      }
    });
  }
}

describe('FastWarm restricted LAN3.5 client', () => {
  const peers: Peer[] = [], clients: FastWarmLanClient[] = [];
  const create = async (options: PeerOptions = {}, milliseconds = 600) => {
    const peer = new Peer(options);
    peers.push(peer);
    await peer.start();
    const client = new FastWarmLanClient({
      deviceId: 'dummy-thermostat', address: '127.0.0.1', localKey: KEY.toString(), port: peer.port, timeoutMs: milliseconds,
    });
    clients.push(client);
    return {peer, client};
  };

  afterEach(async () => {
    clients.splice(0).forEach(client => client.close());
    for (const peer of peers.splice(0)) {
      await peer.stop();
      expect(peer.errors).toEqual([]);
    }
  });

  test('authenticates, accepts fragmented/coalesced frames and emits every valid report', async () => {
    const {peer, client} = await create({fragment: true, embedSuffix: true});
    const reports: FastWarmLanReport[] = [], connections: unknown[] = [];
    client.on('report', value => reports.push(value));
    client.on('connection', value => connections.push(value));
    await client.connect();
    expect(client.isConnected()).toBe(true);
    const result = await client.queryStatus();
    expect(result.dps).toEqual(STATUS);
    expect(result.receivedAt).toBeGreaterThan(0);
    expect(reports.map(report => report.dps)).toEqual([{'119': 'QAEIHgC0'}, STATUS]);
    expect(peer.commands.map(value => value.command)).toEqual([3, 5, 16]);
    const generation = client.generation;
    client.close();
    expect(client.generation).toBeGreaterThan(generation);
    expect(connections).toEqual([{connected: true, generation}, {connected: false, generation: client.generation}]);
  });

  test('sends each permitted control once with fresh IVs, without needing an acknowledgement', async () => {
    const {peer, client} = await create();
    await client.connect();
    await client.issueOnce({'122': true});
    await client.issueOnce({'119': 'QAEIHgC5'});
    await client.issueOnce({'102': 185});
    await delay(20);
    expect(peer.commands.filter(value => value.command === 13).map(value => value.dps))
      .toEqual([{'122': true}, {'119': 'QAEIHgC5'}, {'102': 185}]);
    expect(new Set(peer.commands.map(value => value.iv)).size).toBe(peer.commands.length);
    expect(peer.connections).toBe(1);
  });

  test('accepts authenticated nonzero 3.5 header metadata and all 28 programme push reports', async () => {
    const {peer, client} = await create({fragment: true, statusHeader: PUSH_HEADER, scheduleReports: true});
    await client.connect();
    expect((await client.queryStatus()).dps).toEqual(STATUS);
    const reports: FastWarmLanReport[] = [];
    let finish!: () => void;
    const complete = new Promise<void>(resolve => { finish = resolve; });
    client.on('report', report => {
      if ('119' in report.dps) {
        reports.push(report);
        if (reports.length === 28) {
          finish();
        }
      }
    });
    await client.issueOnce({'122': true});
    await Promise.race([complete, delay(1000).then(() => { throw new Error('Programme fixture reports timed out.'); })]);
    const programme = collectFastWarmSchedule(reports.map(report => ({
      packet: decodeFastWarmSchedule(report.dps['119'] as string), reportedAt: report.receivedAt,
    })));
    expect(programme.complete).toBe(true);
    expect(programme.missing).toEqual([]);
    expect(programme.days.every(day => day.events.map(event => event.temperature).join(',') === '18,18,18,12')).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(peer.commands.filter(value => value.command === 13).map(value => value.dps)).toEqual([{'122': true}]);
  });

  test.each([
    Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12)]),
    Buffer.from('3.5'),
    Buffer.concat([Buffer.from('3.5'), Buffer.alloc(11)]),
  ])('rejects unsupported or truncated authenticated protocol headers %j', async statusHeader => {
    const {client} = await create({statusHeader});
    await client.connect();
    await expect(client.queryStatus()).rejects.toMatchObject({code: 'protocol', message: 'FastWarm LAN request failed.'});
    expect(client.isConnected()).toBe(false);
  });

  test.each([
    {'115': true}, {'110': 1}, {'122': 1}, {'122': true, '102': 185}, {'102': 1040}, {'102': 181},
    {'102': NaN}, {'101': 1}, {'108': 'true'}, {'103': 1}, {'103': 'auto'},
    {'119': 'fwEIHgC5'}, {'119': 'QAABAAACAAADAAAEAAAEAAAEAAAE'}, {'119': 'QAEIHgC5\n'},
  ])('rejects an unsafe/unsupported command before dispatch %j', async properties => {
    const {peer, client} = await create();
    await client.connect();
    await expect(client.issueOnce(properties)).rejects.toMatchObject({code: 'invalid-command', writeAttempted: false});
    await delay(5);
    expect(peer.commands.filter(value => value.command === 13)).toHaveLength(0);
  });

  test('rechecks cancellation at dispatch and never connects implicitly', async () => {
    const {peer, client} = await create();
    await expect(client.issueOnce({'102': 185})).rejects.toMatchObject({code: 'unavailable', writeAttempted: false});
    expect(peer.connections).toBe(0);
    await client.connect();
    await expect(client.issueOnce({'102': 185}, {shouldProceed: () => false}))
      .rejects.toMatchObject({code: 'cancelled', writeAttempted: false});
    expect(peer.commands.filter(value => value.command === 13)).toHaveLength(0);
  });

  test('times out one query, closes its generation and does not replay queued controls', async () => {
    const {peer, client} = await create({silentQuery: true}, 100);
    await client.connect();
    const generation = client.generation;
    const query = client.queryStatus();
    const queued = client.issueOnce({'102': 185});
    await expect(query).rejects.toMatchObject({code: 'timeout'});
    await expect(queued).rejects.toMatchObject({code: 'unavailable', writeAttempted: false});
    await delay(30);
    expect(client.isConnected()).toBe(false);
    expect(client.generation).toBeGreaterThan(generation);
    expect(peer.connections).toBe(1);
    expect(peer.commands.map(value => value.command)).toEqual([3, 5, 16]);
  });

  test('an ambiguous socket-write timeout records attempted dispatch and never resends', async () => {
    const {peer, client} = await create({}, 100);
    await client.connect();
    const socket = (client as unknown as {socket: Socket}).socket;
    const write = socket.write.bind(socket);
    // Simulate a missing OS flush callback while a genuine encrypted frame reaches the peer.
    const spy = jest.spyOn(socket, 'write').mockImplementation(((bytes: Buffer) => write(bytes)) as typeof socket.write);
    await expect(client.issueOnce({'102': 185})).rejects.toMatchObject({code: 'timeout', writeAttempted: true});
    spy.mockRestore();
    await delay(30);
    expect(peer.commands.filter(value => value.command === 13)).toHaveLength(1);
    expect(peer.connections).toBe(1);
    expect(client.isConnected()).toBe(false);
  });

  test.each([{badChallenge: true}, {corruptStatus: true}, {oversizedHeader: true}])
    ('rejects authentication/framing failures without exposing keys, addresses or packet bytes %j', async options => {
      const {peer, client} = await create(options);
      let failure: unknown;
      try {
        await client.connect();
        await client.queryStatus();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(FastWarmLanError);
      expect(failure).toMatchObject({code: 'protocol', message: 'FastWarm LAN request failed.'});
      const text = String(failure) + JSON.stringify(failure);
      expect(text).not.toContain(KEY.toString());
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain('dummy-thermostat');
      expect(peer.commands.filter(value => value.command === 13)).toHaveLength(0);
      expect(client.isConnected()).toBe(false);
    });

  test('uses a different random session nonce on an explicit subsequent connection', async () => {
    const {peer, client} = await create();
    await client.connect();
    client.close();
    await client.connect();
    expect(peer.nonces).toHaveLength(2);
    expect(peer.nonces[0]).not.toEqual(peer.nonces[1]);
  });
});
