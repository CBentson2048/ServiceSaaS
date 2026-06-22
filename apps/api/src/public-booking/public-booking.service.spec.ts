/**
 * Public booking flow — test scaffold.
 *
 * The current repo pattern records required service cases as `it.todo`
 * until the Jest data harness exists.
 */
describe('PublicBookingService — availability', () => {
  it.todo('availability uses rota.shifts as the source of bookable time');
  it.todo('availability uses the sum of selected services estimated_duration_minutes as appointment length');
  it.todo('availability uses location appointment_slot_minutes only as start increments');
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
