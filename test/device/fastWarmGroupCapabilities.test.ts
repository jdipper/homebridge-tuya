/* eslint-disable @typescript-eslint/no-explicit-any */
import Broker, {FASTWARM_GROUP_CAPABILITY_TTL_MS, FastWarmGroupCommandRejected} from '../../src/device/schedule/FastWarmGroupCommandBroker';
import {encodeFastWarmSchedule} from '../../src/device/schedule/FastWarmSchedule';

const ids = Array.from({length: 6}, (_, index) => 'capability-room-' + index), groupId = '1234567890123456789';
const descriptor = () => [{code: 'inquire', type: 'bool'}, {code: 'week_program', type: 'raw', type_desc: '{"maxlen":128}'}];
const membership = () => ({page_no: 1, page_size: 20, count: 6, data_list: ids.map(device_id => ({device_id, group_id: groupId}))});
const raw = encodeFastWarmSchedule({dayMask: 127, events: [{event: 1, hour: 8, minute: 30, temperature: 12}]});
const brokers: Broker[] = [];
afterEach(() => {for (const broker of brokers.splice(0)) broker.close(); jest.restoreAllMocks();});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function fixture() {
  const calls: string[] = [];
  let schema: any = descriptor(), members: any = membership(), response: any = {success: true, result: {result: true}};
  let schemaHook: (() => Promise<void> | void) | undefined, membersHook: (() => Promise<void> | void) | undefined;
  let postAuthHook: (() => void) | undefined, postError: Error | undefined;
  const api: any = {tokenRecoveryCount: 0,
    request: jest.fn(async (_method: string, route: string, params: any, _body: any, options: any) => {
      expect(options).toMatchObject({attempts: 1, timeoutMs: 100});
      if (route.endsWith('/devices')) {
        calls.push('members'); expect(params).toEqual({page_no: 1, page_size: 20});
        const result = structuredClone(members); await membersHook?.(); return {success: true, result};
      }
      expect(route).toBe(`/v2.1/cloud/thing/group/${groupId}/properties`); calls.push('schema');
      const result = structuredClone(schema); await schemaHook?.(); return {success: true, result};
    }),
    postOnce: jest.fn(async (_route: string, _body: any, options: any) => {
      if (!options.shouldProceed()) return {success: false}; postAuthHook?.();
      if (!options.shouldProceed()) return {success: false};
      calls.push('post'); if (postError) throw postError; return response;
    }),
  };
  const broker = new Broker(api, [{groupId, deviceIds: ids}], 100, 1); brokers.push(broker);
  const individual = jest.fn(async () => undefined);
  const send = (properties: {inquire: true} | {week_program: string} = {inquire: true}) => Promise.all(ids.map(id =>
    broker.send(id, properties, () => true, individual)));
  return {api, broker, calls, send, individual, schema: (value: any) => {schema = value;},
    members: (value: any) => {members = value;}, response: (value: any) => {response = value;},
    schemaHook: (hook?: () => Promise<void> | void) => {schemaHook = hook;}, membersHook: (hook?: () => Promise<void> | void) => {membersHook = hook;},
    postAuth: (hook?: () => void) => {postAuthHook = hook;}, postError: (error?: Error) => {postError = error;}};
}

test('one compact schema is reused for inquiry and native single-event writes, while membership is always freshly read', async () => {
  const f = fixture(); await f.send(); await f.send({week_program: raw}); await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(1);
  expect(f.calls.filter(value => value === 'members')).toHaveLength(3);
  expect(f.calls.filter(value => value === 'post')).toHaveLength(3);
});

test('the fixed 24-hour cache expires without extending its lifetime on use', async () => {
  let clock = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => clock);
  const f = fixture(); await f.send(); clock += FASTWARM_GROUP_CAPABILITY_TTL_MS - 1; await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(1);
  clock += 2; await f.send(); expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
});

test('a backwards clock step cannot keep an observation from the future warm', async () => {
  let clock = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => clock);
  const f = fixture(); await f.send(); clock -= 1000; await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
});

test.each(['missing raw', 'wrong bool', 'duplicate', 'invalid maxlen', 'malformed json', 'malformed row'])(
  'a %s schema is never cached and cannot dispatch', async kind => {
    const f = fixture(), invalid: any = descriptor();
    if (kind === 'missing raw') invalid.pop(); else if (kind === 'wrong bool') invalid[0].type = 'value';
    else if (kind === 'duplicate') invalid.push({...invalid[0]}); else if (kind === 'invalid maxlen') invalid[1].type_desc = '{"maxlen":1}';
    else if (kind === 'malformed json') invalid[1].type_desc = '{'; else invalid.push(null);
    f.schema(invalid); await expect(f.send()).rejects.toBeInstanceOf(FastWarmGroupCommandRejected);
    f.schema(descriptor()); await f.send();
    expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
    expect(f.calls.filter(value => value === 'post')).toHaveLength(1); expect(f.individual).not.toHaveBeenCalled();
  },
);

