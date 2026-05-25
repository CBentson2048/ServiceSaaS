-- 0021_lab_billing_inventory.sql
-- Sheer Lab formula persistence, billing aggregation, inventory deduction,
-- waste tracking, and low-stock alert readiness.

do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'lab'::regnamespace and typname = 'formula_status_enum') then
    create type lab.formula_status_enum as enum ('draft', 'mixing', 'ready_for_review', 'saved', 'voided');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'lab'::regnamespace and typname = 'formula_entry_mode_enum') then
    create type lab.formula_entry_mode_enum as enum ('ble_scale', 'manual');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'inventory'::regnamespace and typname = 'stock_movement_type_enum') then
    create type inventory.stock_movement_type_enum as enum (
      'formula_usage',
      'formula_waste',
      'formula_reversal',
      'manual_adjustment'
    );
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'inventory'::regnamespace and typname = 'stock_alert_status_enum') then
    create type inventory.stock_alert_status_enum as enum ('open', 'acknowledged', 'resolved');
  end if;
end
$$;

create table if not exists inventory.products (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  name text not null,
  brand text,
  sku text,
  default_unit text not null default 'g',
  default_cost_per_gram_cents integer check (default_cost_per_gram_cents is null or default_cost_per_gram_cents >= 0),
  low_stock_threshold_grams numeric(12,3) not null default 0 check (low_stock_threshold_grams >= 0),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, sku)
);

create table if not exists inventory.location_stock (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete cascade,
  quantity_on_hand_grams numeric(12,3) not null default 0,
  low_stock_threshold_grams numeric(12,3) check (low_stock_threshold_grams is null or low_stock_threshold_grams >= 0),
  updated_at timestamptz not null default now(),
  unique (location_id, product_id)
);

create table if not exists lab.formulas (
  id uuid primary key default extensions.gen_random_uuid(),
  external_formula_id text unique,
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete restrict,
  lab_session_id uuid references lab.formula_sessions(id) on delete set null,
  appointment_id uuid references booking.appointments(id) on delete set null,
  visit_id uuid references booking.visits(id) on delete set null,
  client_profile_id uuid not null references core.client_profiles(id) on delete restrict,
  source_formula_id uuid references lab.formulas(id) on delete set null,
  status lab.formula_status_enum not null default 'saved',
  actual_cost_cents integer not null default 0 check (actual_cost_cents >= 0),
  waste_cost_cents integer not null default 0 check (waste_cost_cents >= 0),
  billable_charge_cents integer not null default 0 check (billable_charge_cents >= 0),
  currency_code char(3) not null default 'GBP',
  metadata jsonb not null default '{}'::jsonb,
  saved_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (saved_at is null or saved_at >= created_at)
);

