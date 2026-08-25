-- week6_purchase_orders.sql — behavioural suite for migration 0094.
--
-- WHY THIS FILE EXISTS. Two rules live in plpgsql where Jest cannot see them:
-- the gapless per-business PO numbering (a lost race must roll the counter
-- back) and the one-open-order-per-supplier+location guarantee that makes a
-- retried "generate" safe. The reorder_usage aggregate's outbound-only window
-- is also proved here against real rows.
--
-- 8 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0095 applied
-- (0095 widened OPEN to include approved-but-unsent orders):
--   psql -d <scratch> -f supabase/tests/week6_purchase_orders.sql

\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures. 'ee' prefix, hex-only UUIDs, distinct from the other suites.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('ee000000-0000-0000-0000-000000000001','Order Salon','order-salon');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('ee000000-0000-0000-0000-000000000ea1','ee000000-0000-0000-0000-000000000001','E1','Main','ee-main','1 St','Leeds','LS3 1AA','Europe/London');

insert into inventory.suppliers (id,business_id,name,contact_email) values
 ('ee000000-0000-0000-0000-000000000e51','ee000000-0000-0000-0000-000000000001','Supplier A','a@sup.test'),
 ('ee000000-0000-0000-0000-000000000e52','ee000000-0000-0000-0000-000000000001','Supplier B','b@sup.test');

insert into inventory.products (id,business_id,name,default_unit,stock_unit,pack_size) values
 ('ee000000-0000-0000-0000-000000000e01','ee000000-0000-0000-0000-000000000001','Order Colour','g','gram',100);

-- ===========================================================================
-- 1. FIRST ORDER — created=true with the first gapless number.
-- ===========================================================================
select '01_FIRST_ORDER' as case,
       case when created = true and order_number = 'PO-00001' then 'PASS'
            else 'FAIL: got created='||created||' number='||order_number end as result
from inventory.create_purchase_order(
  jsonb_build_object(
    'business_id','ee000000-0000-0000-0000-000000000001',
    'location_id','ee000000-0000-0000-0000-000000000ea1',
    'supplier_id','ee000000-0000-0000-0000-000000000e51',
    'subtotal_cents', 3000),
  jsonb_build_array(jsonb_build_object(
    'product_id','ee000000-0000-0000-0000-000000000e01',
    'product_name','Order Colour','pack_size',100,'stock_unit','gram',
    'suggested_quantity',6,'ordered_quantity',6,'unit_cost_cents',500,'line_total_cents',3000)));

-- ===========================================================================
-- 2. RETRIED GENERATE — same supplier+location returns the SAME order,
--    created=false, and burns no number.
-- ===========================================================================
select '02_RETRY_RETURNS_EXISTING' as case,
       case when created = false and order_number = 'PO-00001' then 'PASS'
            else 'FAIL: got created='||created||' number='||order_number end as result
from inventory.create_purchase_order(
  jsonb_build_object(
    'business_id','ee000000-0000-0000-0000-000000000001',
    'location_id','ee000000-0000-0000-0000-000000000ea1',
    'supplier_id','ee000000-0000-0000-0000-000000000e51'),
  '[]'::jsonb);

-- ===========================================================================
-- 3. SECOND SUPPLIER — gets the NEXT number (PO-00002): the retry above did
--    not burn one.
-- ===========================================================================
select '03_GAPLESS_NEXT_NUMBER' as case,
       case when created = true and order_number = 'PO-00002' then 'PASS'
            else 'FAIL: got created='||created||' number='||order_number end as result
from inventory.create_purchase_order(
  jsonb_build_object(
    'business_id','ee000000-0000-0000-0000-000000000001',
    'location_id','ee000000-0000-0000-0000-000000000ea1',
    'supplier_id','ee000000-0000-0000-0000-000000000e52'),
  '[]'::jsonb);

