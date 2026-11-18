import { PlatformConfig } from 'homebridge';
import { TuyaDeviceSchemaProperty, TuyaDeviceSchemaType } from './device/TuyaDevice';
import type { FastWarmLocalDeviceConfig } from './device/lan/FastWarmLanConfiguration';

export interface TuyaPlatformDeviceSchemaConfig {
  code: string;
  newCode?: string;
  type?: TuyaDeviceSchemaType;
  property?: TuyaDeviceSchemaProperty;
  onGet?: string;
  onSet?: string;
  hidden?: boolean;
  extra?: boolean;
  extraRawSwitch?: Array<TuyaPlatformExtraRawSwitchConfig>;
}

export interface TuyaPlatformDeviceConfig {
  id: string;
  category?: string;
  schema?: Array<TuyaPlatformDeviceSchemaConfig>;
  unbridged?: boolean;
  adaptiveLighting?: boolean;
  addExtraFeaturesAutomatically?: boolean;
  garageDoorUseContactSensorForState?: boolean;
}

export interface TuyaPlatformServiceInformationConfig {
  device_id: string;
  index: number;
  manifacturer?: string;
  model?: string;
  firmwareRevision?: string;
  configuredName?: string;
}

export interface FastWarmProgrammeWriteConfig {
  deviceId: string;
  mode: 'whole-days' | 'grouped-events' | 'grouped-days';
}

export interface FastWarmProgrammeGroupConfig {
  groupId: string;
  deviceIds: string[];
}

export interface TuyaPlatformCustomConfigOptions {
  fastWarmLocalDevices?: FastWarmLocalDeviceConfig[];
  /** Use only vetted local thermostats; no automatic cloud login, discovery or messaging. */
  fastWarmLocalOnly?: boolean;
  projectType: '1';
  endpoint: string;
  accessId: string;
  accessKey: string;
  username: string;
  password: string;
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  serviceInformationOverrides?: Array<TuyaPlatformServiceInformationConfig>;
  generateWeatherAccessory: boolean;
  weatherAPI: string;
  debug?: boolean;
  debugLevel?: string;
  forceIPv4: boolean;
  /** Explicit per-device hardware validation; absent devices retain single-event uploads. */
  fastWarmProgrammeWriteModes?: FastWarmProgrammeWriteConfig[];
  /** Exact existing groups whose programme writes and restoration have been verified on every member. */
  fastWarmProgrammeGroups?: FastWarmProgrammeGroupConfig[];
}

export interface TuyaPlatformHomeConfigOptions {
  fastWarmLocalDevices?: FastWarmLocalDeviceConfig[];
  /** Use only vetted local thermostats; no automatic cloud login, discovery or messaging. */
  fastWarmLocalOnly?: boolean;
  projectType: '2';
  endpoint?: string;
  accessId: string;
  accessKey: string;
  countryCode: number;
  username: string;
  password: string;
  appSchema: string;
  homeWhitelist?: Array<number>;
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  serviceInformationOverrides?: Array<TuyaPlatformServiceInformationConfig>;
  generateWeatherAccessory: boolean;
  weatherAPI: string;
  debug?: boolean;
  debugLevel?: string;
  forceIPv4: boolean;
  /** Explicit per-device hardware validation; absent devices retain single-event uploads. */
  fastWarmProgrammeWriteModes?: FastWarmProgrammeWriteConfig[];
  /** Exact existing groups whose programme writes and restoration have been verified on every member. */
  fastWarmProgrammeGroups?: FastWarmProgrammeGroupConfig[];
}

export interface RTSPCameraConfig {
  deviceId: string;
  deviceName?: string;
  rtspUrl: string;
  username?: string;
  password?: string;
}

export type TuyaPlatformConfigOptions = TuyaPlatformCustomConfigOptions | TuyaPlatformHomeConfigOptions;

export interface TuyaPlatformConfig extends PlatformConfig {
  options: TuyaPlatformConfigOptions;
  cameras?: Array<RTSPCameraConfig>;
}

export const customOptionsSchema = {
  properties: {
    fastWarmLocalOnly: {type: 'boolean'},
    endpoint: { type: 'string', format: 'url', required: true },
    accessId: { type: 'string', required: true },
    accessKey: { type: 'string', required: true },
    deviceOverrides: { 'type': 'array' },
    debug: { type: 'boolean' },
    debugLevel: { 'type': 'string' },
  },
};

export const homeOptionsSchema = {
  properties: {
    fastWarmLocalOnly: {type: 'boolean'},
    accessId: { type: 'string', required: true },
    accessKey: { type: 'string', required: true },
    endpoint: { type: 'string', format: 'url' },
    countryCode: { 'type': 'integer', 'minimum': 1, required: true },
    username: { type: 'string', required: true },
    password: { type: 'string', required: true },
    appSchema: { 'type': 'string', required: true },
    homeWhitelist: { 'type': 'array' },
    deviceOverrides: { 'type': 'array' },
    debug: { type: 'boolean' },
    debugLevel: { 'type': 'string' },
  },
};

/** Reject hidden/inherited flags and getters before validation can read their contents. */
export function parseFastWarmLocalOnlyOption(options: unknown): boolean {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error();
    }
    const own = Object.getOwnPropertyDescriptor(options, 'fastWarmLocalOnly');
    if (!own) {
      if ('fastWarmLocalOnly' in options) {
        throw new Error();
      }
      return false;
    }
    if (!own.enumerable || !Object.hasOwn(own, 'value') || typeof own.value !== 'boolean') {
      throw new Error();
    }
    return own.value;
  } catch {
    throw new Error('FastWarm local-only mode must be an explicit boolean configuration option.');
  }
}

export interface TuyaPlatformExtraRawSwitchConfig {
  configuredName: string;
  notation: string;
  value: string;
  byteIndex: number;
}
