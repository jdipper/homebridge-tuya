import { TuyaPlatform } from '../src/platform';
import TuyaProgrammeProvider from '../src/device/schedule/TuyaProgrammeProvider';

jest.mock('../src/device/schedule/TuyaProgrammeProvider', () => ({ __esModule: true,
  default: Object.assign(jest.fn(), { instanceId: jest.fn(() => '0123456789abcdef') }),
}));

function fixture() {
  const instance = '0123456789abcdef';
  const home = { UUID: `uuid:@homebridge-plugins/homebridge-tuya:thermostat-profiles:${instance}` };
  const holiday = { UUID: `${home.UUID}:holiday` };
  const other = { UUID: 'unrelated-unused-accessory' };
  const provider = { start: jest.fn(async () => undefined), close: jest.fn(async () => undefined) };
  jest.mocked(TuyaProgrammeProvider).mockImplementation(() => provider as never);
  const api = { hap: { uuid: { generate: (value: string) => `uuid:${value}` } },
    user: { persistPath: () => '/tmp/unused-programme-fixture' }, registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn() };
  const platform = Object.assign(Object.create(TuyaPlatform.prototype), { api, log: { warn: jest.fn() },
    options: { projectType: '2', endpoint: 'fixture', accessId: 'fixture', username: 'fixture' },
    config: { name: 'fixture' }, deviceManager: { devices: [{ product_id: 'lmtejj3f4kafi2k1' }] },
    cachedAccessories: [home, holiday, other], legacyProgrammeControls: [],
  }) as TuyaPlatform;
  const initialize = () => (platform as unknown as { initProgrammeProvider: () => Promise<void> }).initProgrammeProvider();
  return { platform, provider, initialize, api, home, holiday, other };
}

beforeEach(() => jest.clearAllMocks());

test('starts a device provider and retires the old household controls without publishing replacements', async () => {
  const data = fixture(); await data.initialize();
  expect(data.platform.programmeProvider).toBe(data.provider);
  expect(data.api.unregisterPlatformAccessories).toHaveBeenCalledWith('@jdipper/homebridge-tuya', 'TuyaPlatform', [data.home, data.holiday]);
  expect(data.api.registerPlatformAccessories).not.toHaveBeenCalled();
  expect(data.platform.cachedAccessories).toEqual([data.other]);
  await data.initialize();
  expect(TuyaProgrammeProvider).toHaveBeenCalledTimes(1);
  expect(data.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
});

test('a failed device provider start does not retire former controls through the unused-cache sweep', async () => {
  const data = fixture(); data.provider.start.mockRejectedValueOnce(new Error('unavailable'));
  await data.initialize();
  expect(data.platform.programmeProvider).toBeUndefined();
  expect(data.platform.cachedAccessories).toEqual([data.other]);
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(data.provider.close).toHaveBeenCalledTimes(1);
});

test('incomplete discovery retains cached controls and does not start an empty provider', async () => {
  const data = fixture(); data.platform.deviceManager!.devices = [];
  await data.initialize();
  expect(data.platform.cachedAccessories).toEqual([data.other]);
  expect(TuyaProgrammeProvider).not.toHaveBeenCalled();
  expect(data.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
});

test('passes explicit validated groups to the provider without changing its identity input', async () => {
  const data = fixture();
  const groups = [{groupId: '1234567890123456789', deviceIds: ['a', 'b', 'c', 'd', 'e', 'f']}];
  data.platform.options.fastWarmProgrammeGroups = groups;
  await data.initialize();
  expect(TuyaProgrammeProvider).toHaveBeenCalledWith(data.platform.deviceManager,
    '/tmp/unused-programme-fixture', '0123456789abcdef', undefined,
    {programmeWriteModes: undefined, programmeGroups: groups});
  expect(TuyaProgrammeProvider.instanceId).toHaveBeenCalledWith({
    projectType: '2', endpoint: 'fixture', accessId: 'fixture', username: 'fixture', bridge: 'fixture',
  });
});