-- ===========================================================================
-- 4. LINES + SNAPSHOTS — the first order's line froze name/pack/unit.
-- ===========================================================================
select '04_LINE_SNAPSHOTS' as case,
       case when exists (
         select 1 from inventory.purchase_order_lines l
         join inventory.purchase_orders po on po.id = l.purchase_order_id
         where po.order_number = 'PO-00001'
           and l.product_name_snapshot = 'Order Colour'
           and l.pack_size_snapshot = 100
           and l.stock_unit_snapshot = 'gram'
           and l.ordered_quantity = 6
           and l.line_total_cents = 3000)
       then 'PASS' else 'FAIL: line missing or snapshot wrong' end as result;

-- ===========================================================================
-- 5. APPROVED IS STILL OPEN (0095) — an approved-but-unsent order covers its
--    supplier, so a repeated generate must hand it back, not duplicate spend.
-- ===========================================================================
update inventory.purchase_orders set status = 'approved', approved_at = now()
where order_number = 'PO-00001';

select '05_APPROVED_STILL_OPEN' as case,
       case when created = false and order_number = 'PO-00001' then 'PASS'
            else 'FAIL: got created='||created||' number='||order_number end as result
from inventory.create_purchase_order(
  jsonb_build_object(
    'business_id','ee000000-0000-0000-0000-000000000001',
    'location_id','ee000000-0000-0000-0000-000000000ea1',
    'supplier_id','ee000000-0000-0000-0000-000000000e51'),
  '[]'::jsonb);

-- ===========================================================================
-- 6. CLOSED ORDERS FREE THE SLOT — cancel the open order for supplier A,
--    generate again: a NEW order (PO-00003) is created.
-- ===========================================================================
update inventory.purchase_orders set status = 'cancelled', cancelled_at = now()
where order_number = 'PO-00001';

select '06_CLOSED_FREES_SLOT' as case,
       case when created = true and order_number = 'PO-00003' then 'PASS'
            else 'FAIL: got created='||created||' number='||order_number end as result
from inventory.create_purchase_order(
  jsonb_build_object(
    'business_id','ee000000-0000-0000-0000-000000000001',
    'location_id','ee000000-0000-0000-0000-000000000ea1',
    'supplier_id','ee000000-0000-0000-0000-000000000e51'),
  '[]'::jsonb);

-- ===========================================================================
-- 7. REORDER USAGE — outbound-only inside the window: the restock and the
--    outbound before the cutoff must not count.
-- ===========================================================================
insert into inventory.stock_movements (business_id,location_id,product_id,movement_type,quantity_delta_grams,created_at) values
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-000000000ea1','ee000000-0000-0000-0000-000000000e01','restock',           1000, now() - interval '10 days'),
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-000000000ea1','ee000000-0000-0000-0000-000000000e01','formula_usage',     -120, now() - interval '9 days'),
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-000000000ea1','ee000000-0000-0000-0000-000000000e01','retail_sale',        -80, now() - interval '2 days'),
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-000000000ea1','ee000000-0000-0000-0000-000000000e01','formula_usage',     -500, now() - interval '60 days');

select '07_OUTBOUND_ONLY_WINDOW' as case,
       case when (select outbound_base from inventory.reorder_usage(
                    'ee000000-0000-0000-0000-000000000001',
                    'ee000000-0000-0000-0000-000000000ea1',
                    now() - interval '28 days')
                  where product_id = 'ee000000-0000-0000-0000-000000000e01') = 200
       then 'PASS'
       else 'FAIL: expected 200 (120+80; restock and the 60-day-old usage excluded)' end as result;

-- ===========================================================================
-- 8. PERMISSION SEEDS — manager prepares, only owner/group_admin approve.
-- ===========================================================================
select '08_PERMISSION_SEEDS' as case,
       case when not exists (
              select 1 from core.security_levels
              where is_system = true and key = 'manager'
                and not (permissions @> '["orders.view"]'::jsonb
                     and permissions @> '["orders.manage"]'::jsonb))
         and not exists (
              select 1 from core.security_levels
              where is_system = true and key = 'manager'
                and permissions @> '["orders.approve"]'::jsonb)
         and not exists (
              select 1 from core.security_levels
              where is_system = true and key in ('owner','group_admin')
                and not permissions @> '["orders.approve"]'::jsonb)
       then 'PASS' else 'FAIL: seeded permissions do not match the intended posture' end as result;
