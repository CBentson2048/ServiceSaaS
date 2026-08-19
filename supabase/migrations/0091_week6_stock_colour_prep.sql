-- 0091_week6_stock_colour_prep.sql
-- V1.1 Adjusted Week 6 — Stock, QLAB and Colour Prep foundation.
--
-- Next free number verified against the repo on 2026-08-19: 0089 and 0090 are
-- ZAC (memory lifecycle, measurement spine), committed in 35e3647 / 4deca59.
-- Nothing here renames or reuses an applied migration.
--
-- WHAT THIS DOES
--   1. A movement type for salon/barcode consumption.
--   2. Product unit + pack + barcode metadata (Colour Prep and barcode need it).
--   3. Colour linkage: booking.service_categories -> billing colour category.
--   4. Per-location stock policy (deduction on/off, negative stock allowed).
--   5. Idempotency keys on stock movements (safe retries).
--   6. inventory.adjust_location_stock  — idempotency + negative-stock policy.
--   7. lab.save_formula_with_reconciliation — "where configured" location gate.
--   8. billing.record_retail_sale — stop silently skipping stock deduction.
--   9. Indexes Colour Prep reads through.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.
--
-- NOTE ON ENUMS: `alter type ... add value` may not be used and then referenced
-- by DML in the same transaction. Section 1 only adds the label; the new label
-- is referenced from function BODIES (resolved at runtime), never from DDL-time
-- DML, so applying this file top-to-bottom is safe.
--
-- DELIBERATELY NOT DONE — deduction is NOT gated on products.is_lab_use.
-- 0079 backfilled is_lab_use = true only for rows with created_at < 2026-08-05,
-- and the four classification columns have never had a write path (no DTO, no
-- form). Gating deduction on that column would silently stop deducting stock
-- for every product created since 2026-08-05. Section 2c repairs the gap with
-- the same rule 0079 intended; the deduction gate is the location setting.

-- =============================================================================
-- 1. Movement type for salon / barcode consumption
-- =============================================================================
alter type inventory.stock_movement_type_enum add value if not exists 'salon_consumption';

-- =============================================================================
-- 2. Product unit, pack and barcode metadata
-- =============================================================================

-- 2a. Columns.
--   stock_unit  — what ONE unit of quantity_on_hand_grams means for this product.
--                 'gram' keeps today's meaning; 'millilitre' is a like-for-like
--                 fluid measure; 'unit' means the column counts whole items.
--   pack_size   — base quantities in one sellable/orderable pack. size_value has
--                 carried this implicitly since 0024; 2b backfills from it.
alter table inventory.products
  add column if not exists stock_unit text not null default 'gram',
  add column if not exists pack_size numeric(12,3),
  add column if not exists barcode text;

alter table inventory.products
  drop constraint if exists products_stock_unit_allowed;
alter table inventory.products
  add constraint products_stock_unit_allowed
  check (stock_unit in ('gram', 'millilitre', 'unit'));

alter table inventory.products
  drop constraint if exists products_pack_size_positive;
alter table inventory.products
  add constraint products_pack_size_positive
  check (pack_size is null or pack_size > 0);

comment on column inventory.products.stock_unit is
  'What one unit of location_stock.quantity_on_hand_grams means for this product. '
  'gram/millilitre keep the historical gram semantics; unit means the column counts whole items. '
  'The column name is retained for compatibility — renaming it is tracked as tech debt.';
comment on column inventory.products.pack_size is
  'Base quantities in one sellable/orderable pack (e.g. a 100g tube = 100). '
  'Backfilled from size_value, which has carried this implicitly since 0024.';
comment on column inventory.products.barcode is
  'Scannable identifier (EAN/UPC or supplier code). Unique per business when set.';

-- 2b. Backfill pack_size from the size_value that has stood in for it.
update inventory.products
set pack_size = size_value
where pack_size is null
  and size_value is not null
  and size_value > 0;

-- 2c. Repair the 0079 classification gap.
-- 0079 ran `set is_lab_use = true ... where created_at < '2026-08-05'`. Products
-- created since then were never classified because no write path exists. Apply
-- the same rule so the flags mean something before the UI starts writing them.
update inventory.products
set
  is_lab_use = true,
  is_retail = (retail_price_cents is not null)
where is_salon_use = false
  and is_lab_use = false
  and is_retail = false;

-- 2d. Barcode lookup must be unique per tenant and fast.
create unique index if not exists inventory_products_business_barcode_key
  on inventory.products (business_id, barcode)
  where barcode is not null;

