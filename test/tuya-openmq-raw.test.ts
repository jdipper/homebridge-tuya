import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaOpenMQ from '../src/core/TuyaOpenMQ';
import { initLogger } from '../src/util/Logger';

describe('Original MQTT report listeners', () => {
  let mq: TuyaOpenMQ;
  beforeEach(() => {
    initLogger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
    mq = new TuyaOpenMQ({ forceIPv4: false } as TuyaOpenAPI);
    mq.config = { password: 'test' } as never;
  });

  const emit = async (value: string, timestamp: number) => {
    jest.spyOn(mq, '_decodeMQMessage').mockReturnValue(JSON.stringify({
      devId: 'thermostat', status: [{ code: 'week_program', value, t: timestamp }],
    }));
    await mq._onMessage('topic', Buffer.from(JSON.stringify({ protocol: 4, data: '', t: timestamp })));
  };

  test('delivers an original chunk before correcting its scalar value for existing listeners', async () => {
    const raw = jest.fn();
    const regular = jest.fn();
    mq.addRawMessageListener(raw);
    mq.addMessageListener(regular);
    const now = Date.now();
    await emit('newest-day', now);
    await emit('older-day', now - 1);
    expect(raw.mock.calls[1][2].status[0].value).toBe('older-day');
    expect(raw.mock.calls[1][3]).toBe(now - 1);
    expect(regular.mock.calls[1][2].status[0].value).toBe('newest-day');
  });

  test('raw listener mutations cannot change another listener or ordinary MQTT behavior', async () => {
    mq.addRawMessageListener((_topic, _protocol, data) => { data.status[0].value = 'changed'; });
    const raw = jest.fn();
    const regular = jest.fn();
    mq.addRawMessageListener(raw);
    mq.addMessageListener(regular);
    await emit('original', Date.now());
    expect(raw.mock.calls[0][2].status[0].value).toBe('original');
    expect(regular.mock.calls[0][2].status[0].value).toBe('original');
  });

  test('isolates raw listener errors and supports removal', async () => {
    mq.addRawMessageListener(() => { throw new Error('bad observer'); });
    const removed = jest.fn();
    const regular = jest.fn();
    mq.addRawMessageListener(removed);
    mq.removeRawMessageListener(removed);
    mq.addMessageListener(regular);
    await emit('original', Date.now());
    expect(removed).not.toHaveBeenCalled();
    expect(regular).toHaveBeenCalledTimes(1);
  });
});
