import TuyaOpenAPI, { TuyaOpenAPIResponse } from '../../src/core/TuyaOpenAPI';
import TuyaDevice from '../../src/device/TuyaDevice';
import TuyaHomeDeviceManager from '../../src/device/TuyaHomeDeviceManager';
import { initLogger } from '../../src/util/Logger';

const device = (id: string, ownerID = '123', productID = 'lmtejj3f4kafi2k1') => new TuyaDevice({
  id, owner_id: ownerID, name: 'Thermostat', product_id: productID, status: [], schema: [], online: true,
});
const success = (result: unknown): TuyaOpenAPIResponse => ({ success: true, result, t: 0, tid: 'test' });

describe('SmartLife thermostat room discovery', () => {
  let manager: TuyaHomeDeviceManager;
  let get: jest.Mock;
  let responses: Map<string, TuyaOpenAPIResponse | Error>;

  beforeEach(() => {
    initLogger({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() });
    const api = new TuyaOpenAPI(TuyaOpenAPI.Endpoints.EUROPE, 'test-id', 'test-key');
    manager = new TuyaHomeDeviceManager(api);
    responses = new Map([
      ['/v1.0/homes/123/rooms', success({ rooms: [
        { room_id: 11, name: ' Living Room ' }, { room_id: 12, name: 'Kitchen' },
      ] })],
      ['/v1.0/homes/123/rooms/11/devices', success([{ id: 'thermostat-a' }])],
      ['/v1.0/homes/123/rooms/12/devices', success([{ id: 'thermostat-b' }])],
    ]);
    get = jest.fn(async (url: string) => {
      const response = responses.get(url);
      if (response instanceof Error) {
        throw response;
      }
      if (!response) {
        throw new Error(`Unexpected API request: ${url}`);
      }
      return response;
    });
    jest.spyOn(api, 'get').mockImplementation(get);
    jest.spyOn(api, 'request').mockImplementation(async (_method, url) => get(url));
    manager.devices = [device('thermostat-a'), device('thermostat-b')];
  });

  afterEach(() => jest.restoreAllMocks());

  test('maps identical device names by membership without renaming or changing identity', async () => {
    await manager.refreshDeviceRooms();
    expect(manager.devices.map(item => ({ id: item.id, name: item.name, room: item.room_name, roomID: item.room_id })))
      .toEqual([
        { id: 'thermostat-a', name: 'Thermostat', room: 'Living Room', roomID: '11' },
        { id: 'thermostat-b', name: 'Thermostat', room: 'Kitchen', roomID: '12' },
      ]);
    expect(get.mock.calls.every(([url]) => url.startsWith('/v1.0/homes/123/rooms'))).toBe(true);
  });

  test('does not query homes without FastWarm devices or accept membership from another home', async () => {
    manager.devices.push(device('other-home-device', '456', 'different-product'));
    responses.set('/v1.0/homes/123/rooms/11/devices', success([
      { id: 'thermostat-a' }, { id: 'other-home-device' }, { id: 'unknown-device' },
    ]));
    await manager.refreshDeviceRooms();
    expect(manager.getDevice('other-home-device')?.room_name).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(3);
    expect(manager.devices).toHaveLength(3);
  });

  test('preserves the complete previous home mapping if one membership request fails', async () => {
    await manager.refreshDeviceRooms();
    responses.set('/v1.0/homes/123/rooms/11/devices', success([{ id: 'thermostat-b' }]));
    responses.set('/v1.0/homes/123/rooms/12/devices', new Error('No internet'));
    await expect(manager.refreshDeviceRooms()).resolves.toBeUndefined();
    expect(manager.getDevice('thermostat-a')?.room_name).toBe('Living Room');
    expect(manager.getDevice('thermostat-b')?.room_name).toBe('Kitchen');
  });

  test('clears removed membership and updates a moved thermostat after a complete successful read', async () => {
    await manager.refreshDeviceRooms();
    responses.set('/v1.0/homes/123/rooms/11/devices', success([]));
    responses.set('/v1.0/homes/123/rooms/12/devices', success([{ id: 'thermostat-a' }]));
    await manager.refreshDeviceRooms();
    expect(manager.getDevice('thermostat-a')?.room_name).toBe('Kitchen');
    expect(manager.getDevice('thermostat-b')?.room_name).toBeUndefined();
    expect(manager.getDevice('thermostat-b')?.room_id).toBeUndefined();
  });

  test('keeps confirmed room metadata through individual rediscovery but drops it after a home change', async () => {
    await manager.refreshDeviceRooms();
    jest.spyOn(manager, 'getDeviceSchema').mockResolvedValue([]);
    jest.spyOn(manager, 'enrichDeviceStatus').mockResolvedValue();
    responses.set('/v1.0/devices/thermostat-a', success(device('thermostat-a')));
    expect((await manager.updateDevice('thermostat-a'))?.room_name).toBe('Living Room');
    responses.set('/v1.0/devices/thermostat-a', success(device('thermostat-a', '456')));
    expect((await manager.updateDevice('thermostat-a'))?.room_name).toBeUndefined();
  });

  test('room permissions failure does not prevent normal discovery', async () => {
    responses.set('/v1.0/homes/123/devices', success([device('thermostat-a')]));
    responses.set('/v1.0/homes/123/rooms', {
      success: false, result: {}, code: 28841101, msg: 'Not authorized', t: 0, tid: 'test',
    });
    jest.spyOn(manager, 'getDeviceSchema').mockResolvedValue([]);
    jest.spyOn(manager, 'enrichDeviceStatus').mockResolvedValue();
    const devices = await manager.updateDevices([123]);
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe('thermostat-a');
    expect(devices[0].room_name).toBeUndefined();
  });

  test('rejects conflicting membership rather than giving a thermostat the wrong room name', async () => {
    await manager.refreshDeviceRooms();
    responses.set('/v1.0/homes/123/rooms/12/devices', success([{ id: 'thermostat-a' }]));
    await manager.refreshDeviceRooms();
    expect(manager.getDevice('thermostat-a')?.room_name).toBe('Living Room');
    expect(manager.getDevice('thermostat-b')?.room_name).toBe('Kitchen');
  });
});