create table if not exists lab.formula_items (
  id uuid primary key default extensions.gen_random_uuid(),
  formula_id uuid not null references lab.formulas(id) on delete cascade,
  external_item_id text,
  product_id uuid references inventory.products(id) on delete set null,
  product_name text not null,
  brand text,
  shade text,
  developer text,
  ratio text,
  processing_time_minutes integer check (processing_time_minutes is null or processing_time_minutes >= 0),
  captured_grams numeric(12,3) not null default 0 check (captured_grams >= 0),
  waste_grams numeric(12,3) not null default 0 check (waste_grams >= 0),
  entry_mode lab.formula_entry_mode_enum not null default 'manual',
  captured_at timestamptz,
  cost_per_gram_cents integer check (cost_per_gram_cents is null or cost_per_gram_cents >= 0),
  cost_cents integer not null default 0 check (cost_cents >= 0),
  waste_cost_cents integer not null default 0 check (waste_cost_cents >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (formula_id, external_item_id)
);

create table if not exists inventory.stock_movements (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete restrict,
  formula_id uuid references lab.formulas(id) on delete set null,
  formula_item_id uuid references lab.formula_items(id) on delete set null,
  movement_type inventory.stock_movement_type_enum not null,
  quantity_delta_grams numeric(12,3) not null,
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  total_cost_cents integer check (total_cost_cents is null or total_cost_cents >= 0),
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists inventory.waste_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid references inventory.products(id) on delete set null,
  formula_id uuid not null references lab.formulas(id) on delete cascade,
  formula_item_id uuid references lab.formula_items(id) on delete set null,
  waste_grams numeric(12,3) not null check (waste_grams >= 0),
  waste_cost_cents integer not null default 0 check (waste_cost_cents >= 0),
  reason text not null default 'formula_mixed_unused',
  created_at timestamptz not null default now()
);

create table if not exists inventory.low_stock_alerts (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete cascade,
  remaining_quantity_grams numeric(12,3) not null,
  threshold_quantity_grams numeric(12,3) not null,
  status inventory.stock_alert_status_enum not null default 'open',
  first_triggered_at timestamptz not null default now(),
  last_triggered_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (location_id, product_id, status)
);

create table if not exists billing.visit_line_items (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid not null references booking.visits(id) on delete cascade,
  line_type text not null,
  description text not null,
  amount_cents integer not null check (amount_cents >= 0),
  currency_code char(3) not null default 'GBP',
  formula_breakdown jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (visit_id, line_type)
);

create index if not exists idx_lab_formulas_client_saved
on lab.formulas (client_profile_id, saved_at desc)
where status = 'saved';

create index if not exists idx_lab_formulas_visit_saved
on lab.formulas (visit_id, saved_at desc)
where status = 'saved';

create index if not exists idx_formula_items_formula_id
on lab.formula_items (formula_id);

create index if not exists idx_location_stock_product_location
on inventory.location_stock (product_id, location_id);

create index if not exists idx_stock_movements_formula
on inventory.stock_movements (formula_id, created_at desc);

create index if not exists idx_waste_events_location_created
on inventory.waste_events (business_id, location_id, created_at desc);

create index if not exists idx_visit_line_items_visit
on billing.visit_line_items (visit_id);

drop trigger if exists inventory_products_set_updated_at on inventory.products;
create trigger inventory_products_set_updated_at
before update on inventory.products
for each row execute function public.set_updated_at();

drop trigger if exists location_stock_set_updated_at on inventory.location_stock;
create trigger location_stock_set_updated_at
before update on inventory.location_stock
for each row execute function public.set_updated_at();

drop trigger if exists lab_formulas_set_updated_at on lab.formulas;
create trigger lab_formulas_set_updated_at
before update on lab.formulas
for each row execute function public.set_updated_at();

drop trigger if exists formula_items_set_updated_at on lab.formula_items;
create trigger formula_items_set_updated_at
before update on lab.formula_items
for each row execute function public.set_updated_at();

drop trigger if exists visit_line_items_set_updated_at on billing.visit_line_items;
create trigger visit_line_items_set_updated_at
before update on billing.visit_line_items
for each row execute function public.set_updated_at();

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
  v_breakdown jsonb := '[]'::jsonb;
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

  if v_visit_id is not null and v_billing_requested and v_rule.auto_bill_formula_on_save then
    select coalesce(jsonb_agg(jsonb_build_object(
      'formulaId', external_formula_id,
      'actualCostCents', actual_cost_cents,
      'billableChargeCents', billable_charge_cents,
      'currencyCode', currency_code,
      'savedAt', saved_at
    ) order by saved_at), '[]'::jsonb)
    into v_breakdown
    from lab.formulas
    where visit_id = v_visit_id
      and status = 'saved';

    insert into billing.visit_line_items (
      business_id, location_id, visit_id, line_type, description,
      amount_cents, currency_code, formula_breakdown, metadata
    )
    select
      v_business_id,
      v_location_id,
      v_visit_id,
      'formula_colour',
      'Colour formula charge',
      coalesce(sum(billable_charge_cents), 0),
      v_currency_code,
      v_breakdown,
      jsonb_build_object('source', 'sheer_lab_formula')
    from lab.formulas
    where visit_id = v_visit_id
      and status = 'saved'
    on conflict (visit_id, line_type) do update set
      amount_cents = excluded.amount_cents,
      currency_code = excluded.currency_code,
      formula_breakdown = excluded.formula_breakdown,
      metadata = excluded.metadata;
  end if;

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

alter table inventory.products enable row level security;
alter table inventory.location_stock enable row level security;
alter table inventory.stock_movements enable row level security;
alter table inventory.waste_events enable row level security;
alter table inventory.low_stock_alerts enable row level security;
alter table lab.formulas enable row level security;
alter table lab.formula_items enable row level security;
alter table billing.visit_line_items enable row level security;

drop policy if exists inventory_products_owner_all on inventory.products;
create policy inventory_products_owner_all
on inventory.products for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists inventory_products_member_select on inventory.products;
create policy inventory_products_member_select
on inventory.products for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = inventory.products.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

drop policy if exists location_stock_management_all on inventory.location_stock;
create policy location_stock_management_all
on inventory.location_stock for all
using (public.has_location_management_scope(business_id, location_id))
with check (public.has_location_management_scope(business_id, location_id));

drop policy if exists stock_movements_management_select on inventory.stock_movements;
create policy stock_movements_management_select
on inventory.stock_movements for select
using (public.has_location_management_scope(business_id, location_id));

drop policy if exists waste_events_management_select on inventory.waste_events;
create policy waste_events_management_select
on inventory.waste_events for select
using (public.has_location_management_scope(business_id, location_id));

drop policy if exists low_stock_alerts_management_select on inventory.low_stock_alerts;
create policy low_stock_alerts_management_select
on inventory.low_stock_alerts for select
using (public.has_location_management_scope(business_id, location_id));

drop policy if exists lab_formulas_location_select on lab.formulas;
create policy lab_formulas_location_select
on lab.formulas for select
using (
  public.has_location_desk_access(business_id, location_id)
  or public.is_client_profile_owner(client_profile_id)
);

drop policy if exists lab_formula_items_location_select on lab.formula_items;
create policy lab_formula_items_location_select
on lab.formula_items for select
using (exists (
  select 1 from lab.formulas f
  where f.id = lab.formula_items.formula_id
    and (
      public.has_location_desk_access(f.business_id, f.location_id)
      or public.is_client_profile_owner(f.client_profile_id)
    )
));

drop policy if exists visit_line_items_management_select on billing.visit_line_items;
create policy visit_line_items_management_select
on billing.visit_line_items for select
using (public.has_location_management_scope(business_id, location_id));

grant select, insert, update, delete on all tables in schema lab, inventory, billing to authenticated, service_role;
