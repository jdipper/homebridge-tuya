'use strict';

// The plugin remains CommonJS. The UI SDK is ESM; load it in this small wrapper
// rather than changing the module format of the Homebridge runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const ROUTES = [
  '/thermostats', '/schedules/read', '/schedules/apply', '/profiles/save', '/presence', '/holiday',
  '/controls/settings', '/rooms/save', '/rooms/refresh', '/presence/hold', '/overrides/preview', '/overrides/start',
  '/overrides/cancel', '/profiles/history', '/profiles/restore', '/history', '/temperatures/history',
  '/controls/recover',
];
const PLUGIN = require('../package.json').name;

async function discover(storagePath) {
  const persistPath = path.join(storagePath, 'persist');
  let files;
  try {
    files = await fs.readdir(persistPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw new Error('The Homebridge runtime discovery directory could not be read.');
  }
  const descriptors = await Promise.all(files
    .filter(name => /^TuyaRuntime\.[a-f0-9]{16}\.json$/.test(name))
    .map(async name => {
      try {
        const file = path.join(persistPath, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384
          || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
          return null;
        }
        const descriptor = JSON.parse(await fs.readFile(file, 'utf8'));
        if (descriptor.version !== 1 || descriptor.plugin !== PLUGIN
          || typeof descriptor.instanceId !== 'string' || !/^[a-f0-9]{16}$/.test(descriptor.instanceId)
          || name !== `TuyaRuntime.${descriptor.instanceId}.json`
          || typeof descriptor.socketPath !== 'string'
          || typeof descriptor.token !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.token)
          || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) {
          return null;
        }
        const expectedSocket = process.platform === 'win32'
          ? `\\\\.\\pipe\\homebridge-tuya-${descriptor.instanceId}`
          : path.join(persistPath, `tuya-${descriptor.instanceId}.sock`);
        if (descriptor.socketPath !== expectedSocket) {
          return null;
        }
        return descriptor;
      } catch {
        // A runtime can be restarting while discovery is in progress. Never log
        // a descriptor: it contains the private runtime authentication token.
        return null;
      }
    }));
  return descriptors.filter(Boolean);
}

function requestRuntime(descriptor, requestPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 1024 * 1024) {
      reject(new Error('The schedule request is too large.'));
      return;
    }
    const request = http.request({
      socketPath: descriptor.socketPath,
      path: requestPath,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) {
          request.destroy(new Error('The runtime returned too much schedule data.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('The heating runtime connection was interrupted.')));
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = typeof result.error === 'string' ? result.error
              : typeof result.message === 'string' ? result.message : 'The heating runtime rejected the request.';
            reject(new Error(message));
            return;
          }
          resolve(result);
        } catch {
          reject(new Error('The heating runtime returned an invalid response.'));
        }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('The heating runtime did not respond.')));
    request.on('error', error => {
      const availableMessage = ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(error.code)
        ? 'The heating runtime is unavailable. Start or restart the Tuya child bridge, then refresh.' : error.message;
      reject(new Error(availableMessage));
    });
    request.end(body);
  });
}

async function start() {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class TuyaScheduleUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/instances', async () => {
        const descriptors = await discover(this.homebridgeStoragePath);
        return { instances: descriptors.map(descriptor => ({ id: descriptor.instanceId })) };
      });
      for (const requestPath of ROUTES) {
        this.onRequest(requestPath, async payload => {
          try {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
              throw new Error('The schedule request must be an object.');
            }
            const descriptors = await discover(this.homebridgeStoragePath);
            const descriptor = payload.instanceId
              ? descriptors.find(item => item.instanceId === payload.instanceId)
              : descriptors.length === 1 ? descriptors[0] : undefined;
            if (!descriptor) {
              throw new Error(descriptors.length > 1
                ? 'Choose the Tuya instance to manage.'
                : 'No heating runtime was found. Start the Tuya child bridge, then refresh.');
            }
            const { instanceId, ...body } = payload;
            return await requestRuntime(descriptor, requestPath, body);
          } catch (error) {
            // RequestError prevents the SDK from dumping an error stack into the
            // host log. Tokens and the descriptor never cross the browser boundary.
            throw new RequestError(error.message || 'The heating controller is unavailable.', { status: 503 });
          }
        });
      }
      this.ready();
    }
  }

  new TuyaScheduleUiServer();
}

start().catch(() => {
  console.error('The Tuya schedule editor could not start. Check that its UI dependency is installed.');
  process.exitCode = 1;
});
