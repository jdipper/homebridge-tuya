/* eslint-disable @typescript-eslint/no-explicit-any */
import https from 'https';
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import { initLogger } from '../src/util/Logger';

describe('Tuya single-attempt commands', () => {
  let api: TuyaOpenAPI;
  let request: any;
  let send: jest.SpiedFunction<typeof https.request>;

  beforeEach(() => {
    jest.useFakeTimers();
    initLogger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
    api = new TuyaOpenAPI(TuyaOpenAPI.Endpoints.EUROPE, 'test', 'test');
    jest.spyOn(api, '_refreshAccessTokenIfNeed').mockResolvedValue(undefined);
    request = new EventEmitter();
    request.write = jest.fn();
    request.end = jest.fn();
    request.destroy = jest.fn((error: Error) => request.emit('error', error));
    send = jest.spyOn(https, 'request').mockReturnValue(request);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('makes one HTTP attempt and never retries an ambiguous network failure', async () => {
    request.end.mockImplementation(() => queueMicrotask(() => request.emit('error', new Error('connection lost'))));
    const pending = expect(api.postOnce('/test', { properties: '{}' })).rejects.toThrow('connection lost');
    await jest.advanceTimersByTimeAsync(200000);
    await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('destroys a hung HTTP request at its deadline without retrying', async () => {
    const pending = expect(api.postOnce('/test', {}, { timeoutMs: 1000 })).rejects.toThrow('outcome may be unknown');
    await jest.advanceTimersByTimeAsync(1000);
    await pending;
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a delayed authentication cannot transmit a command after the deadline', async () => {
    let finishAuthentication: () => void = () => undefined;
    jest.spyOn(api, '_refreshAccessTokenIfNeed').mockReturnValue(new Promise(resolve => { finishAuthentication = resolve; }));
    const pending = expect(api.postOnce('/test', {}, { timeoutMs: 1000 })).rejects.toThrow('before transmission');
    await jest.advanceTimersByTimeAsync(1000);
    await pending;
    finishAuthentication();
    await jest.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
  });

  test('clears the deadline after a successful empty-result response', async () => {
    send.mockImplementation(((_options: unknown, callback: (response: any) => void) => {
      request.end.mockImplementation(() => {
        const response: any = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = jest.fn();
        callback(response);
        response.emit('data', JSON.stringify({ success: true, result: {}, t: Date.now(), tid: 'test' }));
        response.emit('end');
      });
      return request;
    }) as any);
    const response = await api.postOnce('/test', {});
    expect(response.success).toBe(true);
    expect(response.result).toEqual({});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('leaves ordinary post callers on the existing request path', async () => {
    const core = jest.spyOn(api, 'request').mockResolvedValue({ success: true, result: {}, t: Date.now(), tid: 'test' });
    await api.post('/ordinary', { test: true });
    expect(core).toHaveBeenLastCalledWith('post', '/ordinary', null, { test: true });
    await api.postOnce('/single', { test: true });
    expect(core).toHaveBeenLastCalledWith('post', '/single', null, { test: true }, { attempts: 1, timeoutMs: 15000 });
  });
});
