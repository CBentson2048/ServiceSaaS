import type {
  AppointmentStatus,
  InventoryLocationStock,
  SheerLabAnalyticsResponse,
  StaffBookingSummary,
} from '@sheer/domain';

/**
 * Pure, side-effect-free helpers + view-model derivations for the QLOOQO Lab
 * dashboard. Everything here maps real backend data onto the dashboard panels —
 * no placeholder or random values are introduced.
 */

// A client is "in the chair" (an active session) once they are checked in or
// the colour is being mixed. Earlier statuses are upcoming, not active.
const ACTIVE_STATUSES: AppointmentStatus[] = ['checked_in', 'in_progress'];

// `today` for a lab session never returns terminal 'completed', so the
// post-service states (billing sent / settled) are what "Completed today"
// shows. 'completed' is included defensively in case the source ever widens.
const COMPLETED_STATUSES: AppointmentStatus[] = ['awaiting_payment', 'paid', 'completed'];

export function isActiveBooking(booking: StaffBookingSummary): boolean {
  return ACTIVE_STATUSES.includes(booking.status);
}

export function isCompletedBooking(booking: StaffBookingSummary): boolean {
  return COMPLETED_STATUSES.includes(booking.status);
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand';

export function completedStatusBadge(status: AppointmentStatus): { label: string; tone: StatusTone } {
  switch (status) {
    case 'paid':
      return { label: 'Paid', tone: 'success' };
    case 'completed':
      return { label: 'Completed', tone: 'success' };
    case 'awaiting_payment':
      return { label: 'Billing sent', tone: 'warning' };
    default:
      return { label: humanizeStatus(status), tone: 'neutral' };
  }
}

export function activeStatusBadge(status: AppointmentStatus): { label: string; tone: StatusTone } {
  switch (status) {
    case 'in_progress':
      return { label: 'Mixing', tone: 'brand' };
    case 'checked_in':
      return { label: 'Checked in', tone: 'success' };
    default:
      return { label: humanizeStatus(status), tone: 'neutral' };
  }
}

export function humanizeStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ----- Inventory tiers -------------------------------------------------------

export type InventoryTierKey = 'critical' | 'low' | 'warning' | 'ok';

export interface InventoryTier {
  key: InventoryTierKey;
  label: string;
  tone: StatusTone;
}

export function getInventoryTier(item: InventoryLocationStock): InventoryTier {
  const qty = item.quantityOnHandGrams;
  const threshold = item.effectiveLowStockThresholdGrams;

  if (qty <= 0) return { key: 'critical', label: 'Critical', tone: 'danger' };
  if (threshold > 0 && qty <= threshold * 0.5) return { key: 'critical', label: 'Critical', tone: 'danger' };
  if (item.isLowStock || (threshold > 0 && qty <= threshold)) return { key: 'low', label: 'Low', tone: 'warning' };
  if (threshold > 0 && qty <= threshold * 1.5) return { key: 'warning', label: 'Warning', tone: 'warning' };
  return { key: 'ok', label: 'In stock', tone: 'success' };
}

const TIER_ORDER: Record<InventoryTierKey, number> = { critical: 0, low: 1, warning: 2, ok: 3 };

/**
 * Most-urgent stock first (critical → low → warning → ok), then lowest quantity.
 * Lets the panel surface what needs restocking without dropping healthy items
 * when there is room to show them.
 */
export function sortStockForDisplay(stock: InventoryLocationStock[], limit = 6): InventoryLocationStock[] {
  return [...stock]
    .sort((a, b) => {
      const tierDelta = TIER_ORDER[getInventoryTier(a).key] - TIER_ORDER[getInventoryTier(b).key];
      if (tierDelta !== 0) return tierDelta;
      return a.quantityOnHandGrams - b.quantityOnHandGrams;
    })
    .slice(0, limit);
}

/**
 * A relative fill (0–1) for the stock bar, using the low-stock threshold as the
 * half-way mark. Purely a visual indicator derived from the real quantity — it
 * is not a claimed "percent of capacity" (capacity is not tracked).
 */
export function stockFill(item: InventoryLocationStock): number {
  const threshold = item.effectiveLowStockThresholdGrams;
  if (threshold <= 0) return item.quantityOnHandGrams > 0 ? 1 : 0;
  return clamp(item.quantityOnHandGrams / (threshold * 2), 0, 1);
}

// ----- Analytics -------------------------------------------------------------

/**
 * Grams across the top products used today. The analytics summary exposes no
 * single "total grams" field — only the top-by-weight products (the backend
 * caps this list, currently at 8) — so this is the sum of those. It is real
 * usage data; the UI labels it as "top products" rather than an exact grand
 * total so a very high-variety day is not over-claimed.
 */
export function sumProductUsageGrams(analytics: SheerLabAnalyticsResponse): number {
  return analytics.mostUsedProductsByWeight.reduce((total, product) => total + product.totalWeightGrams, 0);
}

// ----- Formatting ------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

export function formatMoney(cents: number, currencyCode = 'GBP'): string {
  if (!Number.isFinite(cents)) return '—';
  const symbol = CURRENCY_SYMBOLS[currencyCode] ?? `${currencyCode} `;
  const amount = Math.round(cents) / 100;
  const [whole, fraction] = amount.toFixed(2).split('.');
  return `${symbol}${withThousands(whole)}.${fraction}`;
}

export function formatGrams(grams: number): string {
  if (!Number.isFinite(grams)) return '—';
  return `${withThousands(String(Math.round(grams)))} g`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatTimeOfDay(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatRelativeTime(iso?: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function roleLabel(role: 'owner' | 'manager' | 'stylist'): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'manager':
      return 'Manager';
    default:
      return 'Stylist';
  }
}

function withThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
