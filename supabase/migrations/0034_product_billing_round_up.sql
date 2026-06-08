-- 0034_product_billing_round_up.sql
-- Adds an optional "round up" step to product auto-billing so the final
-- billable amount can be rounded UP to the nearest configured increment
-- (e.g. £0.50: £4.44 -> £4.50, £4.89 -> £5.00). Snapshot columns keep
-- historical line items immutable.

-- 1. Round-up configuration on billing.billing_rules
alter table billing.billing_rules
  add column if not exists product_round_up_enabled boolean not null default false,
  add column if not exists product_round_up_increment numeric(12,2)
    check (product_round_up_increment is null or product_round_up_increment > 0);

-- 2. Constraint: an increment must be present when round-up is enabled
alter table billing.billing_rules
  drop constraint if exists billing_rules_round_up_requirements;

alter table billing.billing_rules
  add constraint billing_rules_round_up_requirements check (
    product_round_up_enabled = false
    or product_round_up_increment is not null
  );

-- 3. Snapshot columns on billing.visit_line_items
alter table billing.visit_line_items
  add column if not exists round_up_enabled_snapshot boolean,
  add column if not exists round_up_increment_snapshot numeric(12,2)
    check (round_up_increment_snapshot is null or round_up_increment_snapshot > 0);

comment on column billing.billing_rules.product_round_up_enabled is
  'When true, the calculated product billable amount is rounded UP to the nearest product_round_up_increment.';
comment on column billing.billing_rules.product_round_up_increment is
  'Round-up step in decimal GBP (e.g. 0.50, 1.00). Required when product_round_up_enabled is true.';
comment on column billing.visit_line_items.round_up_enabled_snapshot is
  'Snapshot of whether round-up was applied when this line item was created.';
comment on column billing.visit_line_items.round_up_increment_snapshot is
  'Snapshot of the round-up increment applied at creation time. Null unless round_up_enabled_snapshot.';