-- =============================================================================
-- 3. Colour linkage — which service categories are colour work
-- =============================================================================
-- billing.service_billing_category_enum (0043) has existed only as a key on
-- billing.service_billing_rules. Nothing pointed a bookable service at it, so
-- "which upcoming appointments are colour appointments" was unanswerable.
-- Null means "not a colour service" and is excluded from Colour Prep.
alter table booking.service_categories
  add column if not exists billing_category billing.service_billing_category_enum;

comment on column booking.service_categories.billing_category is
  'Links a service category to its colour billing category (0043). Null means the '
  'category is not colour work and is excluded from Colour Prep planning.';

create index if not exists idx_service_categories_billing_category
  on booking.service_categories (business_id, billing_category)
  where billing_category is not null;

-- =============================================================================
-- 4. Per-location stock policy
-- =============================================================================
alter table core.location_settings
  add column if not exists stock_deduction_enabled boolean not null default true,
  add column if not exists allow_negative_stock boolean not null default true;

comment on column core.location_settings.stock_deduction_enabled is
  'Master switch for automatic stock deduction at this location. This is the '
  '"where configured" of the Week 6 Lab-usage requirement. Default true preserves '
  'existing behaviour for every location.';
comment on column core.location_settings.allow_negative_stock is
  'When true (default) a deduction may take stock below zero and is flagged rather '
  'than blocked — blocking a Lab save mid-service is disruptive. When false the '
  'deduction is refused with a usable error.';

-- =============================================================================
-- 5. Idempotency for stock movements
-- =============================================================================
alter table inventory.stock_movements
  add column if not exists idempotency_key text;

comment on column inventory.stock_movements.idempotency_key is
  'Caller-supplied key making a stock mutation safe to retry. A repeat call with '
  'the same key returns the original movement instead of applying a second delta.';

create unique index if not exists inventory_stock_movements_idempotency_key
  on inventory.stock_movements (business_id, idempotency_key)
  where idempotency_key is not null;

