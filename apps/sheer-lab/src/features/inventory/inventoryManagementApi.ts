import type {
  AdjustInventoryStockRequest,
  CreateInventoryCategoryRequest,
  InitializeInventoryStockRequest,
  InventoryCategoryResponse,
  InventoryProductResponse,
  InventoryStockMutationResponse,
  ListInventoryCategoriesResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
  UpdateInventoryStockThresholdRequest,
  UpsertInventoryProductRequest,
} from '@sheer/domain';

import { appConfig } from '../../config/appConfig';

// Owner/manager-only inventory management for the qlooqo-lab station. These hit
// the `/lab/inventory/session/:sessionId/manage/*` endpoints, which delegate to
// the same InventoryService the web dashboard uses — the API enforces the
// owner/manager gate and pins every stock mutation to the station's location.

const base = (sessionId: string) =>
  `${appConfig.apiBaseUrl}/lab/inventory/session/${encodeURIComponent(sessionId)}/manage`;

export async function listManagedProducts(
  sessionId: string,
  params: { q?: string; includeInactive?: boolean } = {},
): Promise<ListInventoryProductsResponse> {
  return getJson(`${base(sessionId)}/products${toQueryString({ q: params.q, includeInactive: params.includeInactive })}`, 'products');
}

export async function listManagedStock(
  sessionId: string,
  params: { q?: string; lowStockOnly?: boolean } = {},
): Promise<ListInventoryStockResponse> {
  return getJson(`${base(sessionId)}/stock${toQueryString({ q: params.q, lowStockOnly: params.lowStockOnly })}`, 'stock');
}

export async function listManagedMovements(
  sessionId: string,
  params: { productId?: string; limit?: number } = {},
): Promise<ListInventoryMovementsResponse> {
  return getJson(`${base(sessionId)}/movements${toQueryString({ productId: params.productId, limit: params.limit })}`, 'stock movements');
}

export async function listManagedLowStock(sessionId: string): Promise<ListInventoryLowStockResponse> {
  return getJson(`${base(sessionId)}/low-stock`, 'low-stock alerts');
}

export async function listManagedCategories(
  sessionId: string,
  params: { q?: string; includeInactive?: boolean } = {},
): Promise<ListInventoryCategoriesResponse> {
  return getJson(`${base(sessionId)}/categories${toQueryString({ q: params.q, includeInactive: params.includeInactive })}`, 'categories');
}

export async function createManagedProduct(
  sessionId: string,
  payload: UpsertInventoryProductRequest,
): Promise<InventoryProductResponse> {
  return sendJson(`${base(sessionId)}/products`, 'POST', payload, 'create product');
}

export async function updateManagedProduct(
  sessionId: string,
  productId: string,
  payload: UpsertInventoryProductRequest,
): Promise<InventoryProductResponse> {
  return sendJson(`${base(sessionId)}/products/${encodeURIComponent(productId)}`, 'PATCH', payload, 'update product');
}

export async function archiveManagedProduct(sessionId: string, productId: string): Promise<InventoryProductResponse> {
  return sendJson(`${base(sessionId)}/products/${encodeURIComponent(productId)}/archive`, 'POST', undefined, 'archive product');
}

export async function createManagedCategory(
  sessionId: string,
  payload: CreateInventoryCategoryRequest,
): Promise<InventoryCategoryResponse> {
  return sendJson(`${base(sessionId)}/categories`, 'POST', payload, 'create category');
}

export async function initializeManagedStock(
  sessionId: string,
  payload: InitializeInventoryStockRequest,
): Promise<InventoryStockMutationResponse> {
  return sendJson(`${base(sessionId)}/stock/initialize`, 'POST', payload, 'initialize stock');
}

export async function adjustManagedStock(
  sessionId: string,
  payload: AdjustInventoryStockRequest,
): Promise<InventoryStockMutationResponse> {
  return sendJson(`${base(sessionId)}/stock/adjust`, 'POST', payload, 'adjust stock');
}

export async function updateManagedStockThreshold(
  sessionId: string,
  stockId: string,
  payload: UpdateInventoryStockThresholdRequest,
): Promise<InventoryStockMutationResponse> {
  return sendJson(`${base(sessionId)}/stock/${encodeURIComponent(stockId)}`, 'PATCH', payload, 'update threshold');
}

async function getJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(messageForStatus(response.status, `load ${label}`));
  return (await response.json()) as T;
}

async function sendJson<T>(url: string, method: 'POST' | 'PATCH', body: unknown, label: string): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(messageForStatus(response.status, label));
  return (await response.json()) as T;
}

function messageForStatus(status: number, action: string): string {
  if (status === 401) return 'Your lab session has expired. Please sign in again.';
  if (status === 403) return 'Inventory management is limited to owners and managers.';
  return `Could not ${action} (${status})`;
}

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && String(value).trim().length > 0)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `?${query}` : '';
}
