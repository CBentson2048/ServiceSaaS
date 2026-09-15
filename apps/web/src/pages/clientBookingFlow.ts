import type { AuthUser, ClientBookingSelection, CommunicationPreference } from '@sheer/domain';

export const CLIENT_BOOKING_STORAGE_KEY = 'sheer.clientBooking.selection';

export function readClientBookingSelection(): ClientBookingSelection | null {
  try {
    const raw = window.sessionStorage.getItem(CLIENT_BOOKING_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ClientBookingSelection) : null;
  } catch {
    return null;
  }
}

export function writeClientBookingSelection(selection: ClientBookingSelection): void {
  window.sessionStorage.setItem(CLIENT_BOOKING_STORAGE_KEY, JSON.stringify(selection));
}

export function updateClientBookingSelection(
  patch: Partial<ClientBookingSelection>,
): ClientBookingSelection | null {
  const current = readClientBookingSelection();
  if (!current) return null;
  const next = { ...current, ...patch };
  writeClientBookingSelection(next);
  return next;
}

export function clearClientBookingSelection(): void {
  window.sessionStorage.removeItem(CLIENT_BOOKING_STORAGE_KEY);
}

/** The client profile a booking is made with, and the preference already on it. */
export interface BookingClient {
  clientProfileId: string;
  communicationPreference?: CommunicationPreference;
}

/**
 * The client profile an already signed-in session can book with at the salon
 * owned by `businessId`, or null when it has none there. A session resolves to
 * one business (the account's highest-role membership), so its client profile
 * is only valid at that business: reused at another salon, the booking is
 * rejected at confirmation, and a staff or owner session has no client profile
 * at all. Either way the customer must sign in for this salon instead.
 */
export function sessionBookingClient(
  user: Pick<AuthUser, 'businessId' | 'clientProfileId' | 'clientCommunicationPreference'>,
  businessId: string | undefined,
): BookingClient | null {
  if (!businessId || user.businessId !== businessId || !user.clientProfileId) return null;
  return {
    clientProfileId: user.clientProfileId,
    communicationPreference: user.clientCommunicationPreference,
  };
}

