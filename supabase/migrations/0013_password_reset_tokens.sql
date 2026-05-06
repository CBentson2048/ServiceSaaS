-- 0013_password_reset_tokens.sql
--
-- Persistence for the self-serve password reset flow.
--
-- Mirrors the shape of `core.staff_invitations`:
--   * we generate a high-entropy plaintext token in the API,
--   * email the user a link containing the plaintext token,
--   * persist only the SHA-256 hash here so a DB leak cannot mint a session.
--
-- The actual password write is performed by the API via
-- `supabase.auth.admin.updateUserById`. This table only tracks the
-- bearer-token lifecycle (issue / inspect / consume / expire).

create table core.password_reset_tokens (
  id uuid primary key default extensions.gen_random_uuid(),
  user_profile_id uuid not null references core.user_profiles(id) on delete cascade,
  email extensions.citext not null,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  request_ip text,
  request_user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint password_reset_tokens_token_hash_unique unique (token_hash)
);

comment on table core.password_reset_tokens is
  'Single-use password-reset bearer tokens (sha256-hashed). One pending row max per user is the API-level invariant; previous outstanding rows are marked used at issue time.';

create index idx_password_reset_tokens_user_profile_id
  on core.password_reset_tokens (user_profile_id);
create index idx_password_reset_tokens_email
  on core.password_reset_tokens (email);

-- Lets us efficiently invalidate every still-valid token for a user when
-- a new one is issued (defence against stale phishing links / replay).
create index idx_password_reset_tokens_user_unused
  on core.password_reset_tokens (user_profile_id)
  where used_at is null;

create trigger password_reset_tokens_set_updated_at
before update on core.password_reset_tokens
for each row execute function public.set_updated_at();

alter table core.password_reset_tokens enable row level security;

-- The reset flow is anonymous (the user is not signed in). Only the
-- service role (used by the API) is allowed to read/write these rows.
-- Authenticated users do NOT need access — they can change their
-- password through the standard signed-in flow which does not touch
-- this table.
grant select, insert, update, delete
  on core.password_reset_tokens to service_role;

-- No `authenticated` grant on purpose: the API talks to this table
-- using the service role key only.
