import EventEmitter from 'events';
import ThermostatProfileAccessory from '../../src/accessory/ThermostatProfileAccessory';

describe('Apple Home thermostat programme controls', () => {
  function create() {
    const characteristics = new Map<string, { get?: () => unknown; set?: (value: boolean) => Promise<void>; updateValue: jest.Mock }>();
    const runtime = Object.assign(new EventEmitter(), {
      instanceId: '0123456789abcdef', state: { anyoneHome: null as boolean | null, holiday: false },
      handle: jest.fn(async () => ({})),
    });
    const information = { setCharacteristic: jest.fn(() => information) };
    const accessory = {
      getService: () => information,
      getServiceById: () => undefined,
      addService: (_type: string, _name: string, subtype: string) => ({
        getCharacteristic: () => {
          const value = { updateValue: jest.fn(), get: undefined, set: undefined };
          characteristics.set(subtype, value);
          const characteristic = {
            onGet: (get: () => unknown) => { Object.assign(value, { get }); return characteristic; },
            onSet: (set: (input: boolean) => Promise<void>) => { Object.assign(value, { set }); return characteristic; },
            updateValue: value.updateValue,
          };
          // A real service returns the same characteristic on subsequent updates.
          return characteristic;
        },
      }),
    };
    // Keep each switch's characteristic stable across update callbacks.
    const services = new Map();
    const add = accessory.addService;
    accessory.addService = (...args) => {
      const service = add(...args);
      const characteristic = service.getCharacteristic();
      service.getCharacteristic = () => characteristic;
      services.set(args[2], service);
      return service;
    };
    class Unavailable extends Error {}
    const platform = { api: { hap: {
      Service: { AccessoryInformation: 'information', Switch: 'switch' },
      Characteristic: { Manufacturer: 'maker', Model: 'model', SerialNumber: 'serial', On: 'on' },
      HapStatusError: Unavailable, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    } } };
    new ThermostatProfileAccessory(platform as never, accessory as never, runtime as never);
    return { characteristics, runtime, Unavailable };
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
});
