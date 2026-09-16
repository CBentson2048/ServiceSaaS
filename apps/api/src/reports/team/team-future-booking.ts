/**
 * R2 Future Booking. Pure — no I/O, no clock.
 *
 * Population: the distinct clients with an eligible visit (completed, awaiting
 * payment or paid) in scope. A client counts when they hold at least one
 * appointment starting after the generation instant — pending or accepted for
 * the headline, accepted for confirmed-only — anywhere in the business and with
 * anyone. It is as at generation only: never "as at the end of the period".
 *
 * Distinct-client arithmetic: a client seen twice, or seen by two stylists, is one
 * client in any total that covers both visits. Staff and location figures are
 * never summed or averaged into a total; every total counts its own distinct set.
 * docs/V1.1/week-8-r2-team.md §5.
 */
import type { StaffKey } from './team-money';
import type { EligibleVisitRow, FutureAppointmentRow } from './team-source';

export interface FutureBookingIndex {
  /** Clients per (location, staff key). */
  clientsByLocationStaff: Map<string, Map<StaffKey, Set<string>>>;
  withFuture: Set<string>;
  withConfirmedFuture: Set<string>;
}

export interface FutureBookingCounts {
  clientsSeen: number;
  withFutureBooking: number;
  withConfirmedFutureBooking: number;
}

/**
 * `future` must already be restricted to the population's clients, starting after
 * the generation instant, pending or accepted. The qualifying visits' own
 * appointments are never a future booking.
 */
export function indexFutureBooking(visits: readonly EligibleVisitRow[], future: readonly FutureAppointmentRow[]): FutureBookingIndex {
  const clientsByLocationStaff = new Map<string, Map<StaffKey, Set<string>>>();
  const ownAppointments = new Set<string>();
  for (const visit of visits) {
    if (visit.appointmentId !== null) ownAppointments.add(visit.appointmentId);
    const byStaff = clientsByLocationStaff.get(visit.locationId) ?? new Map<StaffKey, Set<string>>();
    const clients = byStaff.get(visit.primaryStaffProfileId) ?? new Set<string>();
    clients.add(visit.clientProfileId);
    byStaff.set(visit.primaryStaffProfileId, clients);
    clientsByLocationStaff.set(visit.locationId, byStaff);
  }
  const withFuture = new Set<string>();
  const withConfirmedFuture = new Set<string>();
  for (const appointment of future) {
    if (ownAppointments.has(appointment.id)) continue;
    withFuture.add(appointment.clientProfileId);
    if (appointment.status === 'accepted') withConfirmedFuture.add(appointment.clientProfileId);
  }
  return { clientsByLocationStaff, withFuture, withConfirmedFuture };
}

/** Every staff key with an eligible visit at the location. */
export function futureBookingStaffKeys(index: FutureBookingIndex, locationId: string): Set<StaffKey> {
  return new Set(index.clientsByLocationStaff.get(locationId)?.keys() ?? []);
}

/**
 * Counts over the distinct clients of the given (location, staff keys) cells.
 * `keys` null means every staff key (the location or team total).
 */
export function futureBookingCounts(
  index: FutureBookingIndex,
  locationIds: readonly string[],
  keys: ReadonlySet<StaffKey> | null,
): FutureBookingCounts {
  const clients = new Set<string>();
  for (const locationId of locationIds) {
    for (const [key, cell] of index.clientsByLocationStaff.get(locationId) ?? []) {
      if (keys !== null && !keys.has(key)) continue;
      for (const client of cell) clients.add(client);
    }
  }
  let withFutureBooking = 0;
  let withConfirmedFutureBooking = 0;
  for (const client of clients) {
    if (index.withFuture.has(client)) withFutureBooking += 1;
    if (index.withConfirmedFuture.has(client)) withConfirmedFutureBooking += 1;
  }
  return { clientsSeen: clients.size, withFutureBooking, withConfirmedFutureBooking };
}
