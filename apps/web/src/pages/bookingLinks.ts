import { normalizeSalonCode } from '@sheer/domain';

/**
 * Where a customer picks services at one salon. Carries the Salon Code when the
 * location has one, so the address a customer copies from their browser is the
 * same short, shareable form an owner hands out — never the internal id.
 */
export function bookingServicePath(location: { id?: string; salonCode?: string }): string {
  const salonCode = normalizeSalonCode(location.salonCode ?? '');
  if (salonCode) return `/book/service?salonCode=${encodeURIComponent(salonCode)}`;
  if (location.id) return `/book/service?locationId=${encodeURIComponent(location.id)}`;
  return '/book/location';
}

/** The path an owner shares: `/s/K7M2QX` opens that salon's service page. */
export function salonBookingLinkPath(salonCode: string): string {
  return `/s/${encodeURIComponent(normalizeSalonCode(salonCode))}`;
}

/** The full link to share, on whichever site the owner is using (live or local). */
export function salonBookingUrl(origin: string, salonCode: string): string {
  return `${origin.replace(/\/+$/, '')}${salonBookingLinkPath(salonCode)}`;
}
