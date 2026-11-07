import EventEmitter from 'events';
import ThermostatProfileAccessory, { configureThermostatProfileAccessories } from '../../src/accessory/ThermostatProfileAccessory';

interface MockCharacteristic {
  value: unknown; iid?: number; get?: () => unknown; set?: (value: boolean) => Promise<void>;
  onGet: (handler: () => unknown) => MockCharacteristic;
  onSet: (handler: (value: boolean) => Promise<void>) => MockCharacteristic;
  updateValue: jest.Mock;
}
interface MockService {
  displayName: string; subtype: string; iid?: number; characteristics: Map<string, MockCharacteristic>;
  getCharacteristic: jest.Mock<MockCharacteristic, [string]>; testCharacteristic: jest.Mock<boolean, [string]>;
  addOptionalCharacteristic: jest.Mock; setCharacteristic: jest.Mock;
}
function makeService(displayName: string, subtype: string): MockService {
  const characteristics = new Map<string, MockCharacteristic>();
  const getCharacteristic = jest.fn((type: string): MockCharacteristic => {
    if (!characteristics.has(type)) {
      const characteristic: MockCharacteristic = {
        value: undefined,
        onGet: handler => { characteristic.get = handler; return characteristic; },
        onSet: handler => { characteristic.set = handler; return characteristic; },
        updateValue: jest.fn(value => { characteristic.value = value; return characteristic; }),
      };
      characteristics.set(type, characteristic);
    }
    return characteristics.get(type)!;
  });
  const service: MockService = { displayName, subtype, characteristics, getCharacteristic,
    testCharacteristic: jest.fn(type => characteristics.has(type)), addOptionalCharacteristic: jest.fn(),
    setCharacteristic: jest.fn((type: string, value: unknown) => { getCharacteristic(type).value = value; return service; }) };
  service.setCharacteristic('name', displayName);
  return service;
}
function makeAccessory(displayName: string, UUID: string, subtypes: string[] = [], names: Record<string, string> = {}) {
  const services = subtypes.map(subtype => {
    const service = makeService('Heating Programmes', subtype);
    if (Object.prototype.hasOwnProperty.call(names, subtype)) service.getCharacteristic('configured-name').value = names[subtype];
    return service;
  });
  const information = makeService(displayName, 'information');
  const accessory = { displayName, UUID, services,
    getService: () => information,
    getServiceById: jest.fn((_type: string, subtype: string) => services.find(service => service.subtype === subtype)),
    addService: jest.fn((type: string | MockService, name?: string, subtype?: string) => {
      const service = typeof type === 'string' ? makeService(name!, subtype!) : type;
      services.push(service); return service;
    }),
    removeService: jest.fn((service: MockService) => { const index = services.indexOf(service); if (index >= 0) services.splice(index, 1); }),
  };
  return accessory;
}
function fixture(mode: 'new' | 'split' | 'legacy' = 'new', configuredNames: Record<string, string> = {}) {
  const runtime = Object.assign(new EventEmitter(), { instanceId: '0123456789abcdef',
    state: { anyoneHome: null as boolean | null, holiday: false }, handle: jest.fn(async () => ({})) });
  Object.defineProperties(runtime, {
    householdPresence: { get: () => runtime.state.anyoneHome }, holidayActive: { get: () => runtime.state.holiday },
  });
  class Unavailable extends Error {}
  const platform = { api: { updatePlatformAccessories: jest.fn(), hap: {
    Service: { AccessoryInformation: 'information', Switch: 'switch' },
    Characteristic: { Manufacturer: 'maker', Model: 'model', SerialNumber: 'serial', On: 'on', Name: 'name', ConfiguredName: 'configured-name' },
    HapStatusError: Unavailable, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  } } };
  const home = makeAccessory('Heating Programmes', 'stable-home-uuid', mode === 'legacy' ? ['anyone-home', 'holiday'] : mode === 'split' ? ['anyone-home'] : [], configuredNames);
  const holiday = makeAccessory('Heating Holiday', 'stable-holiday-uuid', mode === 'split' ? ['holiday'] : [], configuredNames);
  const configure = () => [new ThermostatProfileAccessory(platform as never, home as never, runtime as never, 'home'),
    new ThermostatProfileAccessory(platform as never, holiday as never, runtime as never, 'holiday')];
  const migrate = (publish: () => void = jest.fn()) => configureThermostatProfileAccessories(platform as never, runtime as never, home as never, holiday as never, publish);
  return { platform, runtime, home, holiday, configure, migrate, Unavailable };
}
function controls() {
  const data = fixture();
  data.configure();
  return { ...data, presence: data.home.services[0].getCharacteristic('on'), holidayControl: data.holiday.services[0].getCharacteristic('on') };
}

