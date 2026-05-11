/**
 * Public booking flow — test scaffold.
 *
 * The current repo pattern records required service cases as `it.todo`
 * until the Jest data harness exists.
 */
describe('PublicBookingService — availability', () => {
  it.todo('availability uses rota.shifts as the source of bookable time');
  it.todo('availability uses service estimated_duration_minutes as appointment length');
  it.todo('availability uses location appointment_slot_minutes only as start increments');
  it.todo('shift breaks remove otherwise-valid slots');
  it.todo('approved leave removes otherwise-valid slots');
  it.todo('absence events remove otherwise-valid slots');
  it.todo('existing active appointments block overlapping slots');
  it.todo('pending non-expired booking attempts block overlapping slots during checkout');
  it.todo('specific stylist returns slots for only that stylist');
  it.todo('next available returns the earliest valid slots across eligible stylists');
});

describe('PublicBookingService — payment-backed checkout', () => {
  it.todo('start checkout requires linked client account context');
  it.todo('start checkout revalidates the selected slot before creating a booking attempt');
  it.todo('start checkout rejects if the slot became unavailable');
  it.todo('start checkout derives duration, price, and deposit from booking.services');
  it.todo('start checkout persists communication preference and phone on client/user profiles');
  it.todo('start checkout creates a pending booking_attempt and pending booking.deposits row');
  it.todo('start checkout creates a Stripe PaymentIntent with booking metadata and idempotency');
  it.todo('successful payment finalizes one confirmed appointment and appointment service');
  it.todo('failed payment marks attempt/deposit failed and creates no appointment');
  it.todo('webhook replay does not duplicate appointments or deposit rows');
});
