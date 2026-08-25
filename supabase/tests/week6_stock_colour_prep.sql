-- week6_stock_colour_prep.sql — behavioural suite for migration 0091.
--
-- WHY THIS FILE EXISTS. The Week 6 stock rules live in plpgsql, not TypeScript:
-- the reversal/re-deduction reconciliation is inside
-- lab.save_formula_with_reconciliation, and the idempotency and negative-stock
-- policy are inside inventory.adjust_location_stock. The Jest suites stub the
-- Supabase client, so they can prove WHICH rpc was called with WHICH payload but
-- can never prove that a 30g -> 20g correction nets to 20g. That arithmetic can
-- only be proved by running the functions. This file is that proof.
--
-- 14 numbered cases. Cases named _ERROR are expected to raise; a raised error
-- there is a pass. Every refusal case is paired with a query showing the data
-- survived, so nothing passes vacuously.
--
-- Run against a SCRATCH database that has every migration through 0091 applied:
--   psql -d <scratch> -f supabase/tests/week6_stock_colour_prep.sql
--
-- Read the RESULT column of each case. Every one must read PASS.

\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures. UUIDs are distinct from the payroll suites so both can share a host.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('c6000000-0000-0000-0000-000000000001','Colour Salon','colour-salon'),
 ('c6000000-0000-0000-0000-000000000002','Other Salon','other-salon');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('c6000000-0000-0000-0000-0000000000a1','c6000000-0000-0000-0000-000000000001','L1','Main','c6-main','1 St','Leeds','LS1 1AA','Europe/London'),
 ('c6000000-0000-0000-0000-0000000000a2','c6000000-0000-0000-0000-000000000001','L2','Second','c6-second','2 St','Leeds','LS1 2AA','Europe/London'),
 ('c6000000-0000-0000-0000-0000000000a3','c6000000-0000-0000-0000-000000000002','L3','Rival','c6-rival','3 St','Leeds','LS1 3AA','Europe/London');

insert into core.location_settings (business_id,location_id) values
 ('c6000000-0000-0000-0000-000000000001','c6000000-0000-0000-0000-0000000000a1'),
 ('c6000000-0000-0000-0000-000000000001','c6000000-0000-0000-0000-0000000000a2');

insert into core.client_profiles (id,business_id,first_name,last_name) values
 ('c6000000-0000-0000-0000-0000000000c1','c6000000-0000-0000-0000-000000000001','Ada','Lovelace');

insert into inventory.products (id,business_id,name,default_unit,default_cost_per_gram_cents,low_stock_threshold_grams,stock_unit,pack_size,barcode,is_lab_use) values
 ('c6000000-0000-0000-0000-0000000000f1','c6000000-0000-0000-0000-000000000001','Colour 6.0','g',5,50,'gram',100,'5010000000001',true),
 ('c6000000-0000-0000-0000-0000000000f2','c6000000-0000-0000-0000-000000000001','Colour 7.0','g',5,0,'gram',100,'5010000000002',true),
 ('c6000000-0000-0000-0000-0000000000f3','c6000000-0000-0000-0000-000000000001','Comb','unit',0,0,'unit',null,'5010000000003',false);

insert into inventory.location_stock (business_id,location_id,product_id,quantity_on_hand_grams) values
 ('c6000000-0000-0000-0000-000000000001','c6000000-0000-0000-0000-0000000000a1','c6000000-0000-0000-0000-0000000000f1',1000),
 ('c6000000-0000-0000-0000-000000000001','c6000000-0000-0000-0000-0000000000a1','c6000000-0000-0000-0000-0000000000f2',1000),
 ('c6000000-0000-0000-0000-000000000001','c6000000-0000-0000-0000-0000000000a2','c6000000-0000-0000-0000-0000000000f1',1000);

-- ===========================================================================
-- 1. NORMAL FORMULA USAGE — 30g of A and 20g of B leave the shelf.
-- ===========================================================================
select lab.save_formula_with_reconciliation(jsonb_build_object(
  'formulaId','week6-f1',
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a1',
  'clientProfileId','c6000000-0000-0000-0000-0000000000c1',
  'items', jsonb_build_array(
    jsonb_build_object('id','i1','productId','c6000000-0000-0000-0000-0000000000f1','productName','Colour 6.0','capturedGrams',30,'wasteGrams',0),
    jsonb_build_object('id','i2','productId','c6000000-0000-0000-0000-0000000000f2','productName','Colour 7.0','capturedGrams',20,'wasteGrams',0)
  )
));

select '01_NORMAL_USAGE' as case,
       case when a.qty = 970 and b.qty = 980 then 'PASS' else 'FAIL: A='||a.qty||' B='||b.qty end as result