describe('Apple Home thermostat programme controls', () => {
  test('does not invent household presence before an initial selection', () => {
    const { presence, holidayControl, Unavailable } = controls();
    expect(() => presence.get!()).toThrow(Unavailable);
    expect(holidayControl.get!()).toBe(false);
  });
  test('routes first-arrival/last-departure switches to household presence', async () => {
    const { presence, runtime } = controls();
    await presence.set!(true); expect(runtime.handle).toHaveBeenLastCalledWith('/presence', { home: true });
    await presence.set!(false); expect(runtime.handle).toHaveBeenLastCalledWith('/presence', { home: false });
  });
  test('routes Holiday on and off through the runtime override', async () => {
    const { holidayControl, runtime } = controls();
    await holidayControl.set!(true); expect(runtime.handle).toHaveBeenLastCalledWith('/holiday', { active: true });
    await holidayControl.set!(false); expect(runtime.handle).toHaveBeenLastCalledWith('/holiday', { active: false });
  });
  test('publishes selection changes from the web editor back to Apple Home', () => {
    const { presence, holidayControl, runtime } = controls();
    runtime.state.anyoneHome = true; runtime.state.holiday = true; runtime.emit('change');
    expect(presence.updateValue).toHaveBeenLastCalledWith(true);
    expect(holidayControl.updateValue).toHaveBeenLastCalledWith(true);
  });
  test('creates separate Home and Holiday switches without changing household state', () => {
    const { home, holiday, runtime } = controls();
    expect(home.displayName).toBe('Heating Home'); expect(holiday.displayName).toBe('Heating Holiday');
    expect(home.services.map(service => service.subtype)).toEqual(['anyone-home']);
    expect(holiday.services.map(service => service.subtype)).toEqual(['holiday']);
    for (const [accessory, name] of [[home, 'Home'], [holiday, 'Holiday']] as const) {
      const service = accessory.services[0];
      expect(service.displayName).toBe(name);
      expect(service.getCharacteristic('name').value).toBe(name);
      expect(service.getCharacteristic('configured-name').value).toBe(name);
      expect(service.getCharacteristic('name')).not.toBe(service.getCharacteristic('on'));
      expect(service.getCharacteristic('configured-name').get).toBeUndefined();
      expect(service.getCharacteristic('configured-name').set).toBeUndefined();
    }
    expect(runtime.handle).not.toHaveBeenCalled();
  });
  test.each([undefined, '', '   '])('migrates missing or blank names (%s) without replacing cached services', value => {
    const data = fixture('split', value === undefined ? {} : { 'anyone-home': value, holiday: value });
    const homeService = data.home.services[0]; const holidayService = data.holiday.services[0];
    data.configure();
    expect(data.home.services[0]).toBe(homeService); expect(data.holiday.services[0]).toBe(holidayService);
    expect(homeService.getCharacteristic('configured-name').value).toBe('Home');
    expect(holidayService.getCharacteristic('configured-name').value).toBe('Holiday');
    expect(data.home.addService).not.toHaveBeenCalled(); expect(data.holiday.addService).not.toHaveBeenCalled();
    expect(data.runtime.handle).not.toHaveBeenCalled();
  });
  test('preserves meaningful user names across reconfiguration and releases old update listeners', () => {
    const data = fixture('split', { 'anyone-home': 'Occupied', holiday: 'Overnight away' });
    const first = data.configure(); const homeService = data.home.services[0];
    homeService.getCharacteristic('configured-name').value = 'Family at home';
    first.forEach(binding => binding.dispose()); data.configure();
    expect(homeService.getCharacteristic('configured-name').value).toBe('Family at home');
    expect(data.holiday.services[0].getCharacteristic('configured-name').value).toBe('Overnight away');
    expect(data.runtime.listenerCount('change')).toBe(2);
    expect(data.runtime.handle).not.toHaveBeenCalled();
  });
  test('preserves meaningful cached parent accessory names as well as switch names', () => {
    const data = fixture('split', { 'anyone-home': 'Occupied', holiday: 'Away overnight' });
    data.home.displayName = 'House occupancy'; data.home.getService().setCharacteristic('name', 'House occupancy');
    data.holiday.displayName = 'Travel programme'; data.holiday.getService().setCharacteristic('name', 'Travel programme');
    data.configure();
    expect(data.home.displayName).toBe('House occupancy');
    expect(data.home.getService().getCharacteristic('name').value).toBe('House occupancy');
    expect(data.holiday.displayName).toBe('Travel programme');
    expect(data.holiday.getService().getCharacteristic('name').value).toBe('Travel programme');
    expect(data.home.services[0].getCharacteristic('configured-name').value).toBe('Occupied');
    expect(data.runtime.handle).not.toHaveBeenCalled();
  });
});

