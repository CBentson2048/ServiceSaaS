-- 0028_product_auto_billing.sql
-- Adds product-level auto-billing configuration to billing_rules and
-- snapshot columns to visit_line_items so historical records are immutable.

-- 1. Product billing fields on billing.billing_rules
alter table billing.billing_rules
  add column if not exists product_billing_enabled boolean not null default true,
  add column if not exists product_billing_rule billing.formula_billing_mode_enum not null default 'cost_only',
  add column if not exists product_markup_percent numeric(7,2)
    check (product_markup_percent is null or product_markup_percent >= 0),
  add column if not exists product_fixed_uplift_amount numeric(12,2)
    check (product_fixed_uplift_amount is null or product_fixed_uplift_amount >= 0);

-- 2. Constraint: rule parameters must be present when required
alter table billing.billing_rules
  drop constraint if exists billing_rules_product_rule_requirements;

alter table billing.billing_rules
  add constraint billing_rules_product_rule_requirements check (
    (product_billing_rule = 'cost_only')
    or
    (product_billing_rule = 'cost_plus_markup_percent' and product_markup_percent is not null)
    or
    (product_billing_rule = 'fixed_uplift' and product_fixed_uplift_amount is not null)
  );

-- 3. Snapshot columns on billing.visit_line_items
--    These capture the billing rule state at the time of product usage creation,
--    so future rule changes do not alter historical records.
alter table billing.visit_line_items
  add column if not exists cost_amount_cents integer
    check (cost_amount_cents is null or cost_amount_cents >= 0),
  add column if not exists billable_amount_cents integer
    check (billable_amount_cents is null or billable_amount_cents >= 0),
  add column if not exists billing_rule_snapshot billing.formula_billing_mode_enum,
  add column if not exists markup_percent_snapshot numeric(7,2)
    check (markup_percent_snapshot is null or markup_percent_snapshot >= 0),
  add column if not exists fixed_uplift_amount_snapshot numeric(12,2)
    check (fixed_uplift_amount_snapshot is null or fixed_uplift_amount_snapshot >= 0);

comment on column billing.billing_rules.product_billing_enabled is
  'When false, product usage is not auto-billed during visit/checkout flow.';
comment on column billing.billing_rules.product_billing_rule is
  'Controls how product cost becomes the billed product charge for a location.';
comment on column billing.billing_rules.product_markup_percent is
  'Required when product_billing_rule = cost_plus_markup_percent. Markup as a percentage of product cost.';
comment on column billing.billing_rules.product_fixed_uplift_amount is
  'Required when product_billing_rule = fixed_uplift. Fixed amount added to product cost (stored as decimal GBP, consistent with formula_fixed_uplift_amount convention).';
comment on column billing.visit_line_items.cost_amount_cents is
  'Raw product cost in minor units at time of creation. Null for non-product line items.';
comment on column billing.visit_line_items.billable_amount_cents is
  'Calculated billable amount in minor units at time of creation. May differ from amount_cents for non-product lines.';
comment on column billing.visit_line_items.billing_rule_snapshot is
  'Snapshot of the billing rule used when this line item was created. Immutable after insert.';
comment on column billing.visit_line_items.markup_percent_snapshot is
  'Snapshot of markup percent applied at creation time. Null unless billing_rule_snapshot = cost_plus_markup_percent.';
comment on column billing.visit_line_items.fixed_uplift_amount_snapshot is
  'Snapshot of fixed uplift applied at creation time. Null unless billing_rule_snapshot = fixed_uplift.';
