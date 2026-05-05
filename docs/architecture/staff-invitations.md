# Staff invitations & owner-driven team management (Phase 2)

This document describes the post-onboarding flow that lets a salon owner
invite **managers** and **stylists**, manage their role and location, and
deactivate / reactivate them. It builds directly on the
[Owner onboarding](./owner-onboarding.md) flow.

## Why a separate flow

* **Public signup is reserved for owners.** A new business creates itself
  via `/owner/onboarding`. Everyone else joins an existing business via an
  owner-issued invitation, so we never produce orphan staff accounts that
  belong to no business.
* **Only owners are business-wide.** Managers and stylists are bound to a
  single location (`core.user_memberships.location_id`). The invitation
  payload always carries a `locationId` and the database enforces that
  the location belongs to the same business.
* **The invite path cannot create owners.** The `core.staff_invitations`
  table includes `check (role in ('manager','stylist'))` and the request
  DTO uses the same `IsIn` whitelist, so even a tampered request body
  cannot escalate to owner.

## Lifecycle

```
owner @ /team                                    invitee @ /staff/accept-invite
   │                                                          │
   ▼                                                          │
POST /api/owner/staff/invitations  ── creates ──┐             │
                                                ▼             │
                                core.staff_invitations(pending)│
                                                ^             │
   POST .../resend  ─── rotates token ──────────┤             │
   POST .../revoke  ─── status = revoked ───────┤             │
                                                │             │
   the owner copies the inviteUrl ──────────────┴────────────►│
                                                              ▼
                              GET /api/staff/invitations/inspect (public)
                                                              │
                                                              ▼
                              POST /api/staff/invitations/accept (public)
                                ├─ supabase.auth.admin.createUser()
                                └─ rpc('core.accept_staff_invitation')
                                       ├─ upsert core.user_profiles
                                       ├─ upsert core.user_memberships (role + location)
                                       ├─ upsert core.staff_profiles (stylists)
                                       └─ mark invitation accepted
```

Statuses: `pending`, `accepted`, `revoked`, `expired`. Expiry defaults to
**14 days**; the API marks pending invitations expired lazily when an
expired token is presented for inspection or acceptance.

## Database schema

`supabase/migrations/0011_staff_invitations.sql` introduces:

* `core.invitation_status_enum`
* `core.staff_invitations`
  * `business_id`, `location_id`, `email`, `first_name`, `last_name`, `phone`
  * `role` (CHECK ∈ {`manager`,`stylist`})
  * `status` (default `pending`)
  * `invite_token_hash` (SHA-256 hex; the plaintext token is *only*
    returned to the owner once at create / resend time)
  * `expires_at`, `invited_by_user_profile_id`,
    `accepted_by_user_profile_id`, `accepted_at`, `revoked_at`,
    `metadata jsonb` (carries optional stylist defaults like
    `displayName`, `colorHex`, `bio`)
* Indexes on `business_id`, `location_id`, `email`, `status` plus a
  partial unique index on `(business_id, email) where status = 'pending'`
  so the same email cannot have two simultaneous pending invitations.
* RLS: `core_staff_invitations_owner_all` uses the existing
  `public.is_business_owner(uuid)` helper so only an authenticated owner
  of the business can read/write its invitations directly. The API uses
  the service role for writes anyway.
* Two `SECURITY DEFINER` helper functions, executable only by
  `service_role`:
  * `core.accept_staff_invitation(...)` — atomic acceptance
    (profile + membership + optional staff_profile + invitation row).
  * `core.update_staff_member(...)` — owner-driven role / location /
    status update with CHECK guards (`actor_not_owner`,
    `cannot_modify_owner`, `invalid_role_target`,
    `location_outside_business`, etc.) raised back as plpgsql
    exceptions and translated to 4xx responses by the API.

## Backend (NestJS) surface

Module: `apps/api/src/staff/`

| Method & path                                     | Auth                | Purpose |
| ------------------------------------------------- | ------------------- | ------- |
| `POST /api/owner/staff/invitations`               | owner               | Create invite, returns hashed token + `inviteUrl` |
| `GET  /api/owner/staff/invitations?status=`       | owner               | List invitations (default: all) |
| `POST /api/owner/staff/invitations/:id/resend`    | owner               | Rotate token + bump expiry |
| `POST /api/owner/staff/invitations/:id/revoke`    | owner               | Mark invitation `revoked` |
| `GET  /api/staff/invitations/inspect?token=`      | public              | Returns business / location / role for the accept page |
| `POST /api/staff/invitations/accept`              | public              | Creates auth user + activates membership |
| `GET  /api/owner/staff`                           | owner               | List all staff + pending invitations + locations |
| `PATCH /api/owner/staff/:userId`                  | owner               | Change role (manager/stylist), location, status, stylist profile |
| `POST /api/owner/staff/:userId/deactivate`        | owner               | Suspend membership without deleting history |
| `POST /api/owner/staff/:userId/reactivate`        | owner               | Re-enable suspended/revoked member |

Authorization reuses the existing `SupabaseAuthGuard` + `RolesGuard`
(`@RequireRoles('owner')`) on the controller class, so manager / stylist
/ client tokens get a 403 before any service code runs.

### Token handling

* Tokens are random 32-byte URL-safe strings (`randomBytes(32).toString('base64url')`).
* The DB only ever stores `sha256(token)`; the plaintext is returned in
  the API response **only at create/resend** time so the owner can copy
  the link or hand it to the email service.
