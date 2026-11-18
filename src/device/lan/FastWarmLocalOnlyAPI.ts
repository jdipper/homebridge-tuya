import TuyaOpenAPI, {TuyaOpenAPIResponse} from '../../core/TuyaOpenAPI';

export const FASTWARM_LOCAL_ONLY_CLOUD_ERROR = 'Cloud requests are disabled in FastWarm local-only mode.';

/** Keep the existing manager interface while denying cloud access before authentication or dispatch. */
export default class FastWarmLocalOnlyAPI extends TuyaOpenAPI {
  async request(...args: Parameters<TuyaOpenAPI['request']>): Promise<TuyaOpenAPIResponse> {
    void args;
    throw new Error(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  }

  async _refreshAccessTokenIfNeed(...args: Parameters<TuyaOpenAPI['_refreshAccessTokenIfNeed']>): Promise<void> {
    void args;
    throw new Error(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  }

  async getToken(): Promise<TuyaOpenAPIResponse> {
    throw new Error(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  }

  async homeLogin(...args: Parameters<TuyaOpenAPI['homeLogin']>): Promise<TuyaOpenAPIResponse> {
    void args;
    throw new Error(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  }

  async customLogin(...args: Parameters<TuyaOpenAPI['customLogin']>): Promise<TuyaOpenAPIResponse> {
    void args;
    throw new Error(FASTWARM_LOCAL_ONLY_CLOUD_ERROR);
  }
}