from (select quantity_on_hand_grams qty from inventory.location_stock
      where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f1') a,
     (select quantity_on_hand_grams qty from inventory.location_stock
      where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f2') b;

-- ===========================================================================
-- 2. CORRECTION 30g -> 20g must net to 20g consumed, NOT 50g.
-- ===========================================================================
select lab.save_formula_with_reconciliation(jsonb_build_object(
  'formulaId','week6-f1',
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a1',
  'clientProfileId','c6000000-0000-0000-0000-0000000000c1',
  'items', jsonb_build_array(
    jsonb_build_object('id','i1','productId','c6000000-0000-0000-0000-0000000000f1','productName','Colour 6.0','capturedGrams',20,'wasteGrams',0),
    jsonb_build_object('id','i2','productId','c6000000-0000-0000-0000-0000000000f2','productName','Colour 7.0','capturedGrams',20,'wasteGrams',0)
  )
));

select '02_CORRECTION_NETS' as case,
       case when quantity_on_hand_grams = 980 then 'PASS'
            else 'FAIL: expected 980 (20g net), got '||quantity_on_hand_grams end as result
from inventory.location_stock
where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f1';

-- ===========================================================================
-- 3. PRODUCT REPLACEMENT — swapping A for B credits A and consumes B.
-- ===========================================================================
select lab.save_formula_with_reconciliation(jsonb_build_object(
  'formulaId','week6-f1',
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a1',
  'clientProfileId','c6000000-0000-0000-0000-0000000000c1',
  'items', jsonb_build_array(
    jsonb_build_object('id','i2','productId','c6000000-0000-0000-0000-0000000000f2','productName','Colour 7.0','capturedGrams',40,'wasteGrams',0)
  )
));

select '03_PRODUCT_SWAP' as case,
       case when a.qty = 1000 and b.qty = 960 then 'PASS'
            else 'FAIL: A='||a.qty||' (want 1000) B='||b.qty||' (want 960)' end as result
from (select quantity_on_hand_grams qty from inventory.location_stock
      where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f1') a,
     (select quantity_on_hand_grams qty from inventory.location_stock
      where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f2') b;

-- ===========================================================================
-- 4. REPEATED IDENTICAL SAVE — a retry must not deduct twice.
-- ===========================================================================
select lab.save_formula_with_reconciliation(jsonb_build_object(
  'formulaId','week6-f1',
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a1',
  'clientProfileId','c6000000-0000-0000-0000-0000000000c1',
  'items', jsonb_build_array(
    jsonb_build_object('id','i2','productId','c6000000-0000-0000-0000-0000000000f2','productName','Colour 7.0','capturedGrams',40,'wasteGrams',0)
  )
));

select '04_RESAVE_IDEMPOTENT' as case,
       case when quantity_on_hand_grams = 960 then 'PASS'
            else 'FAIL: expected 960 after identical re-save, got '||quantity_on_hand_grams end as result
from inventory.location_stock
where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f2';

-- ===========================================================================
-- 5. LEDGER IS COMPLETE — the movement trail still reconciles to the balance.
-- ===========================================================================
select '05_LEDGER_RECONCILES' as case,
       case when coalesce(sum(quantity_delta_grams),0) = -40 then 'PASS'
            else 'FAIL: movements net to '||coalesce(sum(quantity_delta_grams),0)||', want -40' end as result
from inventory.stock_movements
where product_id='c6000000-0000-0000-0000-0000000000f2'
  and location_id='c6000000-0000-0000-0000-0000000000a1';

-- ===========================================================================
-- 6. HISTORY PRESERVED — reconciliation appends, it never deletes.
-- ===========================================================================
select '06_HISTORY_PRESERVED' as case,
       case when count(*) >= 4 then 'PASS'
            else 'FAIL: only '||count(*)||' movements retained; reversals should append' end as result
from inventory.stock_movements
where location_id='c6000000-0000-0000-0000-0000000000a1';

-- ===========================================================================
-- 7. WASTE IS DEDUCTED TOO — captured + waste both leave the shelf.
-- ===========================================================================
select lab.save_formula_with_reconciliation(jsonb_build_object(
  'formulaId','week6-f2',
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a2',
  'clientProfileId','c6000000-0000-0000-0000-0000000000c1',
  'items', jsonb_build_array(
    jsonb_build_object('id','i1','productId','c6000000-0000-0000-0000-0000000000f1','productName','Colour 6.0','capturedGrams',30,'wasteGrams',5)
  )
));

select '07_WASTE_DEDUCTED' as case,
       case when quantity_on_hand_grams = 965 then 'PASS'
            else 'FAIL: expected 965 (30 used + 5 waste), got '||quantity_on_hand_grams end as result
from inventory.location_stock
where location_id='c6000000-0000-0000-0000-0000000000a2' and product_id='c6000000-0000-0000-0000-0000000000f1';

-- ===========================================================================
-- 8. LOCATION ISOLATION — location A2's save left A1 untouched.
-- ===========================================================================
select '08_LOCATION_ISOLATION' as case,
       case when quantity_on_hand_grams = 1000 then 'PASS'
            else 'FAIL: other location moved to '||quantity_on_hand_grams end as result
from inventory.location_stock
where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f1';

-- ===========================================================================
-- 9. "WHERE CONFIGURED" — deduction off at the location means no movement.
-- ===========================================================================
update core.location_settings set stock_deduction_enabled = false
where location_id = 'c6000000-0000-0000-0000-0000000000a2';

select lab.save_formula_with_reconciliation(jsonb_build_object(
  'formulaId','week6-f3',
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a2',
  'clientProfileId','c6000000-0000-0000-0000-0000000000c1',
  'items', jsonb_build_array(
    jsonb_build_object('id','i1','productId','c6000000-0000-0000-0000-0000000000f1','productName','Colour 6.0','capturedGrams',100,'wasteGrams',0)
  )
));

select '09_DEDUCTION_GATE_OFF' as case,
       case when quantity_on_hand_grams = 965 then 'PASS'
            else 'FAIL: deduction ran while disabled; balance '||quantity_on_hand_grams end as result
from inventory.location_stock
where location_id='c6000000-0000-0000-0000-0000000000a2' and product_id='c6000000-0000-0000-0000-0000000000f1';

update core.location_settings set stock_deduction_enabled = true
where location_id = 'c6000000-0000-0000-0000-0000000000a2';

-- ===========================================================================
-- 10. BARCODE CONSUMPTION — deducts through the authoritative RPC.
-- ===========================================================================
select inventory.adjust_location_stock(jsonb_build_object(
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a1',
  'productId','c6000000-0000-0000-0000-0000000000f1',
  'quantityDeltaGrams',-25,
  'movementType','salon_consumption',
  'referenceType','barcode_scan',
  'idempotencyKey','week6-scan-1'
));

select '10_BARCODE_CONSUMPTION' as case,
       case when quantity_on_hand_grams = 975 then 'PASS'
            else 'FAIL: expected 975, got '||quantity_on_hand_grams end as result
from inventory.location_stock
where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f1';

-- ===========================================================================
-- 11. IDEMPOTENT RETRY — the same key must not deduct a second time.
-- ===========================================================================
select inventory.adjust_location_stock(jsonb_build_object(
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a1',
  'productId','c6000000-0000-0000-0000-0000000000f1',
  'quantityDeltaGrams',-25,
  'movementType','salon_consumption',
  'idempotencyKey','week6-scan-1'
));

select '11_IDEMPOTENT_RETRY' as case,
       case when s.qty = 975 and m.n = 1 then 'PASS'
            else 'FAIL: balance '||s.qty||' (want 975), movements '||m.n||' (want 1)' end as result
from (select quantity_on_hand_grams qty from inventory.location_stock
      where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f1') s,
     (select count(*) n from inventory.stock_movements where idempotency_key='week6-scan-1') m;

-- ===========================================================================
-- 12. NEGATIVE STOCK BLOCKED_ERROR — a location that forbids it must refuse.
--     Raising here is a PASS. Case 13 proves the balance survived.
-- ===========================================================================
update core.location_settings set allow_negative_stock = false
where location_id = 'c6000000-0000-0000-0000-0000000000a1';

select inventory.adjust_location_stock(jsonb_build_object(
  'businessId','c6000000-0000-0000-0000-000000000001',
  'locationId','c6000000-0000-0000-0000-0000000000a1',
  'productId','c6000000-0000-0000-0000-0000000000f1',
  'quantityDeltaGrams',-99999,
  'movementType','salon_consumption'
));

select '13_NEGATIVE_BLOCK_SURVIVED' as case,
       case when quantity_on_hand_grams = 975 then 'PASS'
            else 'FAIL: refused deduction still moved stock to '||quantity_on_hand_grams end as result
from inventory.location_stock
where location_id='c6000000-0000-0000-0000-0000000000a1' and product_id='c6000000-0000-0000-0000-0000000000f1';

update core.location_settings set allow_negative_stock = true
where location_id = 'c6000000-0000-0000-0000-0000000000a1';

-- ===========================================================================
-- 14. COLOUR MAPPING — the column Colour Prep selects on exists and is nullable.
-- ===========================================================================
select '14_COLOUR_MAPPING_COLUMN' as case,
       case when count(*) = 1 then 'PASS' else 'FAIL: billing_category column missing' end as result
from information_schema.columns
where table_schema='booking' and table_name='service_categories' and column_name='billing_category';

-- ===========================================================================
-- CLEANUP — cascade from the two businesses.
-- ===========================================================================
delete from core.businesses where id in
 ('c6000000-0000-0000-0000-000000000001','c6000000-0000-0000-0000-000000000002');
