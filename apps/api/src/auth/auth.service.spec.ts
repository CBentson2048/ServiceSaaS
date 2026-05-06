/**
 * Password reset (self-serve, web) — test scaffold.
 *
 * Like `staff.service.spec.ts`, this file records the test cases we want
 * once Jest is wired up. Today the repo runs with `--passWithNoTests`,
 * so these `it.todo` entries serve as a stable contract checklist for
 * future contributors.
 *
 * When implementing:
 *   - mock SupabaseClient `.schema('core').from('password_reset_tokens')`
 *     chains for select / insert / update.
 *   - mock `admin.auth.admin.updateUserById` for the success path and
 *     for the "Supabase rejected the password" failure path.
 *   - mock `EmailService.send` to assert delivery + that an unconfigured
 *     RESEND_API_KEY logs the reset URL instead of throwing.
 */

describe('AuthService — password reset request', () => {
  it.todo('always responds { accepted: true } regardless of whether the email exists');
  it.todo('does NOT call EmailService.send when the email does not match a profile');
  it.todo('issues a single-use sha256-hashed token row when the email exists');
  it.todo(
    'invalidates any previously-outstanding tokens for the same user before issuing a new one',
  );
  it.todo('still responds { accepted: true } when token persistence fails (logs to operator)');
  it.todo('records request_ip + request_user_agent on the issued token row');
  it.todo('logs the reset URL in dev when RESEND_API_KEY is not configured');
});

describe('AuthService — password reset inspect', () => {
  it.todo('returns status=unknown for tokens shorter than 20 chars');
  it.todo('returns status=unknown for tokens that do not match any row');
  it.todo('returns status=valid + masked email + expiresAt for a fresh token');
  it.todo('returns status=expired for a token past its expires_at');
  it.todo('marks an expired token used so it cannot be reactivated');
  it.todo('returns status=used for a token that was already consumed');
});

describe('AuthService — password reset complete', () => {
  it.todo('rejects passwords shorter than the policy minimum (8) with BadRequestException');
  it.todo('rejects unknown tokens with NotFoundException');
  it.todo('rejects expired tokens with BadRequestException + marks them used');
  it.todo('rejects already-used tokens with BadRequestException');
  it.todo('updates the auth user password via supabase.auth.admin.updateUserById');
  it.todo('marks the token used after a successful password update');
  // Role-aware completion contract (post-reset surface routing).
  it.todo(
    'owner reset returns targetSurface=web + nextAction=redirect_to_dashboard + redirectTo=/login?password=reset',
  );
  it.todo(
    'manager reset returns targetSurface=web + nextAction=redirect_to_dashboard',
  );
  it.todo(
    'stylist reset returns targetSurface=mobile + nextAction=show_completion_page + redirectTo=/auth/password-reset-complete?role=stylist',
  );
  it.todo(
    'client reset returns targetSurface=mobile + nextAction=show_completion_page',
  );
  it.todo('response.role is always derived from the user membership, never request input');
  it.todo('does NOT issue a session — user must sign in again with the new password');
});