-- =============================================================================
-- 6. inventory.adjust_location_stock — idempotency + negative-stock policy
-- =============================================================================
-- Unchanged from 0024 except for three additions, all at the top of the body:
--   * an idempotency short-circuit (returns the original result, no second delta);
--   * a negative-stock guard driven by core.location_settings.allow_negative_stock;
--   * the movement now records idempotency_key.
-- This stays THE authoritative write path: barcode consumption, retail sales and
-- manual adjustments all route through it, so the rules live in exactly one place.
create or replace function inventory.adjust_location_stock(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, inventory, core
as $$
declare
  v_business_id uuid := nullif(p_payload->>'businessId', '')::uuid;
  v_location_id uuid := nullif(p_payload->>'locationId', '')::uuid;
  v_product_id uuid := nullif(p_payload->>'productId', '')::uuid;
  v_created_by uuid := nullif(p_payload->>'createdBy', '')::uuid;
  v_idempotency_key text := nullif(p_payload->>'idempotencyKey', '');
  v_delta numeric(12,3) := coalesce((p_payload->>'quantityDeltaGrams')::numeric, 0);
  v_movement_type inventory.stock_movement_type_enum :=
    coalesce(nullif(p_payload->>'movementType', ''), 'manual_adjustment')::inventory.stock_movement_type_enum;
  v_unit_cost integer;
  v_total_cost integer;
  v_threshold numeric(12,3);
  v_allow_negative boolean;
  v_projected numeric(12,3);
  v_existing inventory.stock_movements%rowtype;
  v_location_stock inventory.location_stock%rowtype;
  v_movement inventory.stock_movements%rowtype;
begin
  if v_business_id is null or v_location_id is null or v_product_id is null then
    raise exception 'businessId, locationId, and productId are required';
  end if;

  if v_delta = 0 then
    raise exception 'quantityDeltaGrams must not be zero';
  end if;

  -- Retry safety. A repeated submit with the same key must not deduct twice;
  -- return the state the original call produced.
  if v_idempotency_key is not null then
    select * into v_existing
    from inventory.stock_movements
    where business_id = v_business_id
      and idempotency_key = v_idempotency_key;

    if found then
      select * into v_location_stock
      from inventory.location_stock
      where location_id = v_existing.location_id
        and product_id = v_existing.product_id;

      return jsonb_build_object(
        'locationStockId', v_location_stock.id,
        'movementId', v_existing.id,
        'quantityOnHandGrams', v_location_stock.quantity_on_hand_grams,
        'lowStockThresholdGrams', v_location_stock.low_stock_threshold_grams,
        'idempotentReplay', true
      );
    end if;
  end if;

  select default_cost_per_gram_cents
  into v_unit_cost
  from inventory.products
  where id = v_product_id
    and business_id = v_business_id
    and is_active;

  if not found then
    raise exception 'Product is not active for this business';
  end if;

  insert into inventory.location_stock (
    business_id, location_id, product_id, quantity_on_hand_grams, low_stock_threshold_grams, is_active
  )
  values (v_business_id, v_location_id, v_product_id, 0, null, true)
  on conflict (location_id, product_id) do update
    set is_active = true
  returning * into v_location_stock;

  -- Negative-stock policy. Default is allow-and-flag; a location may opt into
  -- refusing the movement instead.
  select coalesce(ls.allow_negative_stock, true)
  into v_allow_negative
  from core.location_settings ls
  where ls.location_id = v_location_id;

  v_allow_negative := coalesce(v_allow_negative, true);
  v_projected := v_location_stock.quantity_on_hand_grams + v_delta;

  if not v_allow_negative and v_projected < 0 then
    raise exception 'Insufficient stock: % on hand, % requested (location does not allow negative stock)',
      v_location_stock.quantity_on_hand_grams, abs(v_delta)
      using errcode = 'check_violation';
  end if;

  update inventory.location_stock
  set quantity_on_hand_grams = quantity_on_hand_grams + v_delta,
      is_active = true
  where id = v_location_stock.id
  returning * into v_location_stock;

  v_total_cost := case
    when v_unit_cost is null then null
    else round(abs(v_delta) * v_unit_cost)::integer
  end;

  insert into inventory.stock_movements (
    business_id, location_id, product_id, location_stock_id, movement_type,
    quantity_delta_grams, unit_cost_cents, total_cost_cents, reference_type,
    reference_id, reason, notes, created_by, metadata, idempotency_key
  )
  values (
    v_business_id, v_location_id, v_product_id, v_location_stock.id, v_movement_type,
    v_delta, v_unit_cost, v_total_cost,
    nullif(p_payload->>'referenceType', ''),
    nullif(p_payload->>'referenceId', '')::uuid,
    nullif(p_payload->>'reason', ''),
    nullif(p_payload->>'notes', ''),
    v_created_by,
    coalesce(p_payload->'metadata', '{}'::jsonb),
    v_idempotency_key
  )
  returning * into v_movement;

  v_threshold := coalesce(v_location_stock.low_stock_threshold_grams, (
    select low_stock_threshold_grams from inventory.products where id = v_product_id
  ));

  if v_threshold is not null and v_threshold > 0 and v_location_stock.quantity_on_hand_grams <= v_threshold then
    insert into inventory.low_stock_alerts (
      business_id, location_id, product_id, remaining_quantity_grams,
      threshold_quantity_grams, status, last_triggered_at
    )
    values (
      v_business_id, v_location_id, v_product_id,
      v_location_stock.quantity_on_hand_grams, v_threshold, 'open', now()
    )
    on conflict (location_id, product_id, status) do update set
      remaining_quantity_grams = excluded.remaining_quantity_grams,
      threshold_quantity_grams = excluded.threshold_quantity_grams,
      last_triggered_at = now();
  elsif v_threshold is null or v_threshold <= 0 or v_location_stock.quantity_on_hand_grams > v_threshold then
    update inventory.low_stock_alerts
    set status = 'resolved',
        resolved_at = now(),
        metadata = metadata || jsonb_build_object('resolvedBy', 'stock_adjustment')
    where location_id = v_location_id
      and product_id = v_product_id
      and status = 'open';
  end if;

  return jsonb_build_object(
    'locationStockId', v_location_stock.id,
    'movementId', v_movement.id,
    'quantityOnHandGrams', v_location_stock.quantity_on_hand_grams,
    'lowStockThresholdGrams', v_threshold,
    'idempotentReplay', false
  );
end;
$$;

revoke all on function inventory.adjust_location_stock(jsonb) from public;
grant execute on function inventory.adjust_location_stock(jsonb) to service_role;

comment on function inventory.adjust_location_stock(jsonb) is
  'Atomically updates location stock, writes an auditable movement, and maintains low-stock '
  'alert state. Honours idempotencyKey for safe retries and the location negative-stock policy.';

-- =============================================================================
-- 7. lab.save_formula_with_reconciliation — the "where configured" gate
-- =============================================================================
-- Reproduced from 0069 with THREE additions and no other change. The reversal /
-- re-deduction reconciliation is deliberately untouched: it is what makes a
-- formula correction net correctly (30g -> 20g nets to 20g, not 50g) and a
-- product swap credit product A while consuming product B, and it derives the
-- credit from the movement ledger rather than from lab.formula_items so a draft
-- save that never deducted adds nothing back.
create or replace function lab.save_formula_with_reconciliation(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, lab, inventory, billing, booking, core
as $$
declare
  v_external_formula_id text := p_payload->>'formulaId';
  v_formula_id uuid;
  v_existing_formula_id uuid;
  v_target_formula_id uuid;
  v_business_id uuid := nullif(p_payload->>'businessId', '')::uuid;
  v_location_id uuid := nullif(p_payload->>'locationId', '')::uuid;
  v_visit_id uuid := nullif(p_payload->>'visitId', '')::uuid;
  v_appointment_id uuid := nullif(p_payload->>'appointmentId', '')::uuid;
  v_client_profile_id uuid := nullif(p_payload->>'clientProfileId', '')::uuid;
  v_lab_session_id uuid := nullif(p_payload->>'labSessionId', '')::uuid;
  v_acting_staff_profile_id uuid := nullif(p_payload->>'actingStaffProfileId', '')::uuid;
  -- Draft saves persist as status='draft' so status='saved' readers (checkout
  -- reconciliation, receipts, analytics) keep meaning "finalized mix". Absent
  -- flag defaults to 'saved' to preserve pre-draft behaviour.
  v_status lab.formula_status_enum :=
    case when coalesce((p_payload->>'finalizeRequested')::boolean, true) then 'saved' else 'draft' end;
  v_service_name_snapshot text;
  v_notes text := nullif(p_payload->>'notes', '');
  v_currency_code char(3) := coalesce(nullif(p_payload->>'currencyCode', ''), 'GBP')::char(3);
  v_actual_cost_cents integer := greatest(coalesce((p_payload->>'totalCostCents')::integer, 0), 0);
  v_waste_cost_cents integer := greatest(coalesce((p_payload->>'totalWasteCostCents')::integer, 0), 0);
  v_billable_charge_cents integer := 0;
  v_billing_requested boolean := coalesce((p_payload->>'billingHandoffRequested')::boolean, false);
  v_inventory_requested boolean := coalesce((p_payload->>'inventoryDeductionRequested')::boolean, true);
  v_rule billing.billing_rules%rowtype;
  v_saved_at timestamptz := now();
  v_item jsonb;
  v_formula_item_id uuid;
  v_product_id uuid;
  v_used_grams numeric(12,3);
  v_waste_grams numeric(12,3);
  v_cost_per_gram_cents integer;
  v_cost_cents integer;
  v_waste_item_cost_cents integer;
  v_remaining_grams numeric(12,3);
  v_threshold_grams numeric(12,3);
  -- Week 6: the "where configured" gate and the negative-stock policy.
  v_location_deduction_enabled boolean;
  v_allow_negative boolean;
  v_projected_grams numeric(12,3);
begin
  if v_external_formula_id is null then
    raise exception 'formulaId is required';
  end if;

  if v_visit_id is not null then
    select business_id, location_id, appointment_id, client_profile_id, service_summary
    into v_business_id, v_location_id, v_appointment_id, v_client_profile_id, v_service_name_snapshot
    from booking.visits
    where id = v_visit_id;
  elsif v_appointment_id is not null then
    select business_id, location_id, id, client_profile_id
    into v_business_id, v_location_id, v_appointment_id, v_client_profile_id
    from booking.appointments
    where id = v_appointment_id;
  end if;

  -- Durable service label: prefer the visit summary, else the appointment's services.
  if v_service_name_snapshot is null and v_appointment_id is not null then
    select string_agg(service_name_snapshot, ' + ')
    into v_service_name_snapshot
    from booking.appointment_services
    where appointment_id = v_appointment_id;
  end if;

  if v_business_id is null or v_location_id is null or v_client_profile_id is null then
    raise exception 'businessId, locationId, and clientProfileId are required when no visit/appointment resolves them';
  end if;

  -- Week 6 — "deduct usage from stock WHERE CONFIGURED". Until now the only
  -- gate was inventoryDeductionRequested, a flag supplied by the CLIENT that
  -- defaults to true; a location had no way to turn deduction off. The payload
  -- flag keeps its documented meaning (a draft save opts out, 0069) and the
  -- location setting is now ANDed with it. Default true, so every existing
  -- location behaves exactly as before.
  --
  -- Deliberately NOT gated on products.is_lab_use: 0079 only backfilled that
  -- column for rows created before 2026-08-05 and it has never had a write
  -- path, so gating on it would silently stop deducting for newer products.
  select ls.stock_deduction_enabled into v_location_deduction_enabled
  from core.location_settings ls
  where ls.location_id = v_location_id;

  v_inventory_requested := v_inventory_requested and coalesce(v_location_deduction_enabled, true);

  select coalesce(ls.allow_negative_stock, true) into v_allow_negative
  from core.location_settings ls
  where ls.location_id = v_location_id;
  v_allow_negative := coalesce(v_allow_negative, true);

  select * into v_rule
  from billing.billing_rules
  where business_id = v_business_id
    and location_id = v_location_id
    and is_active
  limit 1;

  if v_rule.id is null then
    insert into billing.billing_rules (business_id, location_id, formula_billing_mode, formula_markup_percent)
    values (v_business_id, v_location_id, 'cost_only', null)
    returning * into v_rule;
  end if;

  if v_rule.formula_billing_mode = 'cost_only' then
    v_billable_charge_cents := v_actual_cost_cents;
  elsif v_rule.formula_billing_mode = 'fixed_uplift' then
    v_billable_charge_cents := v_actual_cost_cents + round(coalesce(v_rule.formula_fixed_uplift_amount, 0) * 100)::integer;
  else
    v_billable_charge_cents := round(v_actual_cost_cents * (1 + coalesce(v_rule.formula_markup_percent, 0) / 100))::integer;
  end if;

  select id into v_existing_formula_id
  from lab.formulas
  where external_formula_id = v_external_formula_id
    and business_id = v_business_id;

  -- Stable target id: reuse the existing row on edit, else a fresh id that also
  -- seeds this formula's version group (version_group_id = id for a new record).
  v_target_formula_id := coalesce(v_existing_formula_id, extensions.gen_random_uuid());

  if v_existing_formula_id is not null and v_inventory_requested then
    -- Return previously-deducted stock before re-deducting the new items.
    -- Derived from the formula's own movement ledger (usage + waste net of
    -- prior reversals), NOT from lab.formula_items: a save that never deducted
    -- inventory (a draft save) has no movements, so a later finalize adds
    -- nothing back. Credits stock at the location the deduction happened.
    update inventory.location_stock ls
    set quantity_on_hand_grams = ls.quantity_on_hand_grams + prior.net_deducted_grams
    from (
      select sm.location_id, sm.product_id, -sum(sm.quantity_delta_grams) as net_deducted_grams
      from inventory.stock_movements sm
      where sm.formula_id = v_existing_formula_id
        and sm.movement_type in ('formula_usage', 'formula_waste', 'formula_reversal')
      group by sm.location_id, sm.product_id
      having sum(sm.quantity_delta_grams) < 0
    ) prior
    where ls.location_id = prior.location_id
      and ls.product_id = prior.product_id;

    -- Ledger entry for the reversal (runs after the credit above so its own
    -- aggregate still reflects only the pre-existing movements).
    insert into inventory.stock_movements (
      business_id, location_id, product_id, formula_id,
      movement_type, quantity_delta_grams, reason
    )
    select
      sm.business_id,
      sm.location_id,
      sm.product_id,
      v_existing_formula_id,
      'formula_reversal',
      -sum(sm.quantity_delta_grams),
      'formula_edit_reconciliation'
    from inventory.stock_movements sm
    where sm.formula_id = v_existing_formula_id
      and sm.movement_type in ('formula_usage', 'formula_waste', 'formula_reversal')
    group by sm.business_id, sm.location_id, sm.product_id
    having sum(sm.quantity_delta_grams) < 0;
  end if;

  insert into lab.formulas (
    id, external_formula_id, business_id, location_id, lab_session_id, appointment_id,
    visit_id, client_profile_id, status, actual_cost_cents, waste_cost_cents,
    billable_charge_cents, currency_code, metadata, saved_at,
    created_by_staff_profile_id, updated_by_staff_profile_id, service_name_snapshot,
    notes, version, version_group_id
  ) values (
    v_target_formula_id,
    v_external_formula_id,
    v_business_id,
    v_location_id,
    v_lab_session_id,
    v_appointment_id,
    v_visit_id,
    v_client_profile_id,
    v_status,
    v_actual_cost_cents,
    v_waste_cost_cents,
    v_billable_charge_cents,
    v_currency_code,
    p_payload,
    v_saved_at,
    v_acting_staff_profile_id,
    v_acting_staff_profile_id,
    v_service_name_snapshot,
    v_notes,
    1,
    v_target_formula_id
  )
  on conflict (business_id, external_formula_id) do update set
    lab_session_id = excluded.lab_session_id,
    appointment_id = excluded.appointment_id,
    visit_id = coalesce(excluded.visit_id, lab.formulas.visit_id),
    client_profile_id = excluded.client_profile_id,
    -- Finalize promotes draft -> saved; a draft re-save never demotes an
    -- already-finalized (billed/deducted) formula back to draft.
    status = case when lab.formulas.status = 'saved' then 'saved'::lab.formula_status_enum else excluded.status end,
    actual_cost_cents = excluded.actual_cost_cents,
    waste_cost_cents = excluded.waste_cost_cents,
    billable_charge_cents = excluded.billable_charge_cents,
    currency_code = excluded.currency_code,
    metadata = excluded.metadata,
    saved_at = excluded.saved_at,
    updated_by_staff_profile_id = excluded.updated_by_staff_profile_id,
    service_name_snapshot = coalesce(excluded.service_name_snapshot, lab.formulas.service_name_snapshot),
    notes = excluded.notes
  returning id into v_formula_id;

  delete from inventory.waste_events where formula_id = v_formula_id;
  delete from lab.formula_items where formula_id = v_formula_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb))
  loop
    v_product_id := nullif(v_item->>'productId', '')::uuid;
    v_used_grams := greatest(coalesce((v_item->>'capturedGrams')::numeric, 0), 0);
    v_waste_grams := greatest(coalesce((v_item->>'wasteGrams')::numeric, 0), 0);
    v_cost_per_gram_cents := nullif(v_item->>'costPerGramCents', '')::integer;
    v_cost_cents := greatest(coalesce((v_item->>'costCents')::integer, round(v_used_grams * coalesce(v_cost_per_gram_cents, 0))::integer), 0);
    v_waste_item_cost_cents := greatest(coalesce((v_item->>'wasteCostCents')::integer, round(v_waste_grams * coalesce(v_cost_per_gram_cents, 0))::integer), 0);

    insert into lab.formula_items (
      formula_id, external_item_id, product_id, product_name, brand, shade, developer,
      ratio, processing_time_minutes, captured_grams, waste_grams, entry_mode,
      captured_at, cost_per_gram_cents, cost_cents, waste_cost_cents, notes
    ) values (
      v_formula_id,
      v_item->>'id',
      v_product_id,
      coalesce(nullif(v_item->>'productName', ''), 'Untitled ingredient'),
      nullif(v_item->>'brand', ''),
      nullif(v_item->>'shade', ''),
      nullif(v_item->>'developer', ''),
      nullif(v_item->>'ratio', ''),
      nullif(v_item->>'processingTimeMinutes', '')::integer,
      v_used_grams,
      v_waste_grams,
      coalesce(nullif(v_item->>'entryMode', ''), 'manual')::lab.formula_entry_mode_enum,
      nullif(v_item->>'capturedAt', '')::timestamptz,
      v_cost_per_gram_cents,
      v_cost_cents,
      v_waste_item_cost_cents,
      nullif(v_item->>'notes', '')
    )
    returning id into v_formula_item_id;

    -- Waste only becomes a durable event once the mix is reconciled against
    -- stock — a draft save (inventory off) must not record waste that never
    -- left the shelf.
    if v_waste_grams > 0 and v_inventory_requested then
      insert into inventory.waste_events (
        business_id, location_id, product_id, formula_id, formula_item_id,
        waste_grams, waste_cost_cents
      ) values (
        v_business_id, v_location_id, v_product_id, v_formula_id, v_formula_item_id,
        v_waste_grams, v_waste_item_cost_cents
      );
    end if;

    if v_inventory_requested and v_product_id is not null and (v_used_grams + v_waste_grams) > 0 then
      insert into inventory.location_stock (business_id, location_id, product_id, quantity_on_hand_grams)
      values (v_business_id, v_location_id, v_product_id, 0)
      on conflict (location_id, product_id) do nothing;

      -- Negative-stock policy. Allow-and-flag by default; a location may opt
      -- into refusing instead. Checked per item so the error names the product.
      if not v_allow_negative then
        select ls.quantity_on_hand_grams - (v_used_grams + v_waste_grams)
        into v_projected_grams
        from inventory.location_stock ls
        where ls.location_id = v_location_id
          and ls.product_id = v_product_id;

        if coalesce(v_projected_grams, 0) < 0 then
          raise exception 'Insufficient stock for product % at this location (% short)',
            v_product_id, abs(v_projected_grams)
            using errcode = 'check_violation';
        end if;
      end if;

      update inventory.location_stock
      set quantity_on_hand_grams = quantity_on_hand_grams - (v_used_grams + v_waste_grams)
      where location_id = v_location_id
        and product_id = v_product_id
      returning quantity_on_hand_grams,
        coalesce(low_stock_threshold_grams, (
          select p.low_stock_threshold_grams from inventory.products p where p.id = v_product_id
        ))
      into v_remaining_grams, v_threshold_grams;

      insert into inventory.stock_movements (
        business_id, location_id, product_id, formula_id, formula_item_id,
        movement_type, quantity_delta_grams, unit_cost_cents, total_cost_cents, reason
      ) values (
        v_business_id, v_location_id, v_product_id, v_formula_id, v_formula_item_id,
        'formula_usage', -v_used_grams, v_cost_per_gram_cents, v_cost_cents, 'formula_saved'
      );

      if v_waste_grams > 0 then
        insert into inventory.stock_movements (
          business_id, location_id, product_id, formula_id, formula_item_id,
          movement_type, quantity_delta_grams, unit_cost_cents, total_cost_cents, reason
        ) values (
          v_business_id, v_location_id, v_product_id, v_formula_id, v_formula_item_id,
          'formula_waste', -v_waste_grams, v_cost_per_gram_cents, v_waste_item_cost_cents, 'formula_waste'
        );
      end if;

      if v_threshold_grams is not null and v_threshold_grams > 0 and v_remaining_grams <= v_threshold_grams then
        insert into inventory.low_stock_alerts (
          business_id, location_id, product_id, remaining_quantity_grams, threshold_quantity_grams, status, last_triggered_at
        ) values (
          v_business_id, v_location_id, v_product_id, v_remaining_grams, v_threshold_grams, 'open', now()
        )
        on conflict (location_id, product_id, status) do update set
          remaining_quantity_grams = excluded.remaining_quantity_grams,
          threshold_quantity_grams = excluded.threshold_quantity_grams,
          last_triggered_at = now();
      end if;
    end if;
  end loop;

  -- formula_colour line item intentionally removed: product cost is billed via
  -- the product_usage line (applyProductBillingLineItem / 0028_product_auto_billing).

  return jsonb_build_object(
    'formulaId', v_external_formula_id,
    'persistedFormulaId', v_formula_id,
    'actualCostCents', v_actual_cost_cents,
    'wasteCostCents', v_waste_cost_cents,
    'billableChargeCents', v_billable_charge_cents,
    'currencyCode', v_currency_code,
    'billingApplied', v_visit_id is not null and v_billing_requested and v_rule.auto_bill_formula_on_save,
    'visitId', v_visit_id
  );
