-- 0029_remove_formula_colour_line.sql
-- Removes the legacy `formula_colour` billing line. Product cost is now billed
-- exclusively through the `product_usage` line (see 0028_product_auto_billing.sql),
-- which applies the location's product billing rule and snapshots it immutably.
--
-- 1. Replace save_formula_with_reconciliation so it no longer emits a
--    formula_colour visit line item (the rest of the body is unchanged).
-- 2. Delete any formula_colour line items already written.

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
  v_business_id uuid := nullif(p_payload->>'businessId', '')::uuid;
  v_location_id uuid := nullif(p_payload->>'locationId', '')::uuid;
  v_visit_id uuid := nullif(p_payload->>'visitId', '')::uuid;
  v_appointment_id uuid := nullif(p_payload->>'appointmentId', '')::uuid;
  v_client_profile_id uuid := nullif(p_payload->>'clientProfileId', '')::uuid;
  v_lab_session_id uuid := nullif(p_payload->>'labSessionId', '')::uuid;
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
    select business_id, location_id, appointment_id, client_profile_id
    into v_business_id, v_location_id, v_appointment_id, v_client_profile_id
    from booking.visits
    where id = v_visit_id;
  elsif v_appointment_id is not null then
    select business_id, location_id, id, client_profile_id
    into v_business_id, v_location_id, v_appointment_id, v_client_profile_id
    from booking.appointments
    where id = v_appointment_id;
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
  where external_formula_id = v_external_formula_id;

  if v_existing_formula_id is not null and v_inventory_requested then
    insert into inventory.stock_movements (
      business_id, location_id, product_id, formula_id, formula_item_id,
      movement_type, quantity_delta_grams, reason
    )
    select
      f.business_id,
      f.location_id,
      fi.product_id,
      f.id,
      fi.id,
      'formula_reversal',
      fi.captured_grams + fi.waste_grams,
      'formula_edit_reconciliation'
    from lab.formulas f
    join lab.formula_items fi on fi.formula_id = f.id
    where f.id = v_existing_formula_id
      and fi.product_id is not null
      and (fi.captured_grams + fi.waste_grams) > 0;

    update inventory.location_stock ls
    set quantity_on_hand_grams = ls.quantity_on_hand_grams + old_usage.total_grams
    from (
      select fi.product_id, sum(fi.captured_grams + fi.waste_grams) as total_grams
      from lab.formula_items fi
      where fi.formula_id = v_existing_formula_id
        and fi.product_id is not null
      group by fi.product_id
    ) old_usage
    where ls.location_id = v_location_id
      and ls.product_id = old_usage.product_id;
  end if;

  insert into lab.formulas (
    id, external_formula_id, business_id, location_id, lab_session_id, appointment_id,
    visit_id, client_profile_id, status, actual_cost_cents, waste_cost_cents,
    billable_charge_cents, currency_code, metadata, saved_at
  ) values (
    coalesce(v_existing_formula_id, extensions.gen_random_uuid()),
    v_external_formula_id,
    v_business_id,
    v_location_id,
    v_lab_session_id,
    v_appointment_id,
    v_visit_id,
    v_client_profile_id,
    'saved',
    v_actual_cost_cents,
    v_waste_cost_cents,
    v_billable_charge_cents,
    v_currency_code,
    p_payload,
    v_saved_at
  )
  on conflict (external_formula_id) do update set
    lab_session_id = excluded.lab_session_id,
    appointment_id = excluded.appointment_id,
    visit_id = excluded.visit_id,
    client_profile_id = excluded.client_profile_id,
    status = 'saved',
    actual_cost_cents = excluded.actual_cost_cents,
    waste_cost_cents = excluded.waste_cost_cents,
    billable_charge_cents = excluded.billable_charge_cents,
    currency_code = excluded.currency_code,
    metadata = excluded.metadata,
    saved_at = excluded.saved_at
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

    if v_waste_grams > 0 then
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

-- Remove legacy formula_colour line items so historical visits show only the
-- product_usage charge going forward.
delete from billing.visit_line_items where line_type = 'formula_colour';
