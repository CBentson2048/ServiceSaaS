/**
 * Public booking flow — test scaffold.
 *
 * The current repo pattern records required service cases as `it.todo`
 * until the Jest data harness exists. `availableSlotsInShift` is pure and
 * exported, so the slot-stepping behaviour is tested directly.
 */
import { availableSlotsInShift, bookingLocationLookup } from './public-booking.service';
describe('PublicBookingService — availability', () => {
  it.todo('availability uses rota.shifts as the source of bookable time');
  it.todo('availability uses the sum of selected services estimated_duration_minutes as appointment length');

  it('steps slot starts by appointment_slot_minutes anchored to the shift start', () => {
    const shift = {
      id: 'shift_1',
      staff_profile_id: 'staff_1',
      scheduled_start_at: '2026-08-10T09:15:00.000Z',
      scheduled_end_at: '2026-08-10T12:00:00.000Z',
    };
    const start = new Date(shift.scheduled_start_at);
    const end = new Date(shift.scheduled_end_at);
    // A plain 60-minute service fully occupies the stylist for its whole span.
    const fullyOccupied = [{ startMs: 0, endMs: 60 * 60_000 }];

    // 60-minute slots on a 09:15 shift start at 09:15, not the next clock
    // hour — the epoch-anchored grid this replaces offered 10:00 first and
    // silently discarded the shift's opening 45 minutes.
    const hourly = availableSlotsInShift(
      start, end, shift, [], [], [], [], 60, fullyOccupied, 60, false,
    );
    expect(hourly.map((slot) => slot.toISOString())).toEqual([
      '2026-08-10T09:15:00.000Z',
      '2026-08-10T10:15:00.000Z',
    ]);

    // 15-minute slots: every quarter step from the shift start whose full
    // duration still fits before the shift end (09:15 → 11:00 inclusive).
    const quarterly = availableSlotsInShift(
      start, end, shift, [], [], [], [], 60, fullyOccupied, 15, false,
    );
    expect(quarterly[0].toISOString()).toBe('2026-08-10T09:15:00.000Z');
    expect(quarterly[1].toISOString()).toBe('2026-08-10T09:30:00.000Z');
    expect(quarterly).toHaveLength(8);

    // A mid-shift search window still lands on the shift-anchored grid: the
    // first slot at or after 10:05 on a 09:15 + n×30 grid is 10:15.
    const midDay = availableSlotsInShift(
      new Date('2026-08-10T10:05:00.000Z'), end, shift, [], [], [], [], 60, fullyOccupied, 30, false,
    );
    expect(midDay[0].toISOString()).toBe('2026-08-10T10:15:00.000Z');
  });
  it.todo('shift breaks remove otherwise-valid slots');
  it.todo('approved leave removes otherwise-valid slots');
  it.todo('absence events remove otherwise-valid slots');
  it.todo('existing active appointments block overlapping slots');
  it.todo('pending non-expired booking attempts block overlapping slots during checkout');
  it.todo('specific stylist returns slots for only that stylist');
  it.todo('next available returns the earliest valid slots across eligible stylists using stacked duration');
});

describe('PublicBookingService — payment-backed checkout', () => {
  it.todo('start checkout requires linked client account context');
  it.todo('start checkout revalidates the selected slot before creating a booking attempt');
  it.todo('start checkout rejects if the slot became unavailable');
  it.todo('start checkout derives duration, price, and deposit from all selected booking.services');
  it.todo('start checkout rejects service combinations that violate mandatory finishing-service rules');
  it.todo('start checkout persists communication preference and phone on client/user profiles');
  it.todo('start checkout creates a pending booking_attempt, booking_attempt_services rows, and pending booking.deposits row');
  it.todo('start checkout creates a Stripe PaymentIntent with booking metadata and idempotency');
  it.todo('successful payment finalizes one confirmed appointment and one appointment service per selected service');
  it.todo('failed payment marks attempt/deposit failed and creates no appointment');
  it.todo('webhook replay does not duplicate appointments or deposit rows');
});

describe('PublicBookingService — service rules and upgrades', () => {
  it.todo('selection returns owner-configured mandatory finishing-service rules for the location');
  it.todo('selection returns owner-configured upgrade suggestions for selected trigger services');
});

describe('PublicBookingService — deposit payment methods', () => {
  it.todo('deposit PaymentIntent omits payment_method_types so Stripe dynamic payment methods remain dashboard-controlled');
});

describe('PublicBookingService — per-stylist service pricing', () => {
  // applyStylistServicePricing runs inside resolveBookingContext, so it covers
  // every charge path that funnels through it (public checkout, mobile, staff
  // booking) and the totals derived from context.services. price_amount NULL on
  // booking.staff_service_eligibility inherits services.base_price.
  it.todo('overrides startingPriceAmount with the stylist price_amount when one is set');
  it.todo('falls back to services.base_price when the stylist has no price_amount (NULL)');
  it.todo('applies different prices for the same service across two stylists');
  it.todo('overridden price flows into appointment_services.price_amount and the booking total');
  it.todo('getStylists / getAvailability browsing still show the base "from" price');
});

describe('PublicBookingService — naming the booking location', () => {
  const LOCATION_ID = '0b3c7d6e-3f5a-4a8b-9c1d-2e3f4a5b6c7d';

  it('resolves a shared link by Salon Code, whatever case or spacing it was typed in', () => {
    expect(bookingLocationLookup({ salonCode: 'K7M2QX' })).toEqual({
      by: 'salonCode',
      salonCode: 'K7M2QX',
    });
    expect(bookingLocationLookup({ salonCode: ' k7m-2qx ' })).toEqual({
      by: 'salonCode',
      salonCode: 'K7M2QX',
    });
  });

  it('prefers the exact location id, then the Salon Code, then the slugs', () => {
    expect(
      bookingLocationLookup({
        locationId: LOCATION_ID,
        salonCode: 'K7M2QX',
        businessSlug: 'loh',
        locationSlug: 'leeds',
      }),
    ).toEqual({ by: 'id', locationId: LOCATION_ID });
    expect(
      bookingLocationLookup({ salonCode: 'K7M2QX', businessSlug: 'loh', locationSlug: 'leeds' }),
    ).toEqual({ by: 'salonCode', salonCode: 'K7M2QX' });
    expect(bookingLocationLookup({ businessSlug: 'loh', locationSlug: 'leeds' })).toEqual({
      by: 'slugs',
      businessSlug: 'loh',
      locationSlug: 'leeds',
    });
  });

  it('names no location when nothing usable was given', () => {
    expect(bookingLocationLookup({})).toBeNull();
    // Punctuation only normalises to an empty code, which must not match anything.
    expect(bookingLocationLookup({ salonCode: '--' })).toBeNull();
    expect(bookingLocationLookup({ businessSlug: 'loh' })).toBeNull();
  });
});
