/**
 * R2 Future Booking (locked U-5). Generated at 2026-09-16T10:00:00Z; visits on
 * London's 14 Sep.
 *
 * CLIENT  eligible visit (stylist)          future appointments (after generation)         counts
 *   C1    paid (Alice)                      pending                                         headline
 *   C2    completed (Alice)                 accepted                                        headline + confirmed
 *   C3    awaiting payment (Ben)            rejected · cancelled · no-show                  —
 *   C4    paid (Ben)                        checked-in · paid (future start)                — (not pending/accepted)
 *   C5    two visits (Alice and Ben)        pending                                         headline, ONE client
 *   C6    paid (Alice)                      pending at Other with Gil                       headline
 *   C7    paid (Ben)                        accepted starting exactly at generation         —
 *   C8    paid (Ben)                        accepted 1µs after generation                   headline + confirmed
 *   C9    checked in only (not eligible)    pending                                         not in the population
 *   C10   paid (no stylist)                 none                                            —
 *   C11   paid (Alice)                      its own appointment, still accepted in future   — (own appointment)
 * London: 10 clients · headline 5 (5000 bp) · confirmed 2 (2000 bp)
 *   Alice 5 clients (C1 C2 C5 C6 C11): headline 4 · confirmed 1
 *   Ben   5 clients (C3 C4 C5 C7 C8):  headline 2 · confirmed 1
 *   Unattributed 1 client: 0
 *   Σ staff clients = 11 ≠ 10: staff figures are never summed into the total.
 */
import type { TeamReportBody, TeamStaffRow } from '@sheer/domain';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { instant as at } from '../money/testing/money-scope';
import { TeamReportService } from './team-report.service';
import { MemoryTeamSource, teamScope, type AppointmentStatus, type TeamLedger, type VisitStatus } from './testing/memory-team-source';
import { ALICE, AS_OF, BEN, BIZ, DAY, GIL, LOCATIONS, LONDON, OTHER, teamLedger, uid } from './testing/team-fixture';

