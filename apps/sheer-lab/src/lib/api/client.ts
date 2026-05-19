import { createApiClient } from '@sheer/api-client';

import { appConfig } from '../../config/appConfig';
import { getStoredAccessToken } from '../storage/sessionStorage';

export const sheerApiClient = createApiClient({
  baseUrl: appConfig.apiBaseUrl,
  getAccessToken: getStoredAccessToken,
});

export type SheerApiClient = typeof sheerApiClient;
