/**
 * R2 utilisation assembler (locked U-10): the shared formula over each location's
 * LOCAL days. Booked and available minutes add up across staff-days; nothing is
 * capped; leave removes a day only where it was recorded, and leave recorded at
 * another location leaves that staff-day's utilisation unstated.
 */
import type { TeamReportBody } from '@sheer/domain';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { instant as at } from '../money/testing/money-scope';
import { TeamReportService } from './team-report.service';
import { assembleUtilisation, type UtilisationFacts, type UtilisationWindow } from './team-utilisation';
import type { AbsenceRow, BookedAppointmentRow, LeaveRow, ShiftBreakRow, ShiftRow } from './team-source';
import { MemoryTeamSource, teamScope, type TeamLedger } from './testing/memory-team-source';
import { AS_OF, BEN, BIZ, DAY, EVE, LOCATIONS, LONDON, OTHER, teamLedger, uid } from './testing/team-fixture';

const NEW_YORK = '20000000-0000-4000-8000-0000000000a1';
const TOKYO = '20000000-0000-4000-8000-0000000000a2';
const STYLIST = '30000000-0000-4000-8000-0000000000aa';

const shift = (locationId: string, start: string, end: string, staffProfileId = STYLIST): ShiftRow => ({ id: uid(), locationId, staffProfileId, startAt: at(start), endAt: at(end) });
const booked = (locationId: string, start: string, end: string, staffProfileId = STYLIST, occupiedRanges: string | null = null): BookedAppointmentRow => ({
  id: uid(),
  locationId,
  staffProfileId,
  startAt: at(start),
  endAt: at(end),
  occupiedRanges,
});
const facts = (partial: Partial<UtilisationFacts>): UtilisationFacts => ({ shifts: [], breaks: [], absences: [], bookOutTypes: [], leave: [], appointments: [], ...partial });
const window = (locationId: string, timezone: string, from: string, to = from): UtilisationWindow => ({ locationId, timezone, from, to });
const minutes = (ms: number) => ms / 60_000;

