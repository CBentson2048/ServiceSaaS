import type { ListInventoryProductsResponse } from '@sheer/domain';

import { appConfig } from '../../config/appConfig';

export async function listLabInventoryProducts(
  sessionId: string,
  params: { q?: string; category?: string } = {},
): Promise<ListInventoryProductsResponse> {
  const response = await fetch(
    `${appConfig.apiBaseUrl}/lab/inventory/session/${encodeURIComponent(sessionId)}/products${toQueryString(params)}`,
  );

  if (!response.ok) {
    throw new Error(`Could not load inventory products (${response.status})`);
  }

  return (await response.json()) as ListInventoryProductsResponse;
}

function toQueryString(params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value.trim().length > 0)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}`)
    .join('&');

  return query ? `?${query}` : '';
}
