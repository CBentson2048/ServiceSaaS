-- week6_dead_stock_alerts.sql — behavioural suite for migration 0093.
--
-- WHY THIS FILE EXISTS. The dead-stock classification lives in SQL
-- (inventory.dead_stock_report), not TypeScript: the idle clock, the
-- restock immunity and the threshold precedence are all in the function.
-- The Jest suite stubs the Supabase client, so it proves scoping and
-- decoration but can never prove that a restock fails to reset the clock.
-- This file is that proof.
--
-- 12 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0093 applied:
--   psql -d <scratch> -f supabase/tests/week6_dead_stock_alerts.sql

\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures. 'dd' prefix, hex-only UUIDs, distinct from the other suites.
-- Location A1 runs a 30-day default; A2 keeps the shipped 90-day default.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('dd000000-0000-0000-0000-000000000001','Dead Stock Salon','dead-stock-salon'),
 ('dd000000-0000-0000-0000-000000000002','Rival Salon','dead-stock-rival');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000001','D1','Main','dd-main','1 St','Leeds','LS2 1AA','Europe/London'),
 ('dd000000-0000-0000-0000-000000000da2','dd000000-0000-0000-0000-000000000001','D2','Second','dd-second','2 St','Leeds','LS2 2AA','Europe/London'),
 ('dd000000-0000-0000-0000-000000000da3','dd000000-0000-0000-0000-000000000002','D3','Rival','dd-rival','3 St','Leeds','LS2 3AA','Europe/London');

insert into core.location_settings (business_id,location_id,dead_stock_days_default) values
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1',30),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da2',90);

insert into inventory.products (id,business_id,name,default_unit,default_cost_per_gram_cents,low_stock_threshold_grams,stock_unit,dead_stock_days,is_active) values
 ('dd000000-0000-0000-0000-000000000d01','dd000000-0000-0000-0000-000000000001','Dusty Toner','g',5,0,'gram',null,true),
 ('dd000000-0000-0000-0000-000000000d02','dd000000-0000-0000-0000-000000000001','Restocked Dust','g',5,0,'gram',null,true),
 ('dd000000-0000-0000-0000-000000000d03','dd000000-0000-0000-0000-000000000001','Fresh Mover','g',5,0,'gram',null,true),
 ('dd000000-0000-0000-0000-000000000d04','dd000000-0000-0000-0000-000000000001','Sold Out','g',5,0,'gram',null,true),
 ('dd000000-0000-0000-0000-000000000d05','dd000000-0000-0000-0000-000000000001','Patient Product','g',5,0,'gram',60,true),
 ('dd000000-0000-0000-0000-000000000d06','dd000000-0000-0000-0000-000000000001','Impatient Product','g',5,0,'gram',20,true),
 ('dd000000-0000-0000-0000-000000000d07','dd000000-0000-0000-0000-000000000001','Never Touched','g',5,0,'gram',null,true),
 ('dd000000-0000-0000-0000-000000000d08','dd000000-0000-0000-0000-000000000001','Archived Relic','g',5,0,'gram',null,false),
 ('dd000000-0000-0000-0000-000000000d09','dd000000-0000-0000-0000-000000000001','Only Restocked','g',5,0,'gram',null,true),
 ('dd000000-0000-0000-0000-000000000d10','dd000000-0000-0000-0000-000000000002','Rival Dust','g',5,0,'gram',null,true);

-- Shelf records. created_at anchors the idle clock when nothing has moved.
insert into inventory.location_stock (business_id,location_id,product_id,quantity_on_hand_grams,created_at) values
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d01',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d02',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d03',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d04',0,   now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d05',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d06',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d07',500, now() - interval '200 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d08',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d09',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da2','dd000000-0000-0000-0000-000000000d01',500, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000002','dd000000-0000-0000-0000-000000000da3','dd000000-0000-0000-0000-000000000d10',500, now() - interval '300 days');

-- Movement history, backdated. Outbound = negative delta.
insert into inventory.stock_movements (business_id,location_id,product_id,movement_type,quantity_delta_grams,created_at) values
 -- d01: last outbound 40 days ago (dead at a 30-day location)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d01','restock',           600, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d01','formula_usage',    -100, now() - interval '40 days'),
 -- d02: outbound 40 days ago, then a RESTOCK 5 days ago (must stay dead)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d02','restock',           400, now() - interval '300 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d02','formula_usage',    -100, now() - interval '40 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d02','restock',           200, now() - interval '5 days'),
 -- d03: outbound 100 days ago AND 3 days ago (alive)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d03','formula_usage',    -100, now() - interval '100 days'),
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d03','retail_sale',       -50, now() - interval '3 days'),
 -- d04: sold to zero 40 days ago (out of stock, NOT dead stock)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d04','retail_sale',      -500, now() - interval '40 days'),
 -- d05: product override 60 days, outbound 45 days ago (NOT dead: 45 < 60)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d05','formula_usage',    -100, now() - interval '45 days'),
 -- d06: product override 20 days, outbound 25 days ago (dead by the override)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d06','formula_usage',    -100, now() - interval '25 days'),
 -- d08: idle forever but the product is archived (excluded)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d08','formula_usage',    -100, now() - interval '250 days'),
 -- d09: ONLY a restock 50 days ago, never an outbound (idle clock = that restock)
 ('dd000000-0000-0000-0000-000000000001','dd000000-0000-0000-0000-000000000da1','dd000000-0000-0000-0000-000000000d09','restock',           500, now() - interval '50 days'),
 -- rival business: bone idle, must never appear in salon D's report
 ('dd000000-0000-0000-0000-000000000002','dd000000-0000-0000-0000-000000000da3','dd000000-0000-0000-0000-000000000d10','formula_usage',    -100, now() - interval '250 days');

