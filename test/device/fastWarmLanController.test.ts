import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import FastWarmLanController from '../../src/device/lan/FastWarmLanController';
import FastWarmLanClient, { FastWarmLanError, FastWarmLanReport, FastWarmLanRequestOptions } from '../../src/device/lan/FastWarmLanClient';
import { encodeFastWarmSchedule, FASTWARM_SCHEDULE_DAYS, FastWarmScheduleEventId } from '../../src/device/schedule/FastWarmSchedule';
import TuyaDevice from '../../src/device/TuyaDevice';

const ID = 'test-thermostat';
const STATUS = {'101': true, '102': 180, '103': 'smart', '105': 185, '107': false, '108': false, '110': 0};

function packets(): string[] {
  return FASTWARM_SCHEDULE_DAYS.flatMap(day => [
    {event: 0, hour: 5, minute: 30, temperature: 18},
    {event: 1, hour: 8, minute: 30, temperature: 18},
    {event: 2, hour: 17, minute: 0, temperature: 18},
    {event: 3, hour: 22, minute: 0, temperature: 12},
  ].map(event => encodeFastWarmSchedule({dayMask: day, events: [{...event, event: event.event as FastWarmScheduleEventId}]})));
}

class FakeClient extends EventEmitter {
  generation = 0;
  connected = false;
  attempts = 0;
  queries = 0;
  issues: {dps: Record<string, unknown>; at: number}[] = [];
  statuses: Record<string, unknown>[] = [];
  holdNextQuery = false;
  pendingQuery?: (error: Error) => void;
  onInquiry?: () => void;

