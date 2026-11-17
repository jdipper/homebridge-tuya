import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import mqtt from 'mqtt';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaOpenMQ from '../src/core/TuyaOpenMQ';
import { initLogger } from '../src/util/Logger';

jest.mock('mqtt', () => ({ __esModule: true, default: { connect: jest.fn() } }));

const NOW = 1794025076403;
const configuration = () => ({ success: true as const, t: NOW, tid: 'test', result: {
  url: 'mqtt://example.invalid', client_id: 'test-client', username: 'test-user', password: 'test-password',
  expire_time: 7200, source_topic: { device: 'test-device' }, sink_topic: {},
} });
class Client extends EventEmitter {
  connected = false;
  subscribe = jest.fn();
  end = jest.fn(() => {this.connected = false;});
  connect() {this.connected = true; this.emit('connect');}
  loseConnection() {this.connected = false; this.emit('close');}
}

describe('MQTT connection recovery notifications', () => {
  let mq: TuyaOpenMQ;
  let clients: Client[];
  beforeEach(() => {
    jest.useFakeTimers(); jest.setSystemTime(NOW);
    initLogger({info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn()});
    clients = [];
    jest.mocked(mqtt.connect).mockImplementation(() => {
      const client = new Client(); clients.push(client); return client as unknown as mqtt.MqttClient;
    });
    mq = new TuyaOpenMQ({ forceIPv4: false } as TuyaOpenAPI);
    jest.spyOn(mq, '_getMQConfig').mockResolvedValue(configuration());
  });
  afterEach(() => {mq.stop(); jest.restoreAllMocks(); jest.useRealTimers();});

  test('initial connection is healthy without manufacturing a lost-state interval', async () => {
    const listener = jest.fn(); mq.addConnectionListener(listener);
    await mq._connect();
    expect(mq.isConnected()).toBe(false);
    clients[0].connect();
    expect(mq.isConnected()).toBe(true);
    expect(listener).toHaveBeenLastCalledWith({connected: true, recoveryRequired: false});
  });

  test('normal two-hour credential renewal does not request device recovery', async () => {
    const listener = jest.fn(); mq.addConnectionListener(listener);
    await mq._connect(); clients[0].connect();
    await jest.advanceTimersByTimeAsync(7140 * 1000);
    expect(clients).toHaveLength(2);
    clients[1].connect();
    expect(listener).toHaveBeenLastCalledWith({connected: true, recoveryRequired: false});
    expect(clients[0].end).toHaveBeenCalledTimes(1);
  });

  test('unexpected broker disconnection requires one recovery after the push stream returns', async () => {
    const listener = jest.fn(); mq.addConnectionListener(listener);
    await mq._connect(); clients[0].connect(); clients[0].loseConnection();
    expect(listener).toHaveBeenLastCalledWith({connected: false, recoveryRequired: false});
    clients[0].connect();
    expect(listener).toHaveBeenLastCalledWith({connected: true, recoveryRequired: true});
    clients[0].connect();
    expect(listener).toHaveBeenLastCalledWith({connected: true, recoveryRequired: false});
  });

  test('a planned credential rotation that actually loses the stream for over thirty seconds requires recovery', async () => {
    const listener = jest.fn(); mq.addConnectionListener(listener);
    await mq._connect(); clients[0].connect();
    let resolve: (value: ReturnType<typeof configuration>) => void = () => undefined;
    jest.spyOn(mq, '_getMQConfig').mockReturnValue(new Promise(done => {resolve = done;}));
    const rotating = mq._connect(true);
    jest.setSystemTime(NOW + 31_000); resolve(configuration()); await rotating;
    clients[1].connect();
    expect(listener).toHaveBeenLastCalledWith({connected: true, recoveryRequired: true});
  });

  test('removed listeners and delayed events from a retired client cannot corrupt recovery state', async () => {
    const listener = jest.fn(); mq.addConnectionListener(listener);
    await mq._connect(); clients[0].connect();
    mq.removeConnectionListener(listener);
    await mq._connect(true); clients[0].loseConnection(); clients[1].connect();
    expect(listener).toHaveBeenCalledTimes(1);
    const next = jest.fn(); mq.addConnectionListener(next); clients[1].connect();
    expect(next).toHaveBeenLastCalledWith({connected: true, recoveryRequired: false});
  });
});
