# Post-account-creation completion flow (role-aware)

This document describes how the web app handles the **last step** of an
account creation / invitation acceptance flow when the resulting role is
**not** an owner or manager.

It builds directly on:

- [Owner onboarding](./owner-onboarding.md) — `/owner/onboarding`
- [Staff invitations](./staff-invitations.md) — `/staff/accept-invite`

## Why this flow exists

The web app is the dashboard product surface for **owners** and
**managers**. Stylists and clients have their own product surface, the
**Sheer App** (mobile), and they should never end up logged into the web
dashboard.

That said, **invitation links land on the web** today: when an owner
invites a stylist, the email points at
`/staff/accept-invite?token=...`. The invitee sets their password and
fills in their profile in the browser. So we are in a slightly tricky
spot:

- We **must** allow stylist/client to use the web for invite acceptance
  and password setup. There is no other place to do it right now.
- We **must not** treat them as web dashboard users after that. They are
  not authorized for the dashboard surface.

The completion page is the seam between those two facts.

## Product rules

| Role     | Web allowed for                     | Web allowed for dashboard? | Post-success destination     |
| -------- | ----------------------------------- | -------------------------- | ---------------------------- |
| owner    | onboarding + dashboard              | Yes                        | `/` (dashboard)              |
| manager  | invite acceptance + dashboard       | Yes                        | `/` (dashboard)              |
| stylist  | invite acceptance / password setup  | **No**                     | `/auth/account-created`      |
| client   | invite acceptance / password setup  | **No**                     | `/auth/account-created`      |

## Backend contract

The two account-creation endpoints now return a small role-aware payload
that the web client uses to branch:

```ts
// packages/domain/src/index.ts

export type AccountCreationTargetSurface = 'web' | 'mobile';
export type AccountCreationNextAction =
  | 'redirect_to_dashboard'
  | 'show_completion_page';
```

Both payloads are extended:

- `POST /api/owner/onboarding/register` → `OwnerOnboardingResponse`
  always returns `role: 'owner'`, `targetSurface: 'web'`,
  `nextAction: 'redirect_to_dashboard'`.
- `POST /api/staff/invitations/accept` → `AcceptStaffInvitationResponse`
  derives the fields from the invitation row server-side:
  - `role` is the stored invitation role (`manager` / `stylist`).
  - `targetSurface` = `'web'` for owner/manager, `'mobile'` for
    stylist/client.
  - `nextAction` = `'redirect_to_dashboard'` for `'web'`,
    `'show_completion_page'` for `'mobile'`.
  - `redirectTo` is set to `/auth/account-created?role=<role>` for the
    mobile case so older clients still navigate correctly even if they
    don't read `nextAction`.

### Why we no longer auto sign-in stylists on the web

`StaffService.acceptInvitation` previously called `tryAutoSignIn` for
*every* role. For stylists this always failed inside the web dashboard
surface check — `AuthService.assertSurfaceAccess` 403s when the role
isn't owner/manager — so the response simply contained `session:
undefined` and the client redirected to `/login?invitation=accepted`.
That worked, but produced a terrible UX: the user just successfully
created an account, then was sent to a sign-in page that would also
reject them. They naturally tried to sign in, hit the unauthorized
guard, and saw a "forbidden"-flavoured screen.

Now we **skip the auto sign-in entirely** for stylist/client. We never
attempt to mint a web session for them. We send them to the completion
page that says *"You're all set, continue in the Sheer App"* — which is
the truthful, successful end-state.

The role used for that branch is read from the **invitation row**, not
from the request body. The request body cannot escalate the destination.

## Web frontend

| Route                          | Roles            | Public | Purpose                                                                          |
| ------------------------------ | ---------------- | ------ | -------------------------------------------------------------------------------- |
| `/auth/account-created`        | (any / none)     | Yes    | Successful end-state for stylist/client web account claim. Points to Sheer App.  |

Implementation notes:

- The route is wired in `apps/web/src/App.tsx` **outside** the
  `<ProtectedRoute>` guard. It is auth-adjacent: no token required, no
  role required. It carries no dashboard data.
- Mounting it outside the dashboard guard does **not** loosen any
  dashboard route. `<ProtectedRoute allowedRoles={['owner','manager']}>`
  still wraps the dashboard children; stylist/client still hit
  `/unauthorized` if they try `/`, `/locations`, `/team`, etc.
- `AcceptInvitationPage` reads `response.nextAction`. When it equals
  `'show_completion_page'` it:
  - drops any session that may have come back (defence in depth),
  - navigates to `/auth/account-created?role=<role>` with a `state.role`
    fallback for screens that prefer router state.
- `AccountCreatedPage` renders three role-aware copy variants (stylist,
  client, generic fallback) and offers two CTAs:
  - **Open Sheer App** → `sheerAppDeepLink`
  - **Download Sheer App** → store URL chosen via cheap UA sniff
- The deep link / store URLs live in
  `apps/web/src/config/mobileApp.ts` and accept `VITE_*` overrides so
  the real values can be wired in later without code changes.

## Why this is **different** from web dashboard authorization

The dashboard authorization story is unchanged:

- `RolesGuard` on the API still rejects non-owner/manager calls.
- `AuthService.assertSurfaceAccess('web_dashboard')` still rejects
  stylist/client logins on the web surface.
- `<ProtectedRoute allowedRoles={['owner','manager']}>` still wraps the
  dashboard.

The completion page is **not** a relaxation of those rules. It is a
separate, public, auth-adjacent screen that exists purely so we can
deliver a clean *"account created — continue on mobile"* experience
without throwing the user at a forbidden screen pretending to be a
sign-in page.

## TODOs

- [ ] Replace the placeholder `sheerAppDeepLink`, App Store URL, and
      Play Store URL in `apps/web/src/config/mobileApp.ts` once the
      mobile app ships. They're already wired through `VITE_*` env vars
      so this is a config change, not code.
- [ ] Add a Vitest/RTL smoke test for `AccountCreatedPage` (stylist /
      client / generic copy + CTA hrefs) when the web test harness lands.
- [ ] Add a Jest test for `StaffService.acceptInvitation` covering the
      `targetSurface` + `nextAction` branch (the `it.todo` scaffolds are
      already in `staff.service.spec.ts`).
- [ ] Once the API exposes `POST /staff/invitations/accept` for the
      `client` role too (today only `manager` and `stylist` are
      invitable), the same completion page handles it without code
      changes — only `InvitableRole` needs to widen.
