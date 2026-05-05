# Locations — Phase 1 (owner CRUD + manager read-own)

This document captures the **intentionally narrow** first slice of location
management. It builds on top of the data model that
[Owner onboarding](./owner-onboarding.md) already creates (a single seed
`core.locations` row per business) and slots into the same auth + nav stack
used by [Staff invitations](./staff-invitations.md).

## Scope (and non-scope)

In-scope this phase:

- Owner can list, create, edit, deactivate, and reactivate the locations of
  their business.
- Owner can open a per-location detail page.
- Manager can open the detail page of **their assigned location only**.
- Detail page is intentionally a placeholder; full settings (hours, services,
  payments, calendar rules) land in a follow-up phase.

Out of scope this phase:

- No hard delete (use deactivate / reactivate instead).
- No staff invitation flow here — that lives at `/team` and stays unchanged.
- No detailed per-location settings forms.
- No manager-level mutation of any kind. Manager is read-only.

Owner is business-wide; manager is location-scoped. That product invariant is
mirrored in the API guards, the routing, and the sidebar.

## Database

No new schema. We use the existing `core.locations` table created in
`supabase/migrations/0003_core_foundation.sql`:

- `(business_id, slug)` and `(business_id, code)` are unique.
- `is_active boolean default true` is the deactivate / reactivate flag — there
  is no hard delete in product.
- `address_line_1`, `city`, `postal_code`, `timezone`, `country_code` are
  `NOT NULL` in the schema. The Phase 1 form treats them as optional; the API
  pads missing values with empty strings on create (matching the same trick the
  onboarding RPC uses) so we don't need a migration to relax `NOT NULL` yet.

## Backend (NestJS)

Module: `apps/api/src/locations/`

| Method & path                                  | Auth     | Purpose |
| ---------------------------------------------- | -------- | ------- |
| `GET    /api/locations`                        | owner    | List every location in the business |
| `GET    /api/locations`                        | manager  | List only the location(s) referenced by `auth.allowedLocationIds` |
| `GET    /api/locations/:id`                    | owner    | Fetch any location in the business |
| `GET    /api/locations/:id`                    | manager  | Fetch only locations in `auth.allowedLocationIds` (else 403) |
| `POST   /api/owner/locations`                  | owner    | Create a location (slug uniqueness enforced) |
| `PATCH  /api/owner/locations/:id`              | owner    | Update editable fields (slug change re-validated for uniqueness) |
| `POST   /api/owner/locations/:id/deactivate`   | owner    | Set `is_active=false` |
| `POST   /api/owner/locations/:id/reactivate`   | owner    | Set `is_active=true`  |

Authorization reuses the existing `SupabaseAuthGuard` + `RolesGuard`
(`@RequireRoles('owner', 'manager')`) on the read controller, and
`@RequireRoles('owner')` on the writes controller. The `/owner/...` URL prefix
is a deliberate second-line defence: even if the role guard regresses, the
prefix surfaces intent at the route level (same convention used by
`OwnerOnboardingController` and `OwnerStaffController`).

### Manager scoping

Manager scope is **enforced inside `LocationsService`**, not via the URL:

- `listForActor` filters the SELECT by `actor.allowedLocationIds`.
- `getForActor` 403s if `actor.allowedLocationIds.includes(locationId)` is
  false.

`AuthUser.allowedLocationIds` is computed in `AuthService.resolveAuthUser`
from the manager's `core.user_memberships` rows whose `location_id` is set.
Stylist and client are blocked at the `RolesGuard` level before the service
runs.

### Slugs and codes

- `slug` follows the same `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$` regex used by
  business and onboarding-location slugs.
- `code` is generated server-side from the slug
  (`slug.replace(/-/g, '_').toUpperCase().slice(0, 12)`) so the form does not
  need to expose it. This mirrors `sanitizeLocation()` in the onboarding
  service.
- The DB still enforces `(business_id, slug)` and `(business_id, code)`
  uniqueness; the service translates those Postgres errors into 409s.

## Web frontend

| Route                          | Roles          | Purpose |
| ------------------------------ | -------------- | ------- |
| `/locations`                   | owner          | List page (search + active/inactive filter, deactivate/reactivate inline) |
| `/locations`                   | manager        | Auto-redirects to `/locations/:ownId` |
| `/locations/:id`               | owner, manager | Detail page (manager only for their assigned id; backend re-asserts) |
| `/locations/new`               | owner          | Create form |
| `/locations/:id/edit`          | owner          | Edit form (slug is locked in this phase to keep historic links stable) |

Routes are wired with the existing `<ProtectedRoute>` role guard. The sidebar
shows the **Locations** entry to both owners and managers; stylists/clients
never see it (they cannot reach `/web` at all in the current dashboard
surface).

The forms reuse `components/onboarding/FormField.tsx` (`TextField` /
`SelectField`) and the same Tailwind tokens used by Team. The detail page
keeps a "coming soon" panel for the future settings surface.

## Why these guard rails

- **Manager cannot escape their location**: `LocationsPage` redirects
  managers to their own detail; `getForActor` 403s on foreign ids; the writes
  controller is owner-only at the role guard layer.
- **No hard delete**: only `deactivate` / `reactivate` are exposed; the table
  retains history and references (memberships, staff profiles, future
  appointments) stay valid.
- **Slug lock on edit**: prevents accidentally breaking links shared in the
  wild. We can lift this in a later phase with a redirect table.

## Connection to future work

- Detailed per-location settings (hours, services, deposits, calendar rules)
  will mount under `/locations/:id` and reuse this access model.
- Staff invitations should keep using the existing `/team` flow; the
  `BusinessLocationSummary[]` it consumes is unaffected.
- A manager might eventually need limited mutation rights inside their own
  location — when that lands it will widen `OwnerLocationsController`'s role
  guard or split out a `ManagerLocationsController`, never by loosening the
  `actor.allowedLocationIds` check.

## TODOs

- [ ] Replace the `it.todo` scaffold in `locations.service.spec.ts` with real
      Jest tests once a Jest harness lands in `apps/api`.
- [ ] Add a Vitest/RTL smoke test for `LocationsPage` (manager redirect,
      owner empty state) when the web test harness lands.
- [ ] Lift the slug lock on edit by introducing a redirect table for the old
      slug.
- [ ] Relax `NOT NULL` on `address_line_1`, `city`, `postal_code` when address
      becomes a structured optional sub-form.