const client = (n: number) => `50000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const C = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`C${i + 1}`, client(i + 1)])) as Record<string, string>;

function ledger(): TeamLedger {
  const base = teamLedger();
  const visit = (clientId: string, staff: string | null, status: VisitStatus = 'paid', appointmentId: string | null = null) =>
    base.visits.push({ id: uid(), businessId: BIZ, locationId: LONDON, status, completedAt: at('2026-09-14T12:00:00Z'), appointmentId, clientProfileId: clientId, primaryStaffProfileId: staff });
  const appointment = (clientId: string, status: AppointmentStatus, start: string, locationId = LONDON, staff: string | null = ALICE, id = uid()) => {
    base.appointments.push({ id, businessId: BIZ, locationId, clientProfileId: clientId, staffProfileId: staff, status, startAt: at(start), endAt: at('2026-09-30T12:00:00Z'), occupiedRanges: '{}' });
    return id;
  };
  visit(C.C1, ALICE);
  appointment(C.C1, 'pending', '2026-09-20T10:00:00Z');
  visit(C.C2, ALICE, 'completed');
  appointment(C.C2, 'accepted', '2026-09-21T10:00:00Z');
  visit(C.C3, BEN, 'awaiting_payment');
  appointment(C.C3, 'rejected', '2026-09-20T10:00:00Z');
  appointment(C.C3, 'cancelled', '2026-09-20T11:00:00Z');
  appointment(C.C3, 'no_show', '2026-09-20T12:00:00Z');
  visit(C.C4, BEN);
  appointment(C.C4, 'checked_in', '2026-09-16T10:30:00Z');
  appointment(C.C4, 'paid', '2026-09-16T11:30:00Z');
  visit(C.C5, ALICE);
  visit(C.C5, BEN);
  appointment(C.C5, 'pending', '2026-09-25T10:00:00Z');
  visit(C.C6, ALICE);
  appointment(C.C6, 'pending', '2026-09-22T10:00:00Z', OTHER, GIL);
  visit(C.C7, BEN);
  appointment(C.C7, 'accepted', '2026-09-16T10:00:00Z');
  visit(C.C8, BEN);
  appointment(C.C8, 'accepted', '2026-09-16T10:00:00.000001Z');
  visit(C.C9, ALICE, 'checked_in');
  appointment(C.C9, 'pending', '2026-09-20T10:00:00Z');
  visit(C.C10, null);
  const own = appointment(C.C11, 'accepted', '2026-09-23T10:00:00Z');
  visit(C.C11, ALICE, 'paid', own);
  // Another business's appointment for the same client id is never read.
  base.appointments.push({ id: uid(), businessId: 'biz-2', locationId: LONDON, clientProfileId: C.C10, staffProfileId: null, status: 'accepted', startAt: at('2026-09-20T10:00:00Z'), endAt: at('2026-09-20T11:00:00Z') });
  return base;
}

const EMPTY_MONEY: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [], locations: [] };

async function build(staffProfileIds: string[] = []): Promise<{ body: TeamReportBody; team: MemoryTeamSource }> {
  const team = new MemoryTeamSource(ledger());
  const body = await new TeamReportService(new MemoryMoneySource(EMPTY_MONEY), team).build(teamScope(BIZ, LOCATIONS, { ...DAY, staffProfileIds }, AS_OF));
  return { body, team };
}

const ratio = (numerator: number, denominator: number) => ({ availability: 'available', numerator, denominator, basisPoints: Math.round((numerator * 10000) / denominator) });
const count = (n: number) => ({ availability: 'available', count: n });
const rowFor = (body: TeamReportBody, key: string): TeamStaffRow => body.staffRows.find((row) => row.rowKey === `${LONDON}:${key}`)!;

describe('R2 Future Booking', () => {
  it('London: distinct clients, pending or accepted for the headline, accepted for confirmed-only', async () => {
    const { body } = await build();
    const london = body.locations.find((location) => location.locationId === LONDON)!.totals.futureBooking;
    expect(london).toEqual({ clientsSeen: count(10), withFutureBooking: ratio(5, 10), withConfirmedFutureBooking: ratio(2, 10) });
    expect(body.summary.futureBooking).toEqual(london);
  });

  it('per stylist: the qualifying visit’s stylist; a client seen by two stylists counts for each, and once in the total', async () => {
    const { body } = await build();
    expect(rowFor(body, ALICE).metrics.futureBooking).toEqual({ clientsSeen: count(5), withFutureBooking: ratio(4, 5), withConfirmedFutureBooking: ratio(1, 5) });
    expect(rowFor(body, BEN).metrics.futureBooking).toEqual({ clientsSeen: count(5), withFutureBooking: ratio(2, 5), withConfirmedFutureBooking: ratio(1, 5) });
    expect(rowFor(body, 'unattributed').metrics.futureBooking).toEqual({ clientsSeen: count(1), withFutureBooking: ratio(0, 1), withConfirmedFutureBooking: ratio(0, 1) });
    const summed = body.staffRows
      .filter((row) => row.locationId === LONDON)
      .reduce((total, row) => total + (row.metrics.futureBooking.clientsSeen.availability === 'available' ? row.metrics.futureBooking.clientsSeen.count : 0), 0);
    expect(summed).toBe(11);
  });

  it('a Selected staff subtotal counts distinct clients across the selection', async () => {
    const { body } = await build([ALICE, BEN]);
    expect(body.selectedStaff!.futureBooking).toEqual({ clientsSeen: count(9), withFutureBooking: ratio(5, 9), withConfirmedFutureBooking: ratio(2, 9) });
  });

  it('no clients seen: the percentages are unavailable, never 0%', async () => {
    const { body } = await build();
    const other = body.locations.find((location) => location.locationId === OTHER)!.totals.futureBooking;
    expect(other).toEqual({
      clientsSeen: count(0),
      withFutureBooking: { availability: 'unavailable', reason: 'no_clients_seen' },
      withConfirmedFutureBooking: { availability: 'unavailable', reason: 'no_clients_seen' },
    });
  });

  it('is as at the generation instant, in each location’s local clock — and reads only appointments after it, in this business', async () => {
    const { body, team } = await build();
    expect(body.generatedAt).toBe('2026-09-16T10:00:00.000Z');
    expect(body.locations.map((location) => location.futureBookingAsAt)).toEqual([
      { localDate: '2026-09-16', localTime: '11:00' },
      { localDate: '2026-09-16', localTime: '11:00' },
    ]);
    const reads = team.reads.filter((read) => read.method === 'futureAppointments');
    // Every read (the keyset continues until an empty page) is this business, strictly after generation.
    expect(new Set(reads.map((read) => `${read.businessId}|${read.afterInstant}`))).toEqual(new Set([`${BIZ}|2026-09-16T10:00:00.000000Z`]));
    expect(new Set(reads.flatMap((read) => read.ids))).toEqual(new Set([C.C1, C.C2, C.C3, C.C4, C.C5, C.C6, C.C7, C.C8, C.C10, C.C11]));
  });
});
