-- 0067_user_profiles_is_customer.sql
-- Self-service customer sign-up (QLOOQO app) creates a global account with NO
-- salon membership — the customer joins salons lazily, one per-salon client
-- profile at a time, on their first booking at each. Such an account has zero
-- rows in core.user_memberships until then, which is indistinguishable from a
-- deactivated staff member whose memberships were all revoked. This flag marks
-- the account as a customer identity so auth can resolve it to a salon-less
-- `client` session instead of rejecting it (see AuthService.resolveAuthUser),
-- while genuinely membership-less non-customers keep being denied.

alter table core.user_profiles
  add column if not exists is_customer boolean not null default false;

comment on column core.user_profiles.is_customer is
  'True for self-registered customer accounts (app sign-up) that may hold no salon membership yet. Drives the salon-less client session in AuthService.resolveAuthUser; a customer gains per-salon client profiles + client codes lazily on first booking.';
