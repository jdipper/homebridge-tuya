'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const PLUGIN = '@jdipper/homebridge-tuya';
const MAX_CONFIG_BYTES = 1024 * 1024;
const ERROR_MESSAGE = 'Local connection setup is unavailable. Check Tuya settings and Homebridge file permissions.';

function unavailable() { return new Error(ERROR_MESSAGE); }

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

/** Keep field ordering and omitted undefined values identical to platform.programmeInstanceId(). */
function instanceIdForPlatform(platform) {
  try {
    const options = platform.options;
    return createHash('sha256').update(JSON.stringify({
      projectType: options.projectType, endpoint: options.endpoint, accessId: options.accessId,
      username: options.username, bridge: platform._bridge?.username ?? platform.name,
    })).digest('hex').slice(0, 16);
  } catch { throw unavailable(); }
}

function configuredDevices(configuration, parseDevices) {
  try {
    if (!record(configuration) || !Array.isArray(configuration.platforms)) { throw unavailable(); }
    const devices = [], instances = new Set();
    for (const platform of configuration.platforms) {
      if (!record(platform) || platform.platform !== 'TuyaPlatform'
        || platform.plugin !== undefined && platform.plugin !== PLUGIN) { continue; }
      if (!record(platform.options)) { continue; }
      const local = parseDevices(platform.options.fastWarmLocalDevices);
      if (!local.length) { continue; }
      const instanceId = instanceIdForPlatform(platform);
      if (instances.has(instanceId)) { throw unavailable(); }
      instances.add(instanceId);
      for (const device of local) {
        devices.push({instanceId, deviceId: device.deviceId, address: device.address,
          version: device.version, enabled: device.enabled !== false});
      }
    }
    return devices;
  } catch { throw unavailable(); }
}

function contextPaths(context) {
  if (typeof context.storagePath !== 'string' || !path.isAbsolute(context.storagePath)
    || context.storagePath.includes('\0') || context.storagePath.split(path.sep).includes('..')) { throw unavailable(); }
  const configPath = context.configPath ?? path.join(context.storagePath, 'config.json');
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath) || configPath.includes('\0')
    || configPath.split(path.sep).includes('..')) { throw unavailable(); }
  return {configPath, persistPath: path.join(context.storagePath, 'persist')};
}

async function readConfiguration(configPath) {
  try {
    if (!constants.O_NOFOLLOW) { throw unavailable(); }
    const parent = await fs.lstat(path.dirname(configPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o022
      || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) { throw unavailable(); }
    const handle = await fs.open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CONFIG_BYTES || info.mode & 0o022
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())) { throw unavailable(); }
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let length = 0;
      while (length <= MAX_CONFIG_BYTES) {
        const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) { break; }
        length += bytesRead;
      }
      if (length > MAX_CONFIG_BYTES) { throw unavailable(); }
      return JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } finally { await handle.close(); }
  } catch { throw unavailable(); }
}

function createLocalSetupHandlers(context, dependencies) {
  // Tests inject the same TypeScript helper; installed Homebridge uses the compiled module.
  const helpers = () => dependencies ?? require('../dist/device/lan/FastWarmLanConfiguration');
  async function selected() {
    const {configPath, persistPath} = contextPaths(context);
    const configuration = await readConfiguration(configPath);
    return {persistPath, devices: configuredDevices(configuration, helpers().parseFastWarmLocalDevices)};
  }
  return {
    '/local/devices': async payload => {
      try {
        if (payload !== undefined && (!record(payload) || Reflect.ownKeys(payload).length)) { throw unavailable(); }
        const {persistPath, devices} = await selected();
        return {devices: await Promise.all(devices.map(async device => ({...device,
          keyStored: await new (helpers().FastWarmLanKeyStore)(persistPath, device.instanceId).has(device.deviceId),
        })))};
      } catch { throw unavailable(); }
    },
    '/local/key': async payload => {
      try {
        if (!record(payload) || Reflect.ownKeys(payload).sort().join(',') !== 'deviceId,instanceId,localKey'
          || typeof payload.instanceId !== 'string' || !/^[a-f0-9]{16}$/.test(payload.instanceId)
          || typeof payload.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.deviceId)
          || typeof payload.localKey !== 'string' || !/^[\x20-\x7e]{16}$/.test(payload.localKey)) { throw unavailable(); }
        const {persistPath, devices} = await selected();
        const matches = devices.filter(device => device.instanceId === payload.instanceId && device.deviceId === payload.deviceId);
        if (matches.length !== 1) { throw unavailable(); }
        await new (helpers().FastWarmLanKeyStore)(persistPath, payload.instanceId).set(payload.deviceId, payload.localKey);
        return {stored: true, restartRequired: true};
      } catch { throw unavailable(); }
    },
  };
}

async function start() {
  const {HomebridgePluginUiServer, RequestError} = await import('@homebridge/plugin-ui-utils');
  class TuyaLocalSetupUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      const handlers = createLocalSetupHandlers({storagePath: this.homebridgeStoragePath, configPath: this.homebridgeConfigPath});
      for (const [route, handler] of Object.entries(handlers)) {
        this.onRequest(route, async payload => {
          try { return await handler(payload); }
          catch { throw new RequestError(ERROR_MESSAGE, {status: 400}); }
        });
      }
      this.ready();
    }
  }
  new TuyaLocalSetupUiServer();
}

module.exports = {ERROR_MESSAGE, instanceIdForPlatform, configuredDevices, readConfiguration, createLocalSetupHandlers};
if (require.main === module) {
  start().catch(() => {
    console.error('The Tuya local setup page could not start.');
    process.exitCode = 1;
  });
}