end;
$$;

revoke all on function lab.save_formula_with_reconciliation(jsonb) from public;
grant execute on function lab.save_formula_with_reconciliation(jsonb) to service_role;

comment on function lab.save_formula_with_reconciliation(jsonb) is
  'Persists a QLOOQO Lab formula and reconciles inventory: reverses the formula''s '
  'prior movements, re-deducts current usage and waste, records waste events and '
  'maintains low-stock alerts. Deduction is gated on core.location_settings.'
  'stock_deduction_enabled AND the payload draft-save flag.';

-- =============================================================================
-- 8. billing.record_retail_sale — stop silently skipping stock deduction
-- =============================================================================
-- Reproduced from 0031 with the deduction guard replaced; everything else is
-- unchanged. See the inline comment for the defect this fixes.
--
-- BEHAVIOUR CHANGE, DELIBERATE: a retail product with neither a pack size nor a
-- 'unit' stock unit now RAISES instead of selling without deducting. Section 2b
-- backfills pack_size from size_value first, so only products that never had a
-- size are affected — and for those, silent stock drift was the alternative.
create or replace function billing.record_retail_sale(p_payload jsonb)
returns billing.retail_sales
language plpgsql
security definer
set search_path = public, billing, inventory, booking, core
as $$
declare
  v_business_id uuid := nullif(p_payload->>'businessId', '')::uuid;
  v_location_id uuid := nullif(p_payload->>'locationId', '')::uuid;
  v_product_id uuid := nullif(p_payload->>'productId', '')::uuid;
  v_staff_id uuid := nullif(p_payload->>'staffProfileId', '')::uuid;
  v_client_id uuid := nullif(p_payload->>'clientProfileId', '')::uuid;
  v_visit_id uuid := nullif(p_payload->>'visitId', '')::uuid;
  v_quantity integer := coalesce((p_payload->>'quantity')::integer, 0);
  v_unit_price integer := coalesce(nullif(p_payload->>'unitPriceCents', '')::integer, -1);
  v_payment_method text := nullif(p_payload->>'paymentMethod', '');
  v_currency char(3) := coalesce(nullif(p_payload->>'currencyCode', ''), 'GBP');
  v_sold_at timestamptz := coalesce(nullif(p_payload->>'soldAt', '')::timestamptz, now());
  v_created_by uuid := nullif(p_payload->>'createdBy', '')::uuid;
  v_notes text := nullif(p_payload->>'notes', '');
  v_product inventory.products%rowtype;
  v_grams numeric(12,3);
  v_pack_size numeric(12,3);
  v_total integer;
  v_sale billing.retail_sales%rowtype;
