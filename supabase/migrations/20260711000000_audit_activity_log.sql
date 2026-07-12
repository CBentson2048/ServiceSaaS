-- Audit-trail foundation (R10 Audit & Compliance).
--
-- A single append-only activity log capturing who did what, when, and the
-- before/after of edits across the platform: bookings, cancellations, payment
-- edits, stock adjustments, permission changes and account changes. Order
-- approvals plug in from Week 5 using the same table.
--
-- Writes flow exclusively through the API service role, which keeps the log
-- tamper-evident: authenticated users (even owners/managers) can only SELECT.

create table if not exists audit.activity_log (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_profile_id uuid references core.user_profiles(id) on delete set null,
  actor_role core.membership_role_enum,
  -- Dotted entity.verb key, e.g. 'booking.cancelled', 'payment.recorded'.
  -- Free text so new actions never require a migration; validated by the API.
  action text not null,
  -- Broad entity category, e.g. 'booking', 'payment', 'stock', 'security_level',
  -- 'membership', 'account', 'order'. Free text, validated by the API.
  entity_type text not null,
  entity_id text,
  -- Prior/new values for edits. Creates set only `after`; deletes only `before`.
  before jsonb,
  after jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table audit.activity_log is
  'Append-only platform audit trail: actor, action, entity, before/after and timestamp for bookings, payments, stock, permission and account changes.';

create index if not exists idx_activity_log_business_created
  on audit.activity_log (business_id, created_at desc);

create index if not exists idx_activity_log_entity
  on audit.activity_log (business_id, entity_type, entity_id);

create index if not exists idx_activity_log_action_created
  on audit.activity_log (business_id, action, created_at desc);

create index if not exists idx_activity_log_actor_created
  on audit.activity_log (actor_user_profile_id, created_at desc);

alter table audit.activity_log enable row level security;

-- Owners can read the whole business log.
create policy activity_log_owner_select
  on audit.activity_log
  for select
  to authenticated
  using (public.is_business_owner(business_id));

-- Active managers can read their business's log (defense-in-depth; the API
-- additionally gates on the `audit.read` permission).
create policy activity_log_manager_select
  on audit.activity_log
  for select
  to authenticated
  using (
    exists (
      select 1
      from core.user_memberships m
      where m.business_id = audit.activity_log.business_id
        and m.user_profile_id = public.current_user_id()
        and m.role = 'manager'
        and m.status = 'active'
    )
  );

-- Grant the new audit.read capability to existing owner/group_admin/manager
-- system security levels so current businesses can reach the log immediately.
update core.security_levels
set permissions = permissions || '["audit.read"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin', 'manager')
  and not permissions @> '["audit.read"]'::jsonb;
