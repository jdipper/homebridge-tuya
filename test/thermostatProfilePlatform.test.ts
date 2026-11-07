import { TuyaPlatform } from '../src/platform';
import ThermostatRuntime from '../src/device/schedule/ThermostatRuntime';
import { configureThermostatProfileAccessories } from '../src/accessory/ThermostatProfileAccessory';
import { PLUGIN_NAME } from '../src/settings';

jest.mock('../src/device/schedule/ThermostatRuntime', () => ({ __esModule: true,
  default: Object.assign(jest.fn(), { instanceId: jest.fn(() => '0123456789abcdef') }),
}));
jest.mock('../src/accessory/ThermostatProfileAccessory', () => ({ __esModule: true,
  default: jest.fn(), configureThermostatProfileAccessories: jest.fn(),
}));

const instanceId = '0123456789abcdef';
const homeUuid = `uuid:${PLUGIN_NAME}:thermostat-profiles:${instanceId}`;
const holidayUuid = `uuid:${PLUGIN_NAME}:thermostat-profiles:${instanceId}:holiday`;
function fixture(cached = true) {
  const home = { UUID: homeUuid, displayName: 'Heating Programmes' };
  const holiday = { UUID: holidayUuid, displayName: 'Heating Holiday' };
  const other = { UUID: 'unrelated-unused-accessory', displayName: 'Unused' };
  const runtime = { start: jest.fn(async () => undefined), close: jest.fn(async () => undefined) };
  jest.mocked(ThermostatRuntime).mockImplementation(() => runtime as never);
  jest.mocked(configureThermostatProfileAccessories).mockImplementation((_platform, _runtime, _home, _holiday, publish) => {
    publish(); return { bindings: [] };
  });
  class Accessory {
    constructor(public displayName: string, public UUID: string) {}
  }
  const api = { hap: { uuid: { generate: (value: string) => `uuid:${value}` } }, platformAccessory: Accessory,
    user: { persistPath: () => '/tmp/unused-thermostat-fixture' },
    registerPlatformAccessories: jest.fn(), updatePlatformAccessories: jest.fn(), unregisterPlatformAccessories: jest.fn(),
  };
  const platform = Object.assign(Object.create(TuyaPlatform.prototype), {
    api, log: { warn: jest.fn() }, options: { projectType: '2', endpoint: 'fixture', accessId: 'fixture', username: 'fixture' },
    config: { name: 'fixture' }, deviceManager: { devices: [{ product_id: 'lmtejj3f4kafi2k1' }] },
    cachedAccessories: cached ? [home, holiday, other] : [], thermostatProfileControllers: [], thermostatProfileAccessories: [],
  }) as TuyaPlatform;
  const initialise = () => (platform as unknown as { initThermostatRuntime: () => Promise<void> }).initThermostatRuntime();
  return { home, holiday, other, runtime, api, platform, initialise };
}

beforeEach(() => jest.clearAllMocks());

test('claims both cached controller UUIDs before a runtime startup failure can reach unused-cache cleanup', async () => {
  const data = fixture(); data.runtime.start.mockRejectedValueOnce(new Error('runtime unavailable'));
  await data.initialise();
  expect(data.platform.cachedAccessories).toEqual([data.other]);
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(data.api.registerPlatformAccessories).not.toHaveBeenCalled();
  expect(configureThermostatProfileAccessories).not.toHaveBeenCalled();
  expect(data.runtime.close).toHaveBeenCalledTimes(1);
});

test('protects both cached controllers during incomplete thermostat discovery', async () => {
  const data = fixture(); data.platform.deviceManager!.devices = [];
  await data.initialise();
  expect(data.platform.cachedAccessories).toEqual([data.other]);
  expect(ThermostatRuntime).not.toHaveBeenCalled();
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
});

test('keeps the legacy Home UUID and creates exactly one stable separate Holiday accessory', async () => {
  const data = fixture(false);
  await data.initialise();
  expect(data.api.registerPlatformAccessories.mock.calls.map(call => call[2][0])).toEqual([
    { UUID: homeUuid, displayName: 'Heating Home' }, { UUID: holidayUuid, displayName: 'Heating Holiday' },
  ]);
  expect(data.platform.thermostatRuntime).toBe(data.runtime);
  await data.initialise();
  expect(data.api.registerPlatformAccessories).toHaveBeenCalledTimes(2);
  expect(ThermostatRuntime).toHaveBeenCalledTimes(1);
});

test('reuses both cached controllers without registering replacements', async () => {
  const data = fixture(); await data.initialise();
  expect(configureThermostatProfileAccessories).toHaveBeenCalledWith(data.platform, data.runtime, data.home, data.holiday, expect.any(Function));
  expect(data.api.registerPlatformAccessories).not.toHaveBeenCalled();
  expect(data.api.updatePlatformAccessories).toHaveBeenCalledWith([data.home]);
  expect(data.api.updatePlatformAccessories).toHaveBeenCalledWith([data.holiday]);
});

test('publication failure keeps the running runtime and fallback bindings instead of closing functional controls', async () => {
  const data = fixture();
  jest.mocked(configureThermostatProfileAccessories).mockReturnValueOnce({ bindings: [], error: new Error('registration failed') });
  await data.initialise();
  expect(data.platform.thermostatRuntime).toBe(data.runtime);
  expect(data.runtime.close).not.toHaveBeenCalled();
  expect(data.platform.cachedAccessories).toEqual([data.other]);
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
});
