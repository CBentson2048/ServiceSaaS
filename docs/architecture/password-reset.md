# Password reset (self-serve, web)

This note describes how a user resets their Sheer password from the web,
how the role-aware post-reset UX is wired, and what still needs to be
configured manually for emails to actually be delivered.

It builds directly on:

- [Post-account-creation flow](./post-account-creation.md) — same
  role-aware completion pattern, same `/auth/account-created` shape.
- [Staff invitations](./staff-invitations.md) — token shape (random plaintext
  bearer + sha256 hash on the server) and Resend delivery pattern.

## Why a custom flow (vs Supabase's built-in recovery email)

The built-in `supabase.auth.resetPasswordForEmail` uses a magic-link
recovery session that, once consumed, leaves the user signed in.

That contradicts our product surface split:

- Stylists and clients **must not** be auto-signed into the web
  dashboard — they are forbidden there. If we issued them a recovery
  session on the web, the next dashboard route they hit would 403.
- Owners and managers **already** have the dashboard sign-in flow they
  expect. Forcing them through a magic-link session adds nothing.

So the implementation mirrors the **staff invitation** pattern:

1. The API issues a high-entropy URL-safe plaintext token, stores only
   the sha256 hash in `core.password_reset_tokens`, and emails the
   plaintext token via Resend.
2. The web client validates the token via `/auth/password-reset/inspect`
   without consuming it (so the page can show "Link expired" without
   burning the link on first navigation).
3. On submit, `/auth/password-reset/complete` rotates the password via
   `supabase.auth.admin.updateUserById` and marks the token used.
4. **No session is issued.** The user signs in again — owners/managers
   on `/login`, stylist/client in the Sheer App.

## Endpoints (`apps/api/src/auth/auth.controller.ts`)

| Method | Path                                  | Body / query                       | Returns                                                                                                                |
| ------ | ------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/password-reset/request`        | `{ email }`                        | `{ accepted: true }` — **always**, regardless of whether the email matched. Never use the response for enumeration.    |
| GET    | `/auth/password-reset/inspect?token=` | —                                  | `{ status, emailMasked?, expiresAt? }` where `status ∈ valid \| expired \| used \| unknown`.                           |
| POST   | `/auth/password-reset/complete`       | `{ token, password }` (min 8 chars) | `{ success: true, redirectTo, role, targetSurface, nextAction }` — role/surface/action are derived from the membership. |

The completion contract reuses the existing `AccountCreationTargetSurface`
and `AccountCreationNextAction` enums from `@sheer/domain` so the web
client can route consistently with the staff-invitation acceptance flow.

## Token storage

`supabase/migrations/0013_password_reset_tokens.sql` creates
`core.password_reset_tokens`:

- `token_hash` is `sha256(token)`, with a unique index — DB leaks alone
  cannot mint a session.
- `expires_at` defaults to **1 hour** from issuance (controlled by
  `PASSWORD_RESET_EXPIRY_HOURS` in `auth.service.ts`).
- `used_at` is populated on successful completion or when the token is
  observed expired (so `/inspect` cannot revive an expired link).
- A new request invalidates any previously-outstanding token for the
  same user before issuing a fresh one (defence against stale phishing
  links).
- RLS is enabled and only `service_role` is granted; the API talks to
  the table with the service-role key.

## Web pages (`apps/web/src/pages/`)

| Route                              | Page                            | Visible to                                    |
| ---------------------------------- | ------------------------------- | --------------------------------------------- |
| `/forgot-password`                 | `ForgotPasswordPage`            | Anyone (auth-adjacent, public)                |
| `/auth/reset-password?token=...`   | `ResetPasswordPage`             | Anyone with a token                           |
| `/auth/password-reset-complete`    | `PasswordResetCompletePage`     | Stylist / client landing page after success   |

Aliases `/reset-password` and `/auth/forgot-password` redirect to the
canonical paths above.

All three are mounted **outside** `ProtectedRoute` in `App.tsx`. They
cannot bypass the dashboard guard — there is no nested route under them
that points at a protected page.

The `/login` page now has a "Forgot password?" link in the password
field label, and shows a friendly success banner when redirected back
with `?password=reset` (used by owners/managers after completion).

## Role-aware post-reset UX

After `/auth/password-reset/complete` succeeds the API returns
`{ role, targetSurface, nextAction, redirectTo }`:

- **owner / manager** → `targetSurface: 'web'`,
  `nextAction: 'redirect_to_dashboard'`,
  `redirectTo: '/login?password=reset'`.

  The web client navigates to `/login?password=reset`, which renders a
  green confirmation banner and an empty sign-in form. We do **not**
  auto-sign them in — they must enter their new password to confirm.

- **stylist / client** → `targetSurface: 'mobile'`,
  `nextAction: 'show_completion_page'`,
  `redirectTo: '/auth/password-reset-complete?role=<role>'`.

  The completion page (a) congratulates the user, (b) offers the same
  **Open Sheer App** / **Download Sheer App** CTAs as the
  `AccountCreatedPage`, and (c) provides a "Return to sign in" footer
  link. They are never auto-logged into the web dashboard.

Role is **always** read from the user's primary active membership (the
same priority order as `AuthService.resolveAuthUser`). The `role` query
param on the completion page is just a hint for the unlikely manual-URL
case — it is **not** a security signal.

## Configuration / env variables

Existing keys (already documented in `apps/api/.env.example`):

- `RESEND_API_KEY` — when unset, the API logs the reset URL instead of
  attempting a delivery, so local dev still works without secrets.
- `RESEND_FROM_EMAIL` (preferred) or `RESEND_FROM` — sender address. If
  it's a bare email the service wraps it as `"Sheer <noreply@…>"` for
  RFC 5322 compliance. Must use a domain you've verified at
  `https://resend.com/domains` to send to recipients other than the
  Resend account holder.
