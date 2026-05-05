# Owner onboarding (Phase 1)

This document describes the public owner onboarding flow that lets a brand-new
salon owner create their Sheer workspace from `apps/web`. Staff invitation is
intentionally **not** part of this phase.

## Goals

- A new business owner can self-register without manual provisioning.
- Onboarding is atomic: either the full workspace exists, or nothing does.
- The role enum is unchanged (`owner` / `manager` / `stylist` / `client`).
- Manager / stylist / client accounts cannot be created through the public
  signup endpoint. They are introduced later via an invitation flow.

## End-to-end shape

```
apps/web (multi-step form)
        │  POST /api/owner/onboarding/register
        ▼
apps/api  OwnerOnboardingController → OwnerOnboardingService
        │  1. supabase.auth.admin.createUser()        (Supabase Auth)
        │  2. supabase.rpc('bootstrap_owner_business') (single tx)
        │  3. AuthService.login() to mint a session
        ▼
PostgreSQL (Supabase) — atomic plpgsql function in `core` schema
```

## Records created per onboarding

For every successful onboarding the database ends up with:

| Table                        | Row(s)                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| `auth.users`                 | 1 owner                                                             |
| `core.user_profiles`         | 1 (id = auth.users.id)                                              |
| `core.businesses`            | 1                                                                   |
| `core.locations`             | 1 (the first salon)                                                 |
| `core.user_memberships`      | 1, `role = 'owner'`, `location_id = NULL`, `status = 'active'`      |
| `core.location_settings`     | 1 default row for the new location                                  |
| `billing.billing_rules`      | 1 default row (`cost_plus_markup_percent`, markup `0`) per location |

> The owner membership intentionally has `location_id = NULL`. The
> `core.user_memberships` check constraint already enforces this for the
> owner role — owners always have business-wide scope.

## Why an SQL function for the bootstrap

`@supabase/supabase-js` cannot start a multi-statement transaction from
the client. To keep the bootstrap atomic, the API calls a single
`SECURITY DEFINER` function `core.bootstrap_owner_business(...)` introduced
in `supabase/migrations/0010_owner_onboarding.sql`. The function:

- Inserts the profile, business, location, owner membership, default
  location settings, and default billing rules in one transaction.
- Raises a database error on any uniqueness/constraint violation, which
  the API translates into a friendly 409 response.
- Is granted to `service_role` only and revoked from `public` so the
  Supabase anon key cannot bypass the API.

The auth user is still created by the API (it requires the admin client).
If anything in the bootstrap function fails, the API deletes the auth
user it just created so we cannot leave an orphaned `auth.users` row.

## API surface

All endpoints are publicly accessible (no bearer token), but the
`register` endpoint always provisions an `owner` and the schema
constraint blocks any other role from being persisted via this path.

| Method | Path                                  | Purpose                                            |
| ------ | ------------------------------------- | -------------------------------------------------- |
| GET    | `/api/owner/onboarding/bootstrap`     | Returns currency / timezone / country option lists |
| GET    | `/api/owner/onboarding/check-business-slug?slug=…` | Live availability check               |
| POST   | `/api/owner/onboarding/register`      | Creates the owner workspace (atomic)               |

`POST /register` returns:

```jsonc
{
  "userProfileId": "…",
  "businessId": "…",
  "locationId": "…",
  "nextStep": "dashboard",       // or "sign_in" if auto-login was skipped
  "redirectTo": "/",             // or "/login?onboarded=1"
  "session": { "accessToken": …, "refreshToken": … },
  "user":    { … AuthUser … }
}
```

If the auto-login step fails for any reason, the API still returns the
created IDs but with `nextStep = "sign_in"` and no session, so the web
app can cleanly redirect the new owner to the sign-in screen.

## Web frontend

- Route: `/owner/onboarding` (legacy `/create-account` redirects here).
- File: `apps/web/src/pages/OwnerOnboardingPage.tsx`.
- Multi-step layout (Owner → Business → First location → Review)
  using shared `Stepper`, `TextField`, `SelectField` components in
  `apps/web/src/components/onboarding/`.
- Auto-derives slugs from names until the user edits them, and
  debounces the slug availability check via the API.
- Reuses the existing `AuthProvider` so a successful onboarding either:
  - Flows straight into the authenticated dashboard (when the API issues
    a session), or
  - Redirects to `/login?onboarded=1` showing a success banner.

## Why staff are not created here

- Owner onboarding is the entry point for a brand new business; managers
  and stylists belong to an existing business and need an invite from an
  existing owner/manager.
- The role enum is intentionally not extended — manager/stylist/client
  accounts will be created by a forthcoming invitation flow that:
  - issues a single-use invitation token bound to the business,
  - lets the invitee finish setting up their auth account, and
  - inserts a `user_memberships` row with the correct role + location.
- The bootstrap helper deliberately handles only the `owner` case so the
  invitation flow can introduce a separate, narrower SQL helper later.

## Follow-up TODOs (out of scope for this phase)

- Email verification flow (currently `email_confirm: true` is forced for
  the owner so they can log in immediately).
- Optional Stripe / billing customer provisioning at onboarding time.
- A real address-completion service so address fields can stop being
  optional and the location row can capture a full address.
- Manager / stylist / client invitation flow (separate task).
