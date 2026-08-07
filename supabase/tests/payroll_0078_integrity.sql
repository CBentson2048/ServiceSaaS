-- payroll_0078_integrity.sql — behavioural suite for migration 0078.
--
-- Covers ONLY what 0078 changes. The Week 3 guarantees are re-proved by
-- payroll_regression.sql, which must still pass unchanged alongside this file.
--
-- 12 numbered cases. Cases named _ERROR are expected to raise; a raised error
-- there is a pass. Where a case proves an operation is REFUSED, it is paired
-- with a query showing the data survived, so nothing passes vacuously.
--
-- Run against a SCRATCH database only, and NOT the same one as either Week 3
-- suite (fixture UUIDs overlap):
--   psql -d <scratch> -f supabase/tests/payroll_0078_integrity.sql

\set ON_ERROR_STOP off
\pset pager off

insert into core.businesses (id,name,slug) values
 ('11111111-1111-1111-1111-111111111111','Salon One','salon-one'),
 ('aaaa1111-1111-1111-1111-111111111111','Salon Two','salon-two');
insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','L1','Main','main','1 St','Leeds','LS1 1AA','Europe/London'),
 ('2222bbbb-2222-2222-2222-222222222222','aaaa1111-1111-1111-1111-111111111111','L2','Other','other','2 St','Leeds','LS1 2AA','Europe/London');
insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name)
values ('33333333-3333-3333-3333-333333333333','a@t.com','A Stylist','A','Stylist','A Stylist');
insert into core.staff_profiles (id,business_id,user_profile_id,primary_location_id,display_name,hourly_rate,contracted_hours)
values ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','A Stylist',12.21,40);

insert into payroll.pay_structures (id,business_id,name)
values ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','Struct');
insert into payroll.pay_structure_versions (id,business_id,structure_id,version_no,effective_from)
values ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',1,'2026-01-01');
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream)
values ('aaaaaaaa-0000-0000-0000-000000000002','77777777-7777-7777-7777-777777777777',2,'commission','Service commission','marginal','multiple_of_base_pay','service');
insert into payroll.pay_structure_bands (id,stage_id,sequence_no,from_multiple,rate_percent) values
 ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002',1,0.0, 0.000),
 ('eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002',2,3.0,10.000);

insert into payroll.pay_periods (id,business_id,kind,frequency,period_start,period_end,status)
values ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111','calculation','weekly','2026-07-21','2026-07-28','draft');
insert into payroll.pay_summaries (id,business_id,pay_period_id,staff_profile_id,employment_type_snapshot,gross_payable_cents,structure_version_id)
values ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','88888888-8888-8888-8888-888888888888',
        '44444444-4444-4444-4444-444444444444','employed',48840,'77777777-7777-7777-7777-777777777777');
insert into payroll.pay_summary_lines (id,summary_id,sequence_no,line_type,label,amount_cents,structure_version_id,occurred_on,band_id)
values ('bbbbbbbb-0000-0000-0000-000000000001','99999999-9999-9999-9999-999999999999',1,'commission','Band 2 slice',2442,
        '77777777-7777-7777-7777-777777777777','2026-07-25','eeeeeeee-0000-0000-0000-000000000002');

-- =============================================================================
-- §1  A used rule version must still be closable
-- =============================================================================

\echo D01_used_version_rate_change_still_frozen_ERROR
update payroll.pay_structure_versions set vat_basis='inclusive'
 where id='77777777-7777-7777-7777-777777777777';
select vat_basis from payroll.pay_structure_versions where id='77777777-7777-7777-7777-777777777777';

\echo D02_close_across_already_priced_work_ERROR
-- The version priced a line dated 2026-07-25; effective_to is EXCLUSIVE, so
-- closing on that date would retroactively push the line outside its own rule.
update payroll.pay_structure_versions set effective_to='2026-07-25'
 where id='77777777-7777-7777-7777-777777777777';
select effective_to from payroll.pay_structure_versions where id='77777777-7777-7777-7777-777777777777';