test('a schema request failure cannot cache or dispatch and is retried only by a later explicit operation', async () => {
  const f = fixture(); f.schemaHook(() => {throw Error('schema timeout');});
  await expect(f.send()).rejects.toBeInstanceOf(FastWarmGroupCommandRejected);
  expect(f.calls.filter(value => value === 'post')).toHaveLength(0);
  f.schemaHook(); await f.send(); expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
});

test('changed membership is caught despite schema reuse and clears the cached capabilities', async () => {
  const f = fixture(); await f.send(); const wrong = membership(); wrong.data_list[0].device_id = 'outside-room'; f.members(wrong);
  await expect(f.send()).rejects.toBeInstanceOf(FastWarmGroupCommandRejected);
  f.members(membership()); await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
  expect(f.calls.filter(value => value === 'members')).toHaveLength(3);
  expect(f.calls.filter(value => value === 'post')).toHaveLength(2);
});

test('a failed membership request invalidates a previously warm schema', async () => {
  const f = fixture(); await f.send(); f.membersHook(() => {throw Error('membership timeout');});
  await expect(f.send()).rejects.toBeInstanceOf(FastWarmGroupCommandRejected);
  f.membersHook(); await f.send(); expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
});

test.each(['negative ack', 'ambiguous ack', 'network failure'])('%s invalidates capabilities and never replays a group command', async kind => {
  const f = fixture(); await f.send();
  if (kind === 'negative ack') f.response({success: false}); else if (kind === 'ambiguous ack') f.response({success: true, result: {}});
  else f.postError(Error('unknown request outcome'));
  await expect(f.send({week_program: raw})).rejects.toThrow(); expect(f.individual).not.toHaveBeenCalled();
  f.response({success: true, result: {result: true}}); f.postError(); await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
  expect(f.calls.filter(value => value === 'post')).toHaveLength(3);
});

test('an explicit reset or full authentication recovery refetches capabilities; ordinary token renewal does not', async () => {
  const f = fixture(); await f.send(); f.api.tokenInfo = {access_token: 'renewed'}; await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(1);
  f.broker.invalidateCapabilities(ids[0]); await f.send(); f.api.tokenRecoveryCount++; await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(3);
});

test('a full login during post authentication cancels dispatch and discards the old capabilities', async () => {
  const f = fixture(); await f.send(); f.postAuth(() => f.api.tokenRecoveryCount++);
  await expect(f.send({week_program: raw})).rejects.toThrow();
  expect(f.calls.filter(value => value === 'post')).toHaveLength(1);
  f.postAuth(); await f.send(); expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
});

test('an old in-flight schema fetch cannot reinstall its cache or clear a newer generation', async () => {
  const f = fixture(), gate = deferred<void>(); let first = true;
  f.schemaHook(async () => {if (first) {first = false; await gate.promise;}});
  const old = f.send(); const oldRejected = expect(old).rejects.toBeInstanceOf(FastWarmGroupCommandRejected);
  await new Promise(resolve => setImmediate(resolve)); f.broker.invalidateCapabilities();
  await f.send(); gate.resolve(); await oldRejected; await f.send();
  expect(f.calls.filter(value => value === 'schema')).toHaveLength(2);
  expect(f.calls.filter(value => value === 'post')).toHaveLength(2);
});

test('invalidation after schema reuse is still checked immediately before dispatch', async () => {
  const f = fixture(); await f.send(); f.postAuth(() => f.broker.invalidateCapabilities(ids[5]));
  await expect(f.send({week_program: raw})).rejects.toThrow();
  expect(f.calls.filter(value => value === 'post')).toHaveLength(1);
});

test('capability expiry during authentication cancels dispatch', async () => {
  let clock = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => clock);
  const f = fixture(); await f.send(); f.postAuth(() => {clock += FASTWARM_GROUP_CAPABILITY_TTL_MS + 1;});
  await expect(f.send({week_program: raw})).rejects.toThrow();
  expect(f.calls.filter(value => value === 'post')).toHaveLength(1);
});

test('closing while metadata is in flight prevents caching and post dispatch', async () => {
  const f = fixture(), gate = deferred<void>(); f.schemaHook(() => gate.promise);
  const pending = f.send(); const rejected = expect(pending).rejects.toBeInstanceOf(FastWarmGroupCommandRejected);
  await new Promise(resolve => setImmediate(resolve)); f.broker.close(); gate.resolve(); await rejected;
  expect(f.calls.filter(value => value === 'post')).toHaveLength(0); await expect(f.send()).rejects.toThrow('closed');
});
