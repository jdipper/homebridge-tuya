import { PlatformAccessory } from 'homebridge';
import type { TuyaPlatform } from '../platform';
import ThermostatRuntime from '../device/schedule/ThermostatRuntime';

export type ThermostatProfileRole = 'home' | 'holiday';

/** One independently displayed switch; Holiday takes priority over remembered presence. */
export default class ThermostatProfileAccessory {
  private readonly update: () => void;

  constructor(private platform: TuyaPlatform, private accessory: PlatformAccessory, private runtime: ThermostatRuntime,
    role: ThermostatProfileRole, options: { nameAccessory?: boolean; configuredName?: string } = {}) {
    const { Service, Characteristic } = platform.api.hap;
    const name = role === 'home' ? 'Home' : 'Holiday';
    const subtype = role === 'home' ? 'anyone-home' : 'holiday';
    if (options.nameAccessory !== false) {
      const information = accessory.getService(Service.AccessoryInformation)!;
      information.setCharacteristic(Characteristic.Manufacturer, 'Homebridge Tuya')
        .setCharacteristic(Characteristic.Model, 'Thermostat programme selector')
        .setCharacteristic(Characteristic.SerialNumber, role === 'home' ? runtime.instanceId : `${runtime.instanceId}-holiday`);
      const defaults = new Set(['Heating Programmes', 'Heating Home', 'Heating Holiday']);
      const parentName = accessory.displayName.trim() && !defaults.has(accessory.displayName) ? accessory.displayName : `Heating ${name}`;
      accessory.displayName = parentName;
      const informationName = information.getCharacteristic(Characteristic.Name).value;
      if (typeof informationName !== 'string' || !informationName.trim() || defaults.has(informationName)) {
        information.setCharacteristic(Characteristic.Name, parentName);
      }
    }
    const service = accessory.getServiceById(Service.Switch, subtype) || accessory.addService(Service.Switch, name, subtype);
    service.displayName = name;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    const configuredName = service.getCharacteristic(Characteristic.ConfiguredName).value;
    if (typeof configuredName !== 'string' || !configuredName.trim()) {
      service.setCharacteristic(Characteristic.ConfiguredName, options.configuredName || name);
    }
    service.getCharacteristic(Characteristic.On)
      .onGet(() => {
        if (role === 'home' && runtime.householdPresence === null) {
          const { HapStatusError, HAPStatus } = platform.api.hap;
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return role === 'home' ? runtime.householdPresence! : runtime.holidayActive;
      })
      .onSet(async value => {
        await runtime.handle(role === 'home' ? '/presence' : '/holiday', role === 'home'
          ? { home: Boolean(value) } : { active: Boolean(value) });
      });
    this.update = () => {
      if (role === 'holiday' || runtime.householdPresence !== null) {
        service.getCharacteristic(Characteristic.On).updateValue(role === 'home' ? runtime.householdPresence! : runtime.holidayActive);
      }
    };
    runtime.on('change', this.update);
    try {
      this.update();
    } catch (error) {
      runtime.off('change', this.update);
      throw error;
    }
  }

  dispose() {
    this.runtime.off('change', this.update);
  }
}

/** Publish the replacement before retiring the old Holiday service; failures retain working controls. */
export function configureThermostatProfileAccessories(platform: TuyaPlatform, runtime: ThermostatRuntime,
  home: PlatformAccessory, holiday: PlatformAccessory, publish: () => void): {
    bindings: ThermostatProfileAccessory[]; error?: Error;
  } {
  const { Service, Characteristic } = platform.api.hap;
  const legacy = home.getServiceById(Service.Switch, 'holiday');
  const legacyIndex = legacy ? home.services.indexOf(legacy) : -1;
  const legacyName = legacy?.testCharacteristic(Characteristic.ConfiguredName)
    ? legacy.getCharacteristic(Characteristic.ConfiguredName).value : undefined;
  const bindings: ThermostatProfileAccessory[] = [];
  try {
    bindings.push(new ThermostatProfileAccessory(platform, home, runtime, 'home'));
    // A cached service has no restored handlers. Bind it until replacement publication succeeds.
    const legacyBinding = legacy ? new ThermostatProfileAccessory(platform, home, runtime, 'holiday', { nameAccessory: false }) : undefined;
    if (legacyBinding) {
      bindings.push(legacyBinding);
    }
    bindings.push(new ThermostatProfileAccessory(platform, holiday, runtime, 'holiday', {
      configuredName: typeof legacyName === 'string' && legacyName.trim() ? legacyName : undefined,
    }));
    publish();
    if (legacy) {
      try {
        home.removeService(legacy);
        platform.api.updatePlatformAccessories([home]);
      } catch (error) {
        if (!home.services.includes(legacy)) {
          home.addService(legacy);
          const restoredIndex = home.services.indexOf(legacy);
          if (legacyIndex >= 0 && restoredIndex !== legacyIndex) {
            home.services.splice(restoredIndex, 1);
            home.services.splice(legacyIndex, 0, legacy);
          }
        }
        // The in-memory fallback remains usable even if storage is unavailable.
        try {
          platform.api.updatePlatformAccessories([home]);
        } catch { /* Report the original migration failure. */ }
        throw error;
      }
      legacyBinding!.dispose();
      bindings.splice(bindings.indexOf(legacyBinding!), 1);
    }
    return { bindings };
  } catch (error) {
    return { bindings, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