\echo D03_close_after_priced_work_ALLOWED_expect_2026-08-01
update payroll.pay_structure_versions set effective_to='2026-08-01', notes='Rate review'
 where id='77777777-7777-7777-7777-777777777777';
select effective_to, notes from payroll.pay_structure_versions where id='77777777-7777-7777-7777-777777777777';

\echo D04_successor_version_can_now_be_inserted_expect_2
insert into payroll.pay_structure_versions (id,business_id,structure_id,version_no,effective_from)
values ('77777777-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',2,'2026-08-01');
select count(*) as versions_on_structure from payroll.pay_structure_versions
 where structure_id='55555555-5555-5555-5555-555555555555';

-- =============================================================================
-- §2  Supersede must be executable inside one transaction
-- =============================================================================

\echo D05_supersede_in_one_transaction_expect_1_live_and_2_total
begin;
-- SET CONSTRAINTS resolves an unqualified name through search_path, which does
-- not include `payroll`, so the schema qualifier is required here and in the
-- future supersede RPC.
set constraints payroll.payroll_pay_summaries_superseded_by_fkey deferred;
update payroll.pay_summaries
   set superseded_by_id='99999999-0000-0000-0000-000000000002'
 where id='99999999-9999-9999-9999-999999999999';
insert into payroll.pay_summaries (id,business_id,pay_period_id,staff_profile_id,employment_type_snapshot,gross_payable_cents)
values ('99999999-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','88888888-8888-8888-8888-888888888888',
        '44444444-4444-4444-4444-444444444444','employed',51600);
commit;
select count(*) filter (where superseded_by_id is null) as live,
       count(*) as total
  from payroll.pay_summaries;

-- =============================================================================
-- §3  Locked periods must protect the hours behind the target
-- =============================================================================

\echo D06_hours_writable_while_draft_expect_1
insert into payroll.pay_summary_hours (summary_id,category,hours,counted_toward_target,counted_as_paid)
values ('99999999-0000-0000-0000-000000000002','worked',40.00,true,true);
select count(*) as hours_rows from payroll.pay_summary_hours;

\echo D07_hours_frozen_once_locked_ERROR_then_40.00
update payroll.pay_periods set status='locked', locked_at=now()
 where id='88888888-8888-8888-8888-888888888888';
update payroll.pay_summary_hours set hours=999 where summary_id='99999999-0000-0000-0000-000000000002';
delete from payroll.pay_summary_hours where summary_id='99999999-0000-0000-0000-000000000002';
insert into payroll.pay_summary_hours (summary_id,category,hours,counted_toward_target,counted_as_paid)
values ('99999999-0000-0000-0000-000000000002','sickness',8.00,false,false);
select category, hours from payroll.pay_summary_hours;

-- =============================================================================
-- §4  Target adjustments: the summary_id escape hatch is closed
-- =============================================================================

\echo D08_target_adjustment_cannot_be_rewritten_while_setting_summary_id_ERROR_then_120000
insert into payroll.target_adjustments
 (id,business_id,staff_profile_id,pay_period_id,original_target_cents,adjusted_target_cents,reason,adjusted_by_user_profile_id)
values ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444',
        '88888888-8888-8888-8888-888888888888',146520,120000,'Authorised reduction','33333333-3333-3333-3333-333333333333');
-- Before 0078 this passed: changing summary_id in the same statement skipped the
-- guard entirely, letting the figures and the actor be rewritten.
update payroll.target_adjustments
   set summary_id='99999999-0000-0000-0000-000000000002',
       adjusted_target_cents=1,
       reason='rewritten',
       adjusted_by_user_profile_id=null
 where id='dddddddd-0000-0000-0000-000000000001';
select adjusted_target_cents, reason from payroll.target_adjustments
 where id='dddddddd-0000-0000-0000-000000000001';

\echo D09_target_adjustment_summary_id_alone_still_settable_expect_t
update payroll.target_adjustments set summary_id='99999999-0000-0000-0000-000000000002'
 where id='dddddddd-0000-0000-0000-000000000001';
select (summary_id is not null) as linked from payroll.target_adjustments
 where id='dddddddd-0000-0000-0000-000000000001';