describe('R2 utilisation assembler: location-local days', () => {
  it('London (BST): a 09:00–17:00 local shift with a lunch break and two booked hours', () => {
    const s = shift(LONDON, '2026-09-14T08:00:00Z', '2026-09-14T16:00:00Z');
    const lunch: ShiftBreakRow = { id: uid(), shiftId: s.id, startAt: at('2026-09-14T11:00:00Z'), endAt: at('2026-09-14T12:00:00Z') };
    const result = assembleUtilisation([window(LONDON, 'Europe/London', '2026-09-14')], facts({ shifts: [s], breaks: [lunch], appointments: [booked(LONDON, '2026-09-14T09:00:00Z', '2026-09-14T11:00:00Z')] }));
    const cell = result.byLocationStaff.get(LONDON)!.get(STYLIST)!;
    expect([minutes(cell.availableMs), minutes(cell.bookedMs), cell.ambiguous]).toEqual([420, 120, false]);
  });

  it('New York (EDT): a booking across local midnight counts on each local day; the slice with no rota is reported, not counted', () => {
    const result = assembleUtilisation(
      [window(NEW_YORK, 'America/New_York', '2026-09-14', '2026-09-15')],
      facts({
        shifts: [shift(NEW_YORK, '2026-09-14T13:00:00Z', '2026-09-14T21:00:00Z')],
        // 16:30–18:00 local (after the shift: booked time is not bounded by the shift) and 23:30–00:30 local.
        appointments: [booked(NEW_YORK, '2026-09-14T20:30:00Z', '2026-09-14T22:00:00Z'), booked(NEW_YORK, '2026-09-15T03:30:00Z', '2026-09-15T04:30:00Z')],
      }),
    );
    const cell = result.byLocationStaff.get(NEW_YORK)!.get(STYLIST)!;
    expect([minutes(cell.availableMs), minutes(cell.bookedMs)]).toEqual([480, 120]);
    expect(result.dataQuality.bookedWithoutRota).toBe(1);
  });

  it('Tokyo: a morning shift that crosses UTC midnight is one local day, and same-location leave on that local date removes all of it', () => {
    const tokyoShift = shift(TOKYO, '2026-09-14T23:00:00Z', '2026-09-15T03:00:00Z'); // 08:00–12:00 JST, 15 Sep
    const leave: LeaveRow = { id: uid(), locationId: TOKYO, staffProfileId: STYLIST, startDate: '2026-09-15', endDate: '2026-09-15' };
    const withoutLeave = assembleUtilisation([window(TOKYO, 'Asia/Tokyo', '2026-09-15')], facts({ shifts: [tokyoShift] }));
    expect(minutes(withoutLeave.byLocationStaff.get(TOKYO)!.get(STYLIST)!.availableMs)).toBe(240);
    const onLeave = assembleUtilisation([window(TOKYO, 'Asia/Tokyo', '2026-09-15')], facts({ shifts: [tokyoShift], leave: [leave] }));
    // A UTC-day assembler would leave the 23:00–00:00Z hour; the local day is removed whole.
    expect(onLeave.byLocationStaff.get(TOKYO)!.get(STYLIST)!).toEqual({ availableMs: 0, bookedMs: 0, ambiguous: false });
  });

  it('London autumn DST day: a 00:30–03:30 local shift through the repeated hour is four hours', () => {
    const result = assembleUtilisation(
      [window(LONDON, 'Europe/London', '2026-10-25')],
      facts({ shifts: [shift(LONDON, '2026-10-24T23:30:00Z', '2026-10-25T03:30:00Z')] }),
    );
    expect(minutes(result.byLocationStaff.get(LONDON)!.get(STYLIST)!.availableMs)).toBe(240);
    // And nothing of it belongs to 24 Oct.
    const dayBefore = assembleUtilisation([window(LONDON, 'Europe/London', '2026-10-24')], facts({ shifts: [shift(LONDON, '2026-10-24T23:30:00Z', '2026-10-25T03:30:00Z')] }));
    expect(dayBefore.byLocationStaff.size).toBe(0);
  });

  it('over 100% stays visible: two booked hours on a one-hour shift', () => {
    const result = assembleUtilisation(
      [window(LONDON, 'Europe/London', '2026-09-14')],
      facts({ shifts: [shift(LONDON, '2026-09-14T08:00:00Z', '2026-09-14T09:00:00Z')], appointments: [booked(LONDON, '2026-09-14T08:00:00Z', '2026-09-14T10:00:00Z')] }),
    );
    const cell = result.byLocationStaff.get(LONDON)!.get(STYLIST)!;
    expect([minutes(cell.availableMs), minutes(cell.bookedMs)]).toEqual([60, 120]);
  });

  it('book-outs: a reducing type and an untyped legacy row reduce; a non-reducing type does not; occupied ranges win over the span', () => {
    const lunchType = { id: uid(), reducesAvailableHours: true };
    const trainingType = { id: uid(), reducesAvailableHours: false };
    const absence = (start: string, end: string | null, bookOutTypeId: string | null): AbsenceRow => ({ id: uid(), locationId: LONDON, staffProfileId: STYLIST, startAt: at(start), endAt: end === null ? null : at(end), bookOutTypeId });
    const result = assembleUtilisation(
      [window(LONDON, 'Europe/London', '2026-09-14')],
      facts({
        shifts: [shift(LONDON, '2026-09-14T08:00:00Z', '2026-09-14T16:00:00Z')],
        bookOutTypes: [lunchType, trainingType],
        absences: [
          absence('2026-09-14T11:00:00Z', '2026-09-14T12:00:00Z', lunchType.id),
          absence('2026-09-14T12:00:00Z', '2026-09-14T13:00:00Z', trainingType.id),
          absence('2026-09-14T15:30:00Z', null, null),
        ],
        appointments: [booked(LONDON, '2026-09-14T08:00:00Z', '2026-09-14T10:00:00Z', STYLIST, '{["2026-09-14 08:00:00+00","2026-09-14 08:45:00+00")}')],
      }),
    );
    const cell = result.byLocationStaff.get(LONDON)!.get(STYLIST)!;
    // 480 − 60 (lunch) − 30 (open-ended legacy book-out) = 390; training stays available; occupied 45 of the 120-minute span.
    expect([minutes(cell.availableMs), minutes(cell.bookedMs)]).toEqual([390, 45]);
  });
});

