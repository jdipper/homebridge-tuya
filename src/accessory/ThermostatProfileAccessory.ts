import { PlatformAccessory } from 'homebridge';
import type { TuyaPlatform } from '../platform';
import ThermostatRuntime from '../device/schedule/ThermostatRuntime';

/** Home automations supply household occupancy; Holiday overrides it until explicitly ended. */
export default class ThermostatProfileAccessory {
  constructor(private platform: TuyaPlatform, private accessory: PlatformAccessory, private runtime: ThermostatRuntime) {
    const { Service, Characteristic } = platform.api.hap;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Homebridge Tuya')
      .setCharacteristic(Characteristic.Model, 'Thermostat programme selector')
      .setCharacteristic(Characteristic.SerialNumber, runtime.instanceId);
    const presence = accessory.getServiceById(Service.Switch, 'anyone-home')
      || accessory.addService(Service.Switch, 'Heating Someone Home', 'anyone-home');
    const holiday = accessory.getServiceById(Service.Switch, 'holiday')
      || accessory.addService(Service.Switch, 'Heating Holiday', 'holiday');

    presence.getCharacteristic(Characteristic.On)
      .onGet(() => {
        if (runtime.householdPresence === null) {
          const { HapStatusError, HAPStatus } = platform.api.hap;
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return runtime.householdPresence;
      })
      .onSet(async value => {
        await runtime.handle('/presence', { home: Boolean(value) });
      });
    holiday.getCharacteristic(Characteristic.On)
      .onGet(() => runtime.holidayActive)
      .onSet(async value => {
        await runtime.handle('/holiday', { active: Boolean(value) });
      });

    const update = () => {
      if (runtime.householdPresence !== null) {
        presence.getCharacteristic(Characteristic.On).updateValue(runtime.householdPresence);
      }
      holiday.getCharacteristic(Characteristic.On).updateValue(runtime.holidayActive);
    };
    runtime.on('change', update);
    update();
  }
}
