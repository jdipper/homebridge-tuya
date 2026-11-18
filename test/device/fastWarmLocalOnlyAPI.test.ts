import https from 'https';
import mqtt from 'mqtt';
import TuyaOpenAPI from '../../src/core/TuyaOpenAPI';
import FastWarmLocalOnlyAPI, {FASTWARM_LOCAL_ONLY_CLOUD_ERROR} from '../../src/device/lan/FastWarmLocalOnlyAPI';
import {initLogger} from '../../src/util/Logger';

const log = {info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn()};

beforeEach(() => {
  jest.clearAllMocks();
  initLogger(log);
});

afterEach(() => jest.restoreAllMocks());

function fixture() {
  const network = jest.spyOn(https, 'request').mockImplementation(() => {
    throw Error('Unexpected test network request');
  });
  const mqttConnect = jest.spyOn(mqtt, 'connect').mockImplementation(() => {
    throw Error('Unexpected test MQTT connection');
  });
  const baseRequest = jest.spyOn(TuyaOpenAPI.prototype, 'request');
  const refresh = jest.spyOn(TuyaOpenAPI.prototype, '_refreshAccessTokenIfNeed');
  const getToken = jest.spyOn(TuyaOpenAPI.prototype, 'getToken');
  const homeLogin = jest.spyOn(TuyaOpenAPI.prototype, 'homeLogin');
  const customLogin = jest.spyOn(TuyaOpenAPI.prototype, 'customLogin');
  const meter = {record: jest.fn()};
  const api = new FastWarmLocalOnlyAPI('https://openapi.tuyaeu.com', 'test-access-id', 'test-access-key');
  api.setUsageMeter(meter);
  api.tokenInfo = {access_token: 'stale-access', refresh_token: 'stale-refresh', uid: 'stale-user', expire: 1};
  return {api, network, mqttConnect, baseRequest, refresh, getToken, homeLogin, customLogin, meter};
}

const cloudOperations: [string, (api: FastWarmLocalOnlyAPI) => Promise<unknown>][] = [
  ['direct native shadow read', api => api.request('get', '/v2.0/cloud/thing/fixture/shadow/properties')],
  ['direct group mutation', api => api.request('put', '/v2.1/cloud/thing/group/1/properties', null, {properties: '{}'})],
  ['GET convenience read', api => api.get('/v1.0/homes/1/devices')],
  ['POST scene command', api => api.post('/v1.0/homes/1/scenes/fixture/trigger', {})],
  ['single-attempt native command', api => api.postOnce('/v2.0/cloud/thing/fixture/shadow/properties/issue', {properties: '{}'})],
  ['DELETE convenience mutation', api => api.delete('/v1.0/homes/1/scenes/fixture')],
  ['custom user lookup', api => api.customGetUserInfo('fixture-user')],
  ['custom user creation', api => api.customCreateUser('fixture-user', 'fixture-password')],
  ['direct lazy token refresh', api => api._refreshAccessTokenIfNeed('/v1.0/homes/1/devices')],
  ['token acquisition', api => api.getToken()],
  ['home login', api => api.homeLogin(44, 'fixture-user', 'fixture-password', 'smartlife')],
  ['custom login', api => api.customLogin('fixture-user', 'fixture-password')],
];

test.each(cloudOperations)('%s fails before cloud authentication, accounting or network access', async (_name, operation) => {
  const data = fixture(), before = structuredClone(data.api.tokenInfo);
  await expect(operation(data.api)).rejects.toThrow(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  expect(data.api.tokenInfo).toEqual(before);
  expect(data.api.loginInfo).toBeNull();
  for (const action of [data.network, data.mqttConnect, data.baseRequest, data.refresh,
    data.getToken, data.homeLogin, data.customLogin, data.meter.record]) {
    expect(action).not.toHaveBeenCalled();
  }
});

test('a cancelled-request guard cannot turn a forbidden cloud operation into apparent success', async () => {
  const data = fixture(), shouldProceed = jest.fn(() => false);
  await expect(data.api.postOnce('/forbidden', null, {shouldProceed})).rejects.toThrow(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  expect(shouldProceed).not.toHaveBeenCalled();
  expect(data.network).not.toHaveBeenCalled();
  expect(data.mqttConnect).not.toHaveBeenCalled();
  expect(data.meter.record).not.toHaveBeenCalled();
});

test('request rejection does not inspect request payloads or options and cannot expose their contents', async () => {
  const data = fixture(), getter = jest.fn(() => {
    throw Error('never-log-private-payload');
  });
  const options = Object.defineProperty({}, 'shouldProceed', {get: getter});
  await expect(data.api.request('post', '/never-log-private-path', undefined, {localKey: 'never-log-private-key'}, options))
    .rejects.toThrow(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  expect(getter).not.toHaveBeenCalled();
  expect(data.network).not.toHaveBeenCalled();
  expect(data.mqttConnect).not.toHaveBeenCalled();
  expect(JSON.stringify(log)).not.toContain('never-log-private');
  for (const action of Object.values(log)) {
    expect(action).not.toHaveBeenCalled();
  }
});

test('constructing the API preserves the manager contract without opening sockets or creating renewal timers', () => {
  jest.useFakeTimers();
  try {
    const data = fixture();
    expect(data.api).toBeInstanceOf(TuyaOpenAPI);
    expect(data.api.isLogin()).toBe(true); // The guard remains closed even with stale legacy token state.
    expect(data.api.tokenRecoveryCount).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(data.network).not.toHaveBeenCalled();
    expect(data.mqttConnect).not.toHaveBeenCalled();
    expect(data.meter.record).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
