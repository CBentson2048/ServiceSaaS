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
  it.todo('specific stylist returns slots for only that stylist');
  it.todo('next available returns the earliest valid slots across eligible stylists');
});

describe('PublicBookingService — appointment creation', () => {
  it.todo('client account context is required before creating an appointment');
  it.todo('appointment creation revalidates the selected slot before insert');
  it.todo('appointment creation rejects if the slot became unavailable');
  it.todo('appointment creation derives duration and price from booking.services');
  it.todo('appointment creation persists communication preference on appointment and client profile');
  it.todo('appointment creation remains deposit-ready through deposit_required_amount');
  it.todo('appointment creation does not create or pretend to complete a live payment');
});