* The `inviteUrl` is `${STAFF_INVITE_BASE_URL || CORS_ORIGINS[0] || 'http://localhost:5173'}/staff/accept-invite?token=<token>`.

### Email delivery (Resend)

* `apps/api/src/email/email.service.ts` wraps the [Resend](https://resend.com) Node SDK.
* `StaffService.createInvitation` and `StaffService.resendInvitation` both call
  `sendInvitationEmail(...)` after the row has been written, sending an HTML +
  plaintext email to `invitation.email` with the freshly minted `inviteUrl`.
* Reply-to is set to the inviting owner's email so the invitee can reply
  directly to the person who invited them.
* **Fail-soft policy**: email failures are logged but never thrown. The
  invitation row already exists and the API still returns `inviteUrl` /
  `inviteToken` to the owner, so the dashboard can copy the link or trigger
  a Resend → /resend → email retry without losing data.
* Configuration:
  * `RESEND_API_KEY` — when unset, the service runs in log-only mode (writes
    a `[email:skipped]` line per send so you can see the URL in dev logs).
  * `RESEND_FROM_EMAIL` — RFC 5322 sender on a verified Resend domain
    (e.g. `Sheer <team@sheer.app>`). Defaults to `Sheer <onboarding@resend.dev>`,
    which is restricted to the address that owns the Resend account.
  * `STAFF_INVITE_BASE_URL` — public origin for the accept page; falls back to
    the first `CORS_ORIGINS` entry.
* Each send is tagged with `category=staff_invitation`, `business_id`, and
  `invitation_id` for filtering/observability inside Resend.

### Auth-user reuse vs creation

The accept endpoint first checks if a Supabase auth user already exists
for the invited email. If so it links to that user (no new account, no
password rotation). If not it calls `auth.admin.createUser()` with the
password the invitee submitted. Only the latter case is rolled back when
the downstream RPC fails — we never delete a pre-existing auth user we
merely linked to.

## Web frontend

`apps/web/src/pages/TeamPage.tsx` (route `/team`, owner-only):

* Pending invitations card with **Resend** and **Revoke** buttons.
* Staff table with name, role, location, membership status.
* Search + status filter (active / suspended / revoked).
* Invite Staff modal (`components/team/InviteStaffModal.tsx`):
  * fields: first/last name, email, phone (optional), role
    (manager | stylist), location (must come from `ListStaffResponse.locations`,
    so cross-business location selection is impossible),
    optional stylist display name / bio.
  * On success, shows the one-time `inviteUrl` with a copy button.
* Edit Staff modal (`components/team/EditStaffModal.tsx`):
  * Switch role between manager and stylist.
  * Move to a different location in the same business.
  * Change membership status (active / suspended / revoked).
  * For stylists: display name, calendar colour, bio, bookable toggle.

`AcceptInvitationPage.tsx` (route `/staff/accept-invite?token=…`,
public):

* Inspects the token and shows business + location + role context.
* Form requires password + name; phone and stylist display name are
  optional.
* On success it either auto-signs-in (matching the owner-onboarding
  pattern) or redirects to `/login?invitation=accepted` with a banner.

The `Sidebar` only renders the `Team` link for users whose
`AuthUser.role === 'owner'`.

## Why these guard rails

* **Owners cannot demote / change themselves** through `PATCH
  /owner/staff/:userId` — the controller blocks `targetUserId === actor.id`
  and the SQL helper raises `cannot_modify_owner`.
* **No hard deletes.** Suspended / revoked memberships keep their
  history; a future audit log can read them.
* **Idempotent acceptance.** The RPC uses `on conflict (business_id,
  location_id, user_profile_id, role) do update set status='active'` so
  a user who already exists in the business as the right role just
  gets re-activated, and a previously-revoked membership comes back as
  active with a fresh `activated_at` timestamp.

## Connection to future work

* **Lab PIN**: stylist memberships will own a per-location PIN credential;
  the `staff_profile` row created here is the anchor for that.
* **Manager management of stylists**: deferred to V2; the `RolesGuard`
  whitelist will be widened from `'owner'` to `['owner','manager']` for a
  subset of operations once we model location-scoped managerial scope.
* **Email delivery**: now wired to Resend (see *Email delivery* above). The
  modal still surfaces the one-time `inviteUrl` so owners can copy it as a
  fallback when the API returns `delivered=false` (logged) — useful for dev
  without `RESEND_API_KEY` and for the Resend test sender, which can only
  deliver to the account owner's email.
* **Invite expiry sweep**: the API marks invites expired lazily on
  inspect/accept. A nightly cron in `comms` or `analytics` could mark
  stale rows in bulk, but it isn't necessary for correctness.

## TODOs

- [ ] Move email send to a queue / background worker so a slow Resend call
      can't block the `POST /owner/staff/invitations` request.
- [ ] Surface delivery status on the pending-invitations card (e.g. badge
      when the most recent send failed) — requires persisting the last
      `SendEmailResult` on the invitation row.
- [ ] Manager-scoped staff edits at a single location (V2).
- [ ] Surface `staff.metadata` (notes / nicknames) on the team list once
      we have an `EditStaffModal` "Notes" tab.
- [ ] Replace the `it.todo` scaffold in `staff.service.spec.ts` with
      real tests once a Jest harness lands in `apps/api`.