describe('R2 utilisation in the report', () => {
  function ledger(extra: (ledger: TeamLedger) => void): TeamLedger {
    const base = teamLedger();
    extra(base);
    return base;
  }
  const EMPTY_MONEY: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [], locations: [] };
  const build = (team: TeamLedger, locations = LOCATIONS, staffProfileIds: string[] = []): Promise<TeamReportBody> =>
    new TeamReportService(new MemoryMoneySource(EMPTY_MONEY), new MemoryTeamSource(team)).build(teamScope(BIZ, locations, { ...DAY, staffProfileIds }, AS_OF));

  const multiLocation = (withCrossLocationLeave: boolean) =>
    ledger((l) => {
      l.shifts.push(
        { ...shift(LONDON, '2026-09-14T08:00:00Z', '2026-09-14T12:00:00Z', BEN), businessId: BIZ },
        { ...shift(OTHER, '2026-09-14T13:00:00Z', '2026-09-14T17:00:00Z', BEN), businessId: BIZ },
      );
      l.appointments.push({ id: uid(), businessId: BIZ, locationId: LONDON, clientProfileId: uid(), staffProfileId: BEN, status: 'accepted', startAt: at('2026-09-14T09:00:00Z'), endAt: at('2026-09-14T10:00:00Z'), occupiedRanges: null });
      if (withCrossLocationLeave) {
        l.leave.push({ id: uid(), businessId: BIZ, locationId: LONDON, staffProfileId: BEN, startDate: '2026-09-14', endDate: '2026-09-14', status: 'approved' });
      }
    });

  it('a multi-location stylist has a figure at each location from that location’s own rota and bookings', async () => {
    const body = await build(multiLocation(false));
    const at = (locationId: string) => body.staffRows.find((row) => row.rowKey === `${locationId}:${BEN}`)!.metrics.utilisation;
    expect(at(LONDON)).toEqual({
      availableMinutes: { availability: 'available', count: 240 },
      bookedMinutes: { availability: 'available', count: 60 },
      utilisation: { availability: 'available', numerator: 60, denominator: 240, basisPoints: 2500 },
    });
    expect(at(OTHER).utilisation).toEqual({ availability: 'available', numerator: 0, denominator: 240, basisPoints: 0 });
    expect(body.summary.utilisation.utilisation).toEqual({ availability: 'available', numerator: 60, denominator: 480, basisPoints: 1250 });
  });

  it('no rostered time: utilisation is unavailable, never 0% — for a member with no activity too', async () => {
    const body = await build(multiLocation(false));
    const eve = body.staffRows.find((row) => row.rowKey === `${LONDON}:${EVE}`)!;
    expect(eve.metrics.utilisation).toEqual({
      availableMinutes: { availability: 'available', count: 0 },
      bookedMinutes: { availability: 'available', count: 0 },
      utilisation: { availability: 'unavailable', reason: 'no_rostered_time' },
    });
  });

  it('leave recorded at another location: that staff-day is not guessed — the row, its location and the team read unavailable', async () => {
    const body = await build(multiLocation(true));
    const ambiguous = { availability: 'unavailable', reason: 'leave_location_ambiguous' };
    const benAt = (locationId: string) => body.staffRows.find((row) => row.rowKey === `${locationId}:${BEN}`)!.metrics.utilisation;
    // London: the leave was recorded there, so the London day is removed.
    expect(benAt(LONDON).availableMinutes).toEqual({ availability: 'available', count: 0 });
    expect(benAt(OTHER)).toEqual({ availableMinutes: ambiguous, bookedMinutes: ambiguous, utilisation: ambiguous });
    expect(body.locations.find((location) => location.locationId === OTHER)!.totals.utilisation.utilisation).toEqual(ambiguous);
    expect(body.summary.utilisation.utilisation).toEqual(ambiguous);
    expect(body.dataQuality.leaveAtAnotherLocation).toBe(1);
  });

  it('a location’s figures do not depend on which other locations are selected', async () => {
    const both = await build(multiLocation(true));
    const londonOnly = await build(multiLocation(true), [LOCATIONS[0]]);
    const otherOnly = await build(multiLocation(true), [LOCATIONS[1]]);
    const totals = (body: TeamReportBody, locationId: string) => body.locations.find((location) => location.locationId === locationId)!.totals.utilisation;
    expect(totals(londonOnly, LONDON)).toEqual(totals(both, LONDON));
    expect(totals(otherOnly, OTHER)).toEqual(totals(both, OTHER));
  });
});
