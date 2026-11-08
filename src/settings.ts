// eslint-disable-next-line
// @ts-ignore
import { pluginAlias as platformName } from '../config.schema.json';

// eslint-disable-next-line
// @ts-ignore
import { name as pluginName } from '../package.json';

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = platformName;

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = pluginName;

/** Keep household control UUIDs stable when installing the separately named fork. */
export const THERMOSTAT_PROFILE_UUID_NAMESPACE = '@homebridge-plugins/homebridge-tuya';
