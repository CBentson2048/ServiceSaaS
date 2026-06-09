import { staffBookingChannel } from '../public-booking/public-booking.service';

/**
 * Staff (internal) booking.
 *
 * The pure source→channel mapping is asserted directly. The behavioural
 * contracts that need the (not-yet-built) Supabase Jest harness are recorded as
 * `it.todo`, matching the repo convention in public-booking.service.spec.ts.
 */
describe('staffBookingChannel', () => {
  it('maps walk-in to the walk_in channel', () => {
    expect(staffBookingChannel('walk_in')).toBe('walk_in');
  });

  it('maps phone bookings to the phone channel', () => {
    expect(staffBookingChannel('phone_booking')).toBe('phone');
  });

  it('maps manual staff bookings to the staff_app channel', () => {
    expect(staffBookingChannel('staff_booking')).toBe('staff_app');
  });
});

describe('StaffBookingService — permissions', () => {
  it.todo('rejects client-role actors before reaching the booking engine');
  it.todo('owner can book at any location in the business');
  it.todo('manager/stylist can only book within their allowed location scope');
  it.todo('rejects booking a client whose home location is outside the actor scope');
  it.todo('allows booking an unscoped (walk-in) client into a location the actor manages');
  it.todo('quick-create client is restricted to owner/manager (delegated to CrmService)');
});

describe('StaffBookingService — booking engine reuse', () => {
  it.todo('availability + conflict detection reuse the public rota-based engine (no second engine)');
  it.todo('multi-service duration stacks correctly into appointment_services rows');
  it.todo('rejects a slot that is no longer available (engine + DB no-overlap guard)');
  it.todo('persists booking source onto booking_channel and metadata.source');
  it.todo('persists internal_note without exposing it to the client');
  it.todo('records payment_mode in metadata without forcing the Stripe deposit path');
  it.todo('schedules a confirmation via the shared notification pipeline when sendConfirmation is not false');
  it.todo('skips confirmation scheduling when sendConfirmation is false');
  it.todo('links a stylist rebooking outcome when the client has an eligible completed visit');
});
