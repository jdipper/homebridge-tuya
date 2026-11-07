import EventEmitter from 'events';
import ThermostatProfileAccessory from '../../src/accessory/ThermostatProfileAccessory';

interface MockCharacteristic {
  value: unknown;
  get?: () => unknown;
  set?: (value: boolean) => Promise<void>;
  onGet: (handler: () => unknown) => MockCharacteristic;
  onSet: (handler: (value: boolean) => Promise<void>) => MockCharacteristic;
  updateValue: jest.Mock;
}

interface MockService {
  displayName: string;
  subtype: string;
  characteristics: Map<string, MockCharacteristic>;
  getCharacteristic: jest.Mock<MockCharacteristic, [string]>;
  testCharacteristic: jest.Mock<boolean, [string]>;
  addOptionalCharacteristic: jest.Mock;
  setCharacteristic: jest.Mock;
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
  const service: MockService = {
    displayName, subtype, characteristics, getCharacteristic,
    testCharacteristic: jest.fn(type => characteristics.has(type)),
    addOptionalCharacteristic: jest.fn(),
    setCharacteristic: jest.fn((type: string, value: unknown) => {
      getCharacteristic(type).value = value;
      return service;
    }),
  };
  service.setCharacteristic('name', displayName);
  return service;
}

describe('Apple Home thermostat programme controls', () => {
  function create(options: { cached?: boolean; configuredNames?: Record<string, string> } = {}) {
    const runtime = Object.assign(new EventEmitter(), {
      instanceId: '0123456789abcdef', state: { anyoneHome: null as boolean | null, holiday: false },
      handle: jest.fn(async () => ({})),
    });
    Object.defineProperties(runtime, {
      householdPresence: { get: () => runtime.state.anyoneHome },
      holidayActive: { get: () => runtime.state.holiday },
    });
    const services = new Map<string, MockService>();
    if (options.cached) {
      for (const subtype of ['anyone-home', 'holiday']) {
        const service = makeService('Heating Programmes', subtype);
        if (Object.prototype.hasOwnProperty.call(options.configuredNames ?? {}, subtype)) {
          service.getCharacteristic('configured-name').value = options.configuredNames![subtype];
        }
        services.set(subtype, service);
      }
    }
    const cachedServices = new Map(services);
    const information = { setCharacteristic: jest.fn(() => information) };
    const accessory = {
      UUID: 'stable-heating-programmes-uuid',
      getService: () => information,
      getServiceById: jest.fn((_type: string, subtype: string) => services.get(subtype)),
      addService: jest.fn((_type: string, name: string, subtype: string) => {
        const service = makeService(name, subtype);
        services.set(subtype, service);
        return service;
      }),
    };
    class Unavailable extends Error {}
    const platform = { api: { hap: {
      Service: { AccessoryInformation: 'information', Switch: 'switch' },
      Characteristic: { Manufacturer: 'maker', Model: 'model', SerialNumber: 'serial', On: 'on', Name: 'name', ConfiguredName: 'configured-name' },
      HapStatusError: Unavailable, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    } } };
    const configure = () => new ThermostatProfileAccessory(platform as never, accessory as never, runtime as never);
    configure();
    const characteristics = new Map([...services].map(([subtype, service]) => [subtype, service.getCharacteristic('on')]));
    return { characteristics, services, cachedServices, accessory, configure, runtime, Unavailable };
  }

  test('does not invent household presence before an initial selection', () => {
    const { characteristics, Unavailable } = create();
    expect(() => characteristics.get('anyone-home')!.get!()).toThrow(Unavailable);
    expect(characteristics.get('holiday')!.get!()).toBe(false);
  });

  test('routes first-arrival/last-departure switches to household presence', async () => {
    const { characteristics, runtime } = create();
    await characteristics.get('anyone-home')!.set!(true);
    expect(runtime.handle).toHaveBeenLastCalledWith('/presence', { home: true });
    await characteristics.get('anyone-home')!.set!(false);
    expect(runtime.handle).toHaveBeenLastCalledWith('/presence', { home: false });
  });

  test('routes Holiday on and off through the runtime override', async () => {
    const { characteristics, runtime } = create();
    await characteristics.get('holiday')!.set!(true);
    expect(runtime.handle).toHaveBeenLastCalledWith('/holiday', { active: true });
    await characteristics.get('holiday')!.set!(false);
    expect(runtime.handle).toHaveBeenLastCalledWith('/holiday', { active: false });
  });

  test('publishes selection changes from the web editor back to Apple Home', () => {
    const { characteristics, runtime } = create();
    runtime.state.anyoneHome = true;
    runtime.state.holiday = true;
    runtime.emit('change');
    expect(characteristics.get('anyone-home')!.updateValue).toHaveBeenLastCalledWith(true);
    expect(characteristics.get('holiday')!.updateValue).toHaveBeenLastCalledWith(true);
  });

  test('advertises distinct Home and Holiday defaults without changing household state', () => {
    const { services, accessory, runtime } = create();
    expect(accessory.addService.mock.calls).toEqual([
      ['switch', 'Home', 'anyone-home'], ['switch', 'Holiday', 'holiday'],
    ]);
    for (const [subtype, label] of [['anyone-home', 'Home'], ['holiday', 'Holiday']]) {
      const service = services.get(subtype)!;
      expect(service.displayName).toBe(label);
      expect(service.getCharacteristic('name').value).toBe(label);
      expect(service.getCharacteristic('configured-name').value).toBe(label);
      expect(service.getCharacteristic('name')).not.toBe(service.getCharacteristic('on'));
      expect(service.getCharacteristic('configured-name').get).toBeUndefined();
      expect(service.getCharacteristic('configured-name').set).toBeUndefined();
    }
    expect(runtime.handle).not.toHaveBeenCalled();
  });

  test.each([undefined, '', '   '])('migrates missing or blank configured names (%s) on the existing switch services', value => {
    const configuredNames = value === undefined ? undefined : { 'anyone-home': value, holiday: value };
    const { services, cachedServices, accessory, runtime } = create({ cached: true, configuredNames });
    expect(accessory.UUID).toBe('stable-heating-programmes-uuid');
    expect(accessory.addService).not.toHaveBeenCalled();
    expect([...services.keys()]).toEqual(['anyone-home', 'holiday']);
    for (const [subtype, label] of [['anyone-home', 'Home'], ['holiday', 'Holiday']]) {
      expect(services.get(subtype)).toBe(cachedServices.get(subtype));
      expect(services.get(subtype)!.subtype).toBe(subtype);
      expect(services.get(subtype)!.getCharacteristic('configured-name').value).toBe(label);
      expect(services.get(subtype)!.getCharacteristic('name').value).toBe(label);
    }
    expect(runtime.handle).not.toHaveBeenCalled();
  });

  test('preserves user-configured names and service objects across reconfiguration', () => {
    const { services, cachedServices, accessory, configure, runtime } = create({ cached: true,
      configuredNames: { 'anyone-home': 'Occupied', holiday: 'Overnight away' } });
    const homeName = services.get('anyone-home')!.getCharacteristic('configured-name');
    const holidayName = services.get('holiday')!.getCharacteristic('configured-name');
    // A later HomeKit rename updates this writable characteristic's cached value.
    homeName.value = 'Family at home';
    configure();
    expect(homeName.value).toBe('Family at home');
    expect(holidayName.value).toBe('Overnight away');
    expect(services.get('anyone-home')).toBe(cachedServices.get('anyone-home'));
    expect(services.get('holiday')).toBe(cachedServices.get('holiday'));
    expect(services.get('anyone-home')!.getCharacteristic('configured-name')).toBe(homeName);
    expect(accessory.addService).not.toHaveBeenCalled();
    expect(runtime.handle).not.toHaveBeenCalled();
  });
});