- `PASSWORD_RESET_BASE_URL` — origin the reset link should point at.
  Falls back to the first `CORS_ORIGINS` entry, then `http://localhost:5173`.

### Optional: routing Supabase Auth's own emails through Resend

We don't currently use Supabase's built-in recovery email, but if a
future feature does (e.g. magic-link sign-in for the mobile app), the
project SMTP setup below applies. Configure these in the Supabase
dashboard under **Project Settings → Auth → SMTP Settings**:

```
SMTP host:     smtp.resend.com
SMTP port:     465 (SSL) or 587 (STARTTLS)
SMTP username: resend
SMTP password: <RESEND_API_KEY>
Sender email:  noreply@<your-verified-domain>
Sender name:   Sheer
```

Then add the redirect URL allowlist under **Auth → URL Configuration**:

```
https://<your web domain>/auth/reset-password
http://localhost:5173/auth/reset-password
```

These values are configuration, not secrets shared in code, so they
live in the operator's deployment settings — not in this repo.

## Testing

Test scaffolds live in `apps/api/src/auth/auth.service.spec.ts` as
`it.todo` entries (Jest is wired with `--passWithNoTests` until a real
harness lands; see `staff.service.spec.ts` for the same pattern). The
covered cases include:

- neutral `accepted: true` regardless of email existence,
- single-use + expiry semantics,
- role-aware completion contract for each of `owner / manager / stylist / client`,
- "no session is issued on completion" invariant.

## Manual follow-up

Items that are intentionally **not** automated and require an operator:

1. Verify the sending domain at `https://resend.com/domains` and set
   `RESEND_FROM_EMAIL` / `RESEND_FROM` to a `@<that domain>` address on
   Railway. Without this, Resend rejects with
   `"You can only send testing emails to your own email address"`.
2. Set `PASSWORD_RESET_BASE_URL` on Railway to your production web
   origin (e.g. `https://sheer-platform-web.vercel.app`). The fallback
   to `CORS_ORIGINS[0]` works but should be made explicit in prod.
3. (Optional) Configure Supabase Auth → SMTP to also relay built-in
   emails through Resend, per the SMTP block above.
4. Update `VITE_SHEER_APP_DEEP_LINK` and the store URLs in
   `turbo.json` / Vercel once the mobile app's universal link is
   finalised. Until then the placeholders in `apps/web/src/config/mobileApp.ts`
   are used.
