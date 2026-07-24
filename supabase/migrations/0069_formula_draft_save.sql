-- 0069_formula_draft_save.sql
-- Supports durable draft saves from Qlooqo Lab stations (Wrike 4507281407
-- follow-up: "Save Draft" was device-local only and never reached lab.formulas).
--
-- A draft save runs this same RPC with finalizeRequested=false,
-- billingHandoffRequested=false and inventoryDeductionRequested=false, then a
-- later finalize upserts the SAME row (business_id, external_formula_id) with
-- all three true. Drafts persist as status='draft' (finalize promotes to
-- 'saved', never the reverse) so every status='saved' reader — checkout
-- product-usage reconciliation, client receipts, lab analytics — keeps meaning
-- "finalized mix" and drafts are never billed or counted. waste_events writes
-- are now also gated on inventory reconciliation for the same reason.
--
-- The draft flow exposed a latent stock-inflation bug in every prior version
-- of the RPC (0021/0029/0063/0068):
-- the edit-reconciliation "reversal" credited captured+waste grams read from
-- lab.formula_items, regardless of whether stock had ever actually been
-- deducted for that formula. A draft save (no deduction) followed by a finalize
-- would therefore ADD BACK stock that was never taken.
--
-- This migration re-derives the reversal from the formula's own movement
-- ledger (inventory.stock_movements: formula_usage + formula_waste net of
-- prior formula_reversal rows), so only stock actually deducted is returned.
-- It also credits the stock row at the location where the deduction happened
-- (previously the new payload's location).
--
-- It ALSO scopes the external_formula_id upsert key per business. The lab app
-- historically sent per-launch counter ids ("local-formula-draft-1") that
-- repeat across stations and restarts, and the old GLOBAL unique constraint +
-- unscoped upsert let a later mix silently overwrite another formula row —
-- even one belonging to a different business. The app now sends globally
-- unique draft ids, and this constraint keeps any residual collision from
-- ever crossing a business boundary. Body is otherwise identical to 0068.

-- Per-business upsert key (existing data satisfies this trivially: the old
-- constraint was globally unique).
alter table lab.formulas
  drop constraint if exists formulas_external_formula_id_key;
alter table lab.formulas
  add constraint formulas_business_external_formula_id_key unique (business_id, external_formula_id);

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