-- ===========================================================================
-- 1. BASIC — 40 idle days against a 30-day location default is dead.
-- ===========================================================================
select '01_DEAD_BASIC' as case,
       case when exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d01'
           and days_idle between 39 and 41
           and threshold_days = 30
           and threshold_source = 'location_default')
       then 'PASS' else 'FAIL: d01 missing or misclassified' end as result;

-- ===========================================================================
-- 2. RESTOCK IMMUNITY — a delivery 5 days ago must NOT reset the idle clock.
-- ===========================================================================
select '02_RESTOCK_NO_RESET' as case,
       case when exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d02'
           and days_idle between 39 and 41)
       then 'PASS' else 'FAIL: the recent restock reset the idle clock' end as result;

-- ===========================================================================
-- 3. OUTBOUND RESETS — used 3 days ago means alive, whatever happened before.
-- ===========================================================================
select '03_OUTBOUND_RESETS' as case,
       case when not exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d03')
       then 'PASS' else 'FAIL: recently used stock reported dead' end as result;

-- ===========================================================================
-- 4. ZERO ON HAND — an empty shelf is out of stock, not dead stock.
-- ===========================================================================
select '04_ZERO_EXCLUDED' as case,
       case when not exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d04')
       then 'PASS' else 'FAIL: zero-quantity stock reported dead' end as result;

-- ===========================================================================
-- 5. PRODUCT OVERRIDE RAISES — 45 idle days under a 60-day override is alive.
-- ===========================================================================
select '05_OVERRIDE_RAISES' as case,
       case when not exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d05')
       then 'PASS' else 'FAIL: 60-day product override was ignored' end as result;

-- ===========================================================================
-- 6. PRODUCT OVERRIDE LOWERS — 25 idle days under a 20-day override is dead,
--    and the report says the PRODUCT threshold made the call.
-- ===========================================================================
select '06_OVERRIDE_LOWERS' as case,
       case when exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d06'
           and threshold_days = 20
           and threshold_source = 'product')
       then 'PASS' else 'FAIL: 20-day product override did not fire' end as result;

-- ===========================================================================
-- 7. NEVER MOVED — no movements at all: the shelf record itself anchors the
--    clock and last_outbound_at stays null (the UI shows "Never used").
-- ===========================================================================
select '07_NEVER_MOVED' as case,
       case when exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d07'
           and last_outbound_at is null
           and days_idle between 199 and 201)
       then 'PASS' else 'FAIL: never-moved stock missing or misanchored' end as result;

-- ===========================================================================
-- 8. ONLY RESTOCKED — never an outbound: the FIRST movement anchors the clock
--    (50 days ago), not the older shelf record (300 days ago).
-- ===========================================================================
select '08_FIRST_MOVEMENT_ANCHOR' as case,
       case when exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d09'
           and last_outbound_at is null
           and days_idle between 49 and 51)
       then 'PASS' else 'FAIL: only-restocked stock missing or misanchored' end as result;

-- ===========================================================================
-- 9. ARCHIVED PRODUCT EXCLUDED — an archived product cannot be dead stock.
-- ===========================================================================
select '09_ARCHIVED_EXCLUDED' as case,
       case when not exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d08')
       then 'PASS' else 'FAIL: archived product reported dead' end as result;

-- ===========================================================================
-- 10. SCOPING — another business's idle stock never leaks in, and a location
--     outside the requested scope stays out even inside the same business.
-- ===========================================================================
select '10_SCOPING' as case,
       case when not exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1',
                 'dd000000-0000-0000-0000-000000000da3']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d10')
       and not exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where location_id = 'dd000000-0000-0000-0000-000000000da2')
       then 'PASS' else 'FAIL: report leaked across business or location scope' end as result;

-- ===========================================================================
-- 11. RECOMPUTES ON READ — raising the location default to 400 days revives
--     d01 instantly; nothing is materialised anywhere.
-- ===========================================================================
update core.location_settings set dead_stock_days_default = 400
where location_id = 'dd000000-0000-0000-0000-000000000da1';

select '11_RECOMPUTES_ON_READ' as case,
       case when not exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da1']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d01')
       then 'PASS' else 'FAIL: threshold change did not reclassify on read' end as result;

update core.location_settings set dead_stock_days_default = 30
where location_id = 'dd000000-0000-0000-0000-000000000da1';

-- ===========================================================================
-- 12. PER-LOCATION PAIRING — d01's usage 40 days ago happened at location A1.
--     Its A2 shelf has no movements at all, so at A2 it must appear anchored
--     to the A2 shelf record (~300 idle days, never used). If either lateral
--     ever dropped its location predicate, A1's history would leak in and
--     last_outbound_at would be ~40 days ago instead of null.
-- ===========================================================================
select '12_PER_LOCATION_PAIRING' as case,
       case when exists (
         select 1 from inventory.dead_stock_report(
           'dd000000-0000-0000-0000-000000000001',
           array['dd000000-0000-0000-0000-000000000da2']::uuid[])
         where product_id = 'dd000000-0000-0000-0000-000000000d01'
           and location_id = 'dd000000-0000-0000-0000-000000000da2'
           and last_outbound_at is null
           and days_idle between 299 and 301)
       then 'PASS' else 'FAIL: movement history leaked across locations' end as result;
