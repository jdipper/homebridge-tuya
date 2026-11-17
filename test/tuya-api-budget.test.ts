/* eslint-disable @typescript-eslint/no-explicit-any */
import https from 'https';
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import { initLogger } from '../src/util/Logger';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const refreshed = () => ({success: true as const, result: {
  access_token: 'new-access', refresh_token: 'new-refresh', uid: 'fixture-user', expire_time: 7200,
}, t: Date.now(), tid: 'fixture'});
let warn: jest.Mock;
function client() {
  warn = jest.fn();
  initLogger({info: jest.fn(), warn, debug: jest.fn(), error: jest.fn()});
  const api = new TuyaOpenAPI('https://example.invalid', 'fixture-id', 'fixture-key');
  api.tokenInfo = {access_token: 'old-access', refresh_token: 'old-refresh', uid: 'fixture-user', expire: 0};
  return api;
}
afterEach(() => {jest.restoreAllMocks();});

test('simultaneous expiry shares one refresh and all subsequent commands use the refreshed token', async () => {
  const api = client(), records = jest.fn(), sent: any[] = [];
  api.setUsageMeter({record: records});
  jest.spyOn(https, 'request').mockImplementation((options: any, callback: any) => {
    sent.push(options);
    const request: any = new EventEmitter();
    request.write = jest.fn();
    request.end = () => queueMicrotask(() => {
      const response: any = new EventEmitter();
      response.statusCode = 200; response.setEncoding = jest.fn();
      callback(response);
      response.emit('data', JSON.stringify(options.path.startsWith('/v1.0/token/') ? refreshed()
        : {success: true, result: {}, t: Date.now(), tid: 'fixture'}));
      response.emit('end');
    });
    return request;
  });
  await Promise.all(Array.from({length: 6}, () => api.postOnce('/v2.0/cloud/thing/private-device/shadow/properties/issue',
    {properties: JSON.stringify({week_program: 'PRIVATE_PAYLOAD'})})));
  expect(sent.filter(item => item.path.startsWith('/v1.0/token/'))).toHaveLength(1);
  const commands = sent.filter(item => item.path.endsWith('/shadow/properties/issue'));
  expect(commands).toHaveLength(6);
  expect(commands.every(item => item.headers.access_token === 'new-access')).toBe(true);
  expect(records.mock.calls.map(call => call[0])).toEqual(['authentication', ...Array(6).fill('programme')]);
});

test('a rejected shared refresh clears its slot and the next operation can recover', async () => {
  const api = client(), gate = deferred<any>();
  const get = jest.spyOn(api, 'get').mockReturnValueOnce(gate.promise).mockResolvedValue(refreshed());
  const requests = [api._refreshAccessTokenIfNeed('/device/a'), api._refreshAccessTokenIfNeed('/device/b')];
  gate.reject(new Error('refresh transport failed'));
  const results = await Promise.allSettled(requests);
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  expect(get).toHaveBeenCalledTimes(1);
  await api._refreshAccessTokenIfNeed('/device/c');
  expect(get).toHaveBeenCalledTimes(2);
  expect(api.tokenInfo.access_token).toBe('new-access');
});

test('full re-login cannot deadlock its refresh, and other callers wait while login temporarily clears the token', async () => {
  const api = client(), entered = deferred<void>(), release = deferred<void>();
  api.loginInfo = {countryCode: 44, username: 'fixture-user', password: 'fixture-password', appSchema: 'smartlife'};
  jest.spyOn(api, 'get').mockResolvedValue({success: false, result: {}, code: 1010, msg: 'expired', t: 0, tid: 'fixture'});
  const post = jest.spyOn(api, 'post').mockImplementation(async route => {
    await api._refreshAccessTokenIfNeed(route);
    entered.resolve();
    await release.promise;
    return refreshed();
  });
  const first = api._refreshAccessTokenIfNeed('/device/a');
  await entered.promise;
  expect(api.isLogin()).toBe(false);
  let waiterFinished = false;
  const second = api._refreshAccessTokenIfNeed('/device/b').then(() => {waiterFinished = true;});
  await Promise.resolve();
  expect(waiterFinished).toBe(false);
  release.resolve();
  await Promise.all([first, second]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(api.tokenRecoveryCount).toBe(1);
  expect(api.tokenInfo.access_token).toBe('new-access');
});

test('token-management calls bypass an in-flight refresh without causing a second refresh', async () => {
  const api = client(), gate = deferred<any>(), get = jest.spyOn(api, 'get').mockReturnValue(gate.promise);
  const refresh = api._refreshAccessTokenIfNeed('/device/a');
  await api._refreshAccessTokenIfNeed('/v1.0/token/fixture-refresh');
  expect(get).toHaveBeenCalledTimes(1);
  gate.resolve(refreshed());
  await refresh;
});

test('cancelled commands are not counted and a failed optional meter cannot block or retry a command', async () => {
  const api = client(), record = jest.fn(() => {throw new Error('PRIVATE_METER_FAILURE');});
  api.tokenInfo.expire = Date.now() + 7200000;
  api.setUsageMeter({record});
  const transport = jest.spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
    const request: any = new EventEmitter(); request.write = jest.fn();
    request.end = () => {
      const response: any = new EventEmitter(); response.statusCode = 200; response.setEncoding = jest.fn();
      callback(response); response.emit('data', JSON.stringify({success: true, result: {}, t: Date.now(), tid: 'fixture'}));
      response.emit('end');
    };
    return request;
  });
  await api.request('post', '/commands', null, {}, {attempts: 1, shouldProceed: () => false});
  expect(record).not.toHaveBeenCalled();
  await api.postOnce('/commands', {});
  await api.postOnce('/commands', {});
  expect(transport).toHaveBeenCalledTimes(2);
  expect(record).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_METER_FAILURE');
});

test('a retried read counts each real transport attempt rather than one logical API operation', async () => {
    const api = client(), record = jest.fn();
    api.tokenInfo.expire = Date.now() + 7200000;
    api.setUsageMeter({record});
    let attempts = 0;
    const transport = jest.spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
      const request: any = new EventEmitter(); request.write = jest.fn();
      request.end = () => queueMicrotask(() => {
        if (++attempts === 1) {
          request.emit('error', new Error('read connection lost'));
          return;
        }
        const response: any = new EventEmitter(); response.statusCode = 200; response.setEncoding = jest.fn();
        callback(response); response.emit('data', JSON.stringify({success: true, result: {}, t: Date.now(), tid: 'fixture'}));
        response.emit('end');
      });
      return request;
    });
    const response = await api.request('get', '/fixture-read', null, null, {attempts: 2});
    expect(response.success).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(record.mock.calls).toEqual([['read'], ['read']]);
});
