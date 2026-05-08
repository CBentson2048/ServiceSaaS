import type { ClientBookingSelection } from '@sheer/domain';

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
