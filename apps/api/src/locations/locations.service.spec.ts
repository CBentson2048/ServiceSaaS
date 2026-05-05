/**
 * Location management — test scaffold.
 *
 * Mirrors the staff invitations pattern (apps/api/src/staff/staff.service.spec.ts).
 * The repo's Jest config is currently `--passWithNoTests`; these `it.todo`
 * entries record the test cases that should be written when a Jest harness
 * lands so the Phase 1 scope cannot regress unnoticed.
 *
 * When implementing:
 *   - mock SupabaseClient `.schema().from().select()/.insert()/.update()` chains.
 *   - cover guard rails: assertOwner, assertManagerOrOwner, allowedLocationIds.
 *   - cover slug normalisation + uniqueness conflicts.
 *   - cover deactivate/reactivate setting `is_active` only.
 */

describe('LocationsService — reads', () => {
  it.todo('owner sees every active+inactive location in their business, sorted by sort_order then name');
  it.todo('manager sees only the location(s) referenced by allowedLocationIds');
  it.todo('manager with no allowedLocationIds gets an empty list (no DB query)');
  it.todo('stylist/client get 403 on /locations');
  it.todo('owner can fetch any location in their business by id');
  it.todo('manager can fetch only their own location id; foreign id returns 403');
  it.todo('foreign business id always returns 404 (cross-business leakage)');
});

describe('LocationsService — owner writes', () => {
  it.todo('owner can create a location with minimal payload (name+slug)');
  it.todo('timezone falls back to business default when omitted');
  it.todo('country code falls back to business default + uppercased');
  it.todo('slug is normalised before uniqueness check (uppercase/whitespace input)');
  it.todo('duplicate slug within the same business returns 409');
  it.todo('generated code collision returns a friendly 409');
  it.todo('manager / stylist / client cannot POST /owner/locations (403)');
});

describe('LocationsService — owner updates', () => {
  it.todo('owner can rename a location');
  it.todo('owner can change slug; uniqueness check ignores the same row');
  it.todo('cannot blank out NOT NULL fields (name, slug, timezone)');
  it.todo('owner can clear optional fields by sending null (phone, email, address_line_2, region)');
  it.todo('owner cannot update a location belonging to a different business (404)');
  it.todo('manager cannot PATCH /owner/locations/:id (403)');
});

describe('LocationsService — deactivate / reactivate', () => {
  it.todo('deactivate sets is_active=false and bumps updated_at');
  it.todo('reactivate sets is_active=true and bumps updated_at');
  it.todo('deactivate is owner-only');
  it.todo('deactivate of an unknown location returns 404');
});
