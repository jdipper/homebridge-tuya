import TuyaOpenAPI, { TuyaRequestOptions } from '../../core/TuyaOpenAPI';

/** Only opt-in LAN startup is bounded; established cloud request policy is unchanged. */
export default class FastWarmLanBootstrapAPI extends TuyaOpenAPI {
  private bootstrapping = true;

  finishBootstrap(): void {
    this.bootstrapping = false;
  }

  async request(method: string, requestPath: string, params?, body?, options: TuyaRequestOptions = {}) {
    return super.request(method, requestPath, params, body, this.bootstrapping
      ? {attempts: 1, timeoutMs: 10000, ...options} : options);
  }
}