-- =============================================================================
-- §5  Business-consistency on the output tables
-- =============================================================================

\echo D10_summary_for_another_businesss_staff_ERROR
insert into payroll.pay_summaries (business_id,pay_period_id,staff_profile_id,employment_type_snapshot,gross_payable_cents)
values ('aaaa1111-1111-1111-1111-111111111111','88888888-8888-8888-8888-888888888888',
        '44444444-4444-4444-4444-444444444444','employed',100);

\echo D11_period_scoped_to_another_businesss_location_ERROR
insert into payroll.pay_periods (business_id,location_id,kind,frequency,period_start,period_end)
values ('11111111-1111-1111-1111-111111111111','2222bbbb-2222-2222-2222-222222222222','calculation','weekly','2026-09-01','2026-09-08');

-- =============================================================================
-- §6  Status ratchet covers INSERT
-- =============================================================================

\echo D12_period_cannot_be_born_paid_ERROR
insert into payroll.pay_periods (business_id,kind,frequency,period_start,period_end,status)
values ('11111111-1111-1111-1111-111111111111','calculation','weekly','2026-10-01','2026-10-08','paid');

\echo D12a_period_cannot_be_born_locked_ERROR
insert into payroll.pay_periods (business_id,kind,frequency,period_start,period_end,status)
values ('11111111-1111-1111-1111-111111111111','calculation','weekly','2026-10-08','2026-10-15','locked');

-- =============================================================================
-- §7  greater_of_winner widened, and the paired constraint survives
-- =============================================================================

\echo D13_revenue_split_can_win_a_greater_of_expect_revenue_split
insert into payroll.pay_periods (id,business_id,kind,frequency,period_start,period_end,status)
values ('88888888-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','calculation','weekly','2026-11-04','2026-11-11','draft');
insert into payroll.pay_summaries (id,business_id,pay_period_id,staff_profile_id,employment_type_snapshot,
                                   greater_of_applied,greater_of_winner,gross_payable_cents)
values ('99999999-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','88888888-0000-0000-0000-000000000009',
        '44444444-4444-4444-4444-444444444444','self_employed',true,'revenue_split',60000);
select greater_of_winner from payroll.pay_summaries where id='99999999-0000-0000-0000-000000000009';

\echo D13a_applied_comparison_still_requires_a_winner_ERROR
-- pay_summaries_greater_of_winner (0073) must NOT have been dropped by 0078.
insert into payroll.pay_summaries (business_id,pay_period_id,staff_profile_id,employment_type_snapshot,
                                   greater_of_applied,greater_of_winner,gross_payable_cents)
values ('11111111-1111-1111-1111-111111111111','88888888-0000-0000-0000-000000000009',
        '44444444-4444-4444-4444-444444444444','employed',true,null,100);

\echo D13b_non_operand_line_type_still_rejected_ERROR
insert into payroll.pay_summaries (business_id,pay_period_id,staff_profile_id,employment_type_snapshot,
                                   greater_of_applied,greater_of_winner,gross_payable_cents)
values ('11111111-1111-1111-1111-111111111111','88888888-0000-0000-0000-000000000009',
        '44444444-4444-4444-4444-444444444444','employed',true,'chair_rent',100);

-- =============================================================================
-- §8  SECURITY DEFINER helpers are no longer world-executable
-- =============================================================================

\echo D14_definer_helpers_not_executable_by_public_expect_f_f
select has_function_privilege('public','payroll.missing_data_sources(uuid)','execute') as missing_public,
       has_function_privilege('public','payroll.seed_business_data_sources(uuid)','execute') as seed_public;

\echo D14a_definer_helpers_executable_by_service_role_expect_t_t
select has_function_privilege('service_role','payroll.missing_data_sources(uuid)','execute') as missing_service,
       has_function_privilege('service_role','payroll.seed_business_data_sources(uuid)','execute') as seed_service;

\echo D15_band_id_column_present_expect_1
select count(*) as band_id_columns from information_schema.columns
 where table_schema='payroll' and table_name='pay_summary_lines' and column_name='band_id';