begin
  if v_business_id is null or v_location_id is null or v_product_id is null then
    raise exception 'businessId, locationId and productId are required';
  end if;
  if v_quantity <= 0 then
    raise exception 'quantity must be a positive integer';
  end if;

  select * into v_product
  from inventory.products
  where id = v_product_id and business_id = v_business_id and is_active;
  if not found then
    raise exception 'Product is not active for this business';
  end if;

  -- Default unit price to the product's configured retail price when omitted.
  if v_unit_price < 0 then
    v_unit_price := coalesce(v_product.retail_price_cents, 0);
  end if;
  v_total := v_unit_price * v_quantity;

  insert into billing.retail_sales (
    business_id, location_id, staff_profile_id, product_id, client_profile_id, visit_id,
    quantity, unit_price_cents, total_amount_cents, currency_code, payment_method,
    sold_at, notes, created_by_user_profile_id
  ) values (
    v_business_id, v_location_id, v_staff_id, v_product_id, v_client_id, v_visit_id,
    v_quantity, v_unit_price, v_total, v_currency, v_payment_method,
    v_sold_at, v_notes, v_created_by
  ) returning * into v_sale;

  -- Week 6 defect fix. This previously read:
  --     v_grams := v_quantity * coalesce(v_product.size_value, 0);
  --     if v_grams > 0 then ...
  -- so a retail product with no size_value sold with NO stock deduction and NO
  -- movement row, silently. Stock and the ledger simply drifted. Resolve the
  -- quantity explicitly and fail loudly when it cannot be resolved.
  if v_product.stock_unit = 'unit' then
    -- The stock column counts whole items for this product, so one sold item
    -- is one unit of stock. No pack size is involved.
    v_grams := v_quantity;
  else
    v_pack_size := coalesce(v_product.pack_size, v_product.size_value);
    if v_pack_size is null or v_pack_size <= 0 then
      raise exception
        'Product % has no pack size recorded, so the sale cannot deduct stock. Set a size on the product, or set its stock unit to ''unit'', before selling it.',
        coalesce(v_product.name, v_product_id::text)
        using errcode = 'check_violation';
    end if;
    v_grams := v_quantity * v_pack_size;
  end if;

  if v_grams > 0 then
    perform inventory.adjust_location_stock(jsonb_build_object(
      'businessId', v_business_id,
      'locationId', v_location_id,
      'productId', v_product_id,
      'quantityDeltaGrams', (-v_grams),
      'movementType', 'retail_sale',
      'referenceType', 'retail_sale',
      'referenceId', v_sale.id,
      'createdBy', v_created_by,
      'notes', v_notes
    ));

    update billing.retail_sales
    set stock_movement_id = (
      select id from inventory.stock_movements
      where reference_type = 'retail_sale' and reference_id = v_sale.id
      order by created_at desc
      limit 1
    )
    where id = v_sale.id
    returning * into v_sale;
  end if;

  return v_sale;
end;
$$;

revoke all on function billing.record_retail_sale(jsonb) from public;
grant execute on function billing.record_retail_sale(jsonb) to service_role;

-- =============================================================================
-- 9. Indexes Colour Prep reads through
-- =============================================================================
-- Colour Prep scans appointments in a date window for one location, then walks
-- appointment -> services -> categories and client -> latest saved formula.
create index if not exists idx_appointments_location_scheduled_status
  on booking.appointments (location_id, scheduled_start_at, status);

create index if not exists idx_formulas_client_saved_at
  on lab.formulas (client_profile_id, status, saved_at desc);

create index if not exists idx_formula_items_formula_product
  on lab.formula_items (formula_id, product_id);