describe('separate Holiday accessory migration', () => {
  test('publishes the replacement before removing legacy Holiday and keeps the original Home service and On identifiers', () => {
    const data = fixture('legacy', { 'anyone-home': 'Occupied', holiday: 'Away overnight' });
    const [homeService, legacy] = data.home.services;
    homeService.iid = 8; homeService.getCharacteristic('on').iid = 10;
    const publish = jest.fn(() => { expect(data.home.services).toContain(legacy); expect(data.holiday.services).toHaveLength(1); });
    const result = data.migrate(publish);
    expect(result.error).toBeUndefined(); expect(publish).toHaveBeenCalledTimes(1);
    expect(data.home.UUID).toBe('stable-home-uuid'); expect(data.home.services).toEqual([homeService]);
    expect(homeService.iid).toBe(8); expect(homeService.getCharacteristic('on').iid).toBe(10);
    expect(homeService.getCharacteristic('configured-name').value).toBe('Occupied');
    expect(data.holiday.services[0].getCharacteristic('configured-name').value).toBe('Away overnight');
    expect(data.runtime.listenerCount('change')).toBe(2);
    expect(data.runtime.handle).not.toHaveBeenCalled();
  });
  test('reuses an already separate Holiday and preserves its own custom name', () => {
    const data = fixture('split', { holiday: 'Holiday mode' });
    const [homeService] = data.home.services; const [holidayService] = data.holiday.services;
    expect(data.migrate().error).toBeUndefined();
    expect(data.home.services).toEqual([homeService]); expect(data.holiday.services).toEqual([holidayService]);
    expect(holidayService.getCharacteristic('configured-name').value).toBe('Holiday mode');
    expect(data.home.addService).not.toHaveBeenCalled(); expect(data.holiday.addService).not.toHaveBeenCalled();
  });
  test('registration failure retains functional legacy Holiday without removing or renaming the Home accessory to Holiday', async () => {
    const data = fixture('legacy'); const legacy = data.home.services[1];
    const result = data.migrate(() => { throw new Error('registration failed'); });
    expect(result.error?.message).toBe('registration failed');
    expect(data.home.services[1]).toBe(legacy); expect(data.home.removeService).not.toHaveBeenCalled();
    expect(data.home.displayName).toBe('Heating Home');
    data.runtime.state.holiday = true; expect(legacy.getCharacteristic('on').get!()).toBe(true);
    expect(data.runtime.handle).not.toHaveBeenCalled();
    await legacy.getCharacteristic('on').set!(false);
    expect(data.runtime.handle).toHaveBeenLastCalledWith('/holiday', { active: false });
  });
  test('failed cache update restores the same functional legacy service at its original position', async () => {
    const data = fixture('legacy'); const original = [...data.home.services]; const legacy = original[1];
    data.platform.api.updatePlatformAccessories.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    const result = data.migrate();
    expect(result.error?.message).toBe('disk unavailable'); expect(data.home.services).toEqual(original);
    expect(data.home.services[1]).toBe(legacy); expect(data.home.addService).toHaveBeenCalledWith(legacy);
    await legacy.getCharacteristic('on').set!(true);
    expect(data.runtime.handle).toHaveBeenLastCalledWith('/holiday', { active: true });
    data.runtime.state.holiday = true; data.runtime.emit('change');
    expect(legacy.getCharacteristic('on').updateValue).toHaveBeenLastCalledWith(true);
  });
  test('replacement configuration failure leaves the legacy Holiday bound to the running runtime', async () => {
    const data = fixture('legacy'); const legacy = data.home.services[1];
    data.holiday.addService.mockImplementation(() => { throw new Error('cannot configure replacement'); });
    const publish = jest.fn(); const result = data.migrate(publish);
    expect(result.error?.message).toBe('cannot configure replacement'); expect(publish).not.toHaveBeenCalled();
    expect(data.home.services[1]).toBe(legacy);
    await legacy.getCharacteristic('on').set!(true);
    expect(data.runtime.handle).toHaveBeenLastCalledWith('/holiday', { active: true });
  });
});
