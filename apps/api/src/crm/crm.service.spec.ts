/**
 * CRM service — test scaffold.
 *
 * The repo currently records service-level coverage targets with `it.todo`
 * until the Supabase chain-mocking harness is in place.
 */
describe('CrmService — permissions and search', () => {
  it.todo('owner can search clients across the business by name, phone, and email');
  it.todo('manager searches only clients in assigned locations');
  it.todo('manager cannot read another location client detail');
  it.todo('stylist can only read clients from assigned scope or own appointment history');
  it.todo('client role is rejected from every CRM staff endpoint');
});

describe('CrmService — client records', () => {
  it.todo('owner or manager can create a manual CRM client profile');
  it.todo('client profile update persists editable contact and communication fields');
  it.todo('notes persist with author and optional visit linkage');
  it.todo('allergy records persist active severity data for alerting');
  it.todo('patch tests expose expired status from status and expires_at');
  it.todo('message logs are read from comms.message_logs instead of a duplicate table');
  it.todo('visit photos require visit and client linkage');
  it.todo('client-visible visit summaries do not expose formula ingredients or product costs');
});