  async connect(): Promise<void> {
    if (!this.connected) {
      this.attempts++;
      this.connected = true;
      this.generation++;
      this.emit('connection', {connected: true, generation: this.generation});
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async queryStatus(options: FastWarmLanRequestOptions = {}): Promise<FastWarmLanReport> {
    if (!this.connected || options.shouldProceed?.() === false) {
      throw new FastWarmLanError('unavailable');
    }
    this.queries++;
    if (this.holdNextQuery) {
      this.holdNextQuery = false;
      return new Promise((_resolve, reject) => { this.pendingQuery = reject; });
    }
    return this.push(this.statuses.shift() ?? {...STATUS});
  }

  async issueOnce(dps: Record<string, unknown>, options: FastWarmLanRequestOptions = {}): Promise<{sentAt: number}> {
    if (!this.connected || options.shouldProceed?.() === false) {
      throw new FastWarmLanError('cancelled');
    }
    this.issues.push({dps: {...dps}, at: Date.now()});
    if (dps['122'] === true) {
      this.onInquiry?.();
    }
    return {sentAt: Date.now()};
  }

  push(dps: Record<string, unknown>, receivedAt = Date.now(), generation = this.generation): FastWarmLanReport {
    const report = {dps, receivedAt, generation};
    this.emit('report', report);
    return report;
  }

  close(): void {
    this.pendingQuery?.(new FastWarmLanError('unavailable'));
    this.pendingQuery = undefined;
    if (this.connected) {
      this.connected = false;
      this.generation++;
      this.emit('connection', {connected: false, generation: this.generation});
    }
  }
}

describe('FastWarm LAN controller ownership and fresh full-week reads', () => {
  const controllers: FastWarmLanController[] = [];
  const create = async (options: {missingKey?: boolean; product?: string; enabled?: boolean} = {}) => {
    const client = new FakeClient();
    const factory = jest.fn(() => client as unknown as FastWarmLanClient);
    const controller = new FastWarmLanController([
      {deviceId: ID, address: '192.168.10.20', version: '3.5', enabled: options.enabled},
    ], new Map(options.missingKey ? [] : [[ID, '0123456789abcdef']]), {clientFactory: factory});
    controllers.push(controller);
    await controller.start([new TuyaDevice({id: ID, product_id: options.product ?? 'lmtejj3f4kafi2k1', status: []})]);
    return {controller, client, factory};
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T20:00:00Z'));
  });

  afterEach(() => {
    controllers.splice(0).forEach(controller => controller.close());
    jest.useRealTimers();
  });

  test('normalizes native reports without exposing transport credentials', async () => {
    const {controller, client} = await create();
    const listener = jest.fn();
    controller.addRawMessageListener(listener);
    const result = await controller.readProperties(ID, ['SetTemp', 'RoomTemper', 'ControlMode', 'TemperUnitChange']);
    expect(result.properties).toEqual([
      {code: 'SetTemp', dp_id: 102, value: 180}, {code: 'RoomTemper', dp_id: 105, value: 185},
      {code: 'ControlMode', dp_id: 103, value: 'smart'}, {code: 'TemperUnitChange', dp_id: 107, value: false},
    ]);
    expect(result.generation).toBe(client.generation);
    expect(controller.isConnected(ID)).toBe(true);
    expect(listener).toHaveBeenCalledWith('fastwarm/lan', 4, expect.objectContaining({devId: ID, source: 'lan'}), Date.now());
    expect(JSON.stringify(result) + JSON.stringify(listener.mock.calls)).not.toContain('0123456789abcdef');
  });

  test.each([{missingKey: true}, {product: 'other-model'}, {enabled: false}])
    ('does not connect an unenrolled, unkeyed or disabled device %j', async options => {
      const {controller, client, factory} = await create(options);
      expect(client.attempts).toBe(0);
      expect(controller.isConnected(ID)).toBe(false);
      await expect(controller.issueOnce(ID, {SetTemp: 185})).rejects.toBeInstanceOf(FastWarmLanError);
      expect(client.issues).toEqual([]);
      if (options.missingKey || options.enabled === false) {
        expect(factory).not.toHaveBeenCalled();
      }
    });

  test('requires an explicit read to reconnect and never queues an offline command for later delivery', async () => {
    const {controller, client} = await create();
    client.close();
    const attempts = client.attempts;
    await expect(controller.issueOnce(ID, {SetTemp: 185})).rejects.toMatchObject({code: 'unavailable', writeAttempted: false});
    expect(client.attempts).toBe(attempts);
    expect(client.issues).toEqual([]);
    await controller.readProperties(ID, ['RoomTemper']);
    expect(client.attempts).toBe(attempts + 1);
    expect(controller.isConnected(ID)).toBe(true);
    expect(client.issues).toEqual([]);
  });

  test('gets all28 periods from one inquiry and waits for write echoes to become quiet', async () => {
    const {controller, client} = await create();
    client.onInquiry = () => packets().forEach(raw => client.push({'119': raw}));
    const started = Date.now();
    const result = controller.readSchedule(ID);
    setTimeout(() => client.push({'119': 'QAEIHgC5'}), 300); // Previous write echo is not part of the new read.
    await jest.advanceTimersByTimeAsync(4000);
    const read = await result;
    expect(client.issues).toHaveLength(1);
    expect(client.issues[0]).toEqual({dps: {'122': true}, at: started + 1300});
    expect(read.state.complete).toBe(true);
    expect(read.state.missing).toEqual([]);
    expect(read.errors).toEqual([]);
    expect(read.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(read.finishedAt - client.issues[0].at).toBeGreaterThanOrEqual(2000);
    expect(read.state.days[6].events[1].temperature).toBe(18);
  });

  test.each(['missing', 'conflicting', 'malformed'])('never fingerprints a %s programme read', async condition => {
    const {controller, client} = await create();
    client.onInquiry = () => {
      const values = packets();
      (condition === 'missing' ? values.slice(0, -1) : values).forEach(raw => client.push({'119': raw}));
      if (condition === 'conflicting') {
        client.push({'119': 'QAEIHgC5'});
      }
      if (condition === 'malformed') {
        client.push({'119': 'invalid-base64'});
      }
    };
    const result = controller.readSchedule(ID, {timeoutMs: 5000});
    await jest.advanceTimersByTimeAsync(5500);
    const read = await result;
    expect(read.fingerprint).toBeNull();
    if (condition === 'missing') {
      expect(read.state.missing).toHaveLength(1);
      expect(read.timedOut).toBe(true);
    } else {
      expect(read.errors).toContain('Conflicting or malformed local programme reports.');
    }
    expect(client.issues.map(issue => issue.dps)).toEqual([{'122': true}]);
  });

  test('requires the whole settling window even if the finalperiod arrives just before the deadline', async () => {
    const {controller, client} = await create();
    client.onInquiry = () => setTimeout(() => packets().forEach(raw => client.push({'119': raw})), 1200);
    const result = controller.readSchedule(ID, {timeoutMs: 2500});
    await jest.advanceTimersByTimeAsync(3000);
    const read = await result;
    expect(read.state.complete).toBe(true);
    expect(read.fingerprint).toBeNull();
    expect(read.timedOut).toBe(true);
  });

  test('rejects a Celsius-unit change at the final read barrier', async () => {
    const {controller, client} = await create();
    client.statuses.push({...STATUS}, {...STATUS, '107': true});
    client.onInquiry = () => packets().forEach(raw => client.push({'119': raw}));
    const result = controller.readSchedule(ID);
    await jest.advanceTimersByTimeAsync(3500);
    const read = await result;
    expect(read.state.complete).toBe(true);
    expect(read.fingerprint).toBeNull();
    expect(read.errors.length).toBeGreaterThan(0);
    await expect(controller.issueOnce(ID, {SetTemp: 185})).rejects.toMatchObject({code: 'unavailable'});
    expect(client.issues.map(issue => issue.dps)).toEqual([{'122': true}]);
  });

  test('cancelled reads and writes issue no inquiry or mutation', async () => {
    const {controller, client} = await create();
    const queries = client.queries;
    await expect(controller.issueOnce(ID, {SetTemp: 185}, {shouldProceed: () => false})).rejects.toBeInstanceOf(FastWarmLanError);
    const read = await controller.readSchedule(ID, {shouldProceed: () => false});
    expect(read.fingerprint).toBeNull();
    expect(client.queries).toBe(queries);
    expect(client.issues).toEqual([]);
  });

  test('drops reports from old connections, old timestamps and invalid numeric datapoints', async () => {
    const {controller, client} = await create();
    const listener = jest.fn();
    controller.addRawMessageListener(listener);
    const generation = client.generation;
    client.push({...STATUS, '107': true}, Date.now(), generation - 1);
    client.push({...STATUS, '107': true}, Date.now() - 1, generation);
    expect(listener).not.toHaveBeenCalled();
    expect(controller.isConnected(ID)).toBe(true);
    client.push({...STATUS, '105': '185'});
    expect(controller.isConnected(ID)).toBe(false);
    expect(client.connected).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  test('cannot assemble a current snapshot from a prior connection generation', async () => {
    const {controller, client} = await create();
    client.onInquiry = () => packets().forEach(raw => client.push({'119': raw}, Date.now(), client.generation - 1));
    const result = controller.readSchedule(ID, {timeoutMs: 4000});
    await jest.advanceTimersByTimeAsync(4500);
    const read = await result;
    expect(read.state.complete).toBe(false);
    expect(read.state.missing).toHaveLength(28);
    expect(read.fingerprint).toBeNull();
  });

  test('a client epoch change cannot leave the previous cache writable', async () => {
    const {controller, client} = await create();
    client.generation++;
    expect(controller.isConnected(ID)).toBe(false);
    await expect(controller.issueOnce(ID, {SetTemp: 185})).rejects.toMatchObject({code: 'unavailable'});
    expect(client.issues).toEqual([]);
  });

  test('partial datapoints cannot indefinitely extend full-status availability', async () => {
    const {controller, client} = await create();
    jest.setSystemTime(Date.now() + 120001);
    client.push({'105': 190});
    expect(controller.isConnected(ID)).toBe(false);
    await expect(controller.issueOnce(ID, {SetTemp: 185})).rejects.toMatchObject({code: 'unavailable'});
    expect(client.issues).toEqual([]);
    await controller.readProperties(ID, ['RoomTemper']);
    expect(controller.isConnected(ID)).toBe(true);
  });

  test('close rejects queued commands and cancels a read-side connection wait', async () => {
    const {controller, client} = await create();
    client.holdNextQuery = true;
    const results = Promise.allSettled([
      controller.readProperties(ID, ['RoomTemper']), controller.issueOnce(ID, {SetTemp: 185}),
    ]);
    await jest.advanceTimersByTimeAsync(0);
    controller.close();
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(client.issues).toEqual([]);
  });

  test('close immediately ends the quiet-period wait without issuing an inquiry', async () => {
    const {controller, client} = await create();
    const result = controller.readSchedule(ID);
    const queued = controller.issueOnce(ID, {SetTemp: 185}).catch(error => error);
    await jest.advanceTimersByTimeAsync(200);
    controller.close();
    const read = await result;
    expect(read.fingerprint).toBeNull();
    expect(await queued).toBeInstanceOf(FastWarmLanError);
    expect(client.issues).toEqual([]);
  });

  test.each([
    {TimeHoliday: 1}, {RoomTemper: 190}, {SetTemp: 181}, {SetTemp: 1040}, {ControlMode: 1},
    {inquire: true, SetTemp: 185}, {week_program: 'QAEIHgC5', Lock: false}, {week_program: 'fwEIHgC5'},
  ])('rejects unsupported or mixed native controls before calling the client %j', async properties => {
    const {controller, client} = await create();
    await expect(controller.issueOnce(ID, properties as unknown as Record<string, string | number | boolean>))
      .rejects.toMatchObject({code: 'invalid-command', writeAttempted: false});
    expect(client.issues).toEqual([]);
  });
});
