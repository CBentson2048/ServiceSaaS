-- payroll_regression.sql — historical-integrity regression suite.
--
-- Re-checks every payroll guarantee established earlier in Week 3, so that
-- later schema additions cannot silently weaken them. Several were found by
-- adversarial testing rather than written speculatively: R14 (deleting a locked
-- period used to cascade its statements away) and R15 (a locked period could be
-- reopened to draft) were real defects.
--
-- 19 numbered cases, 25 assertions.
--
-- NOTE ON VACUOUS PASSES: an UPDATE or DELETE that matches no rows fires no row
-- trigger and reports "UPDATE 0" / "DELETE 0" - which looks like a pass but
-- asserts nothing. R18 originally had this flaw. Where a case proves that an
-- operation is REFUSED, it is paired with a query showing the data survived,
-- and R18 additionally carries a precondition query confirming the target row
-- exists at all.
--
-- Run against a SCRATCH database only:
--   psql -d <scratch> -f supabase/tests/payroll_regression.sql
-- Cases named _ERROR are expected to raise. Figures printed afterwards prove
-- the underlying data was NOT changed by the rejected operation.

\set ON_ERROR_STOP off
\pset pager off

insert into core.businesses (id,name,slug) values
 ('11111111-1111-1111-1111-111111111111','Salon One','salon-one'),
 ('aaaa1111-1111-1111-1111-111111111111','Salon Two','salon-two');
insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','L1','Main','main','1 St','Leeds','LS1 1AA','Europe/London');
insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name)
values ('33333333-3333-3333-3333-333333333333','a@t.com','A Stylist','A','Stylist','A Stylist');
insert into core.staff_profiles (id,business_id,user_profile_id,primary_location_id,display_name,hourly_rate,contracted_hours)
values ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','A Stylist',12.21,40);
insert into payroll.pay_structures (id,business_id,name) values ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','Struct');
insert into payroll.pay_structure_versions (id,business_id,structure_id,version_no,effective_from)
values ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',1,'2026-01-01');
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label)
values ('aaaaaaaa-0000-0000-0000-000000000001','77777777-7777-7777-7777-777777777777',1,'base_pay','Base');

-- A commission stage WITH bands on the same version. R18 needs a real band on a
-- used version to exercise the freeze trigger; bands cannot hang off the
-- base_pay stage above, because assert_band_matches_stage_basis() rejects bands
-- on any non-commission stage.
--
-- These must be inserted HERE, before the pay summary below makes the version
-- "used" - assert_rule_version_unused() fires on INSERT as well as UPDATE, so
-- creating them later would itself be refused.
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream)
values ('aaaaaaaa-0000-0000-0000-000000000002','77777777-7777-7777-7777-777777777777',2,'commission','Service commission','marginal','multiple_of_base_pay','service');
insert into payroll.pay_structure_bands (id,stage_id,sequence_no,from_multiple,rate_percent) values
 ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002',1,0.0, 0.000),
 ('eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002',2,3.0,10.000);

\echo R01_rule_version_ranges_cannot_overlap_ERROR
insert into payroll.pay_structure_versions (business_id,structure_id,version_no,effective_from)
values ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',2,'2026-06-01');

\echo R02_version_boundary_resolution_v1_then_v2
update payroll.pay_structure_versions set effective_to='2026-06-01' where id='77777777-7777-7777-7777-777777777777';
insert into payroll.pay_structure_versions (id,business_id,structure_id,version_no,effective_from)
values ('77777777-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',2,'2026-06-01');
select d::date as on_date, v.version_no
from (values ('2026-05-31'),('2026-06-01')) t(d)
join payroll.pay_structure_versions v
  on v.structure_id='55555555-5555-5555-5555-555555555555'
 and daterange(v.effective_from, v.effective_to,'[)') @> d::date
order by 1;

\echo R03_cross_business_assignment_ERROR
insert into payroll.staff_pay_assignments (business_id,staff_profile_id,structure_id,effective_from)
values ('aaaa1111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444',
        '55555555-5555-5555-5555-555555555555','2026-01-01');

\echo R04_assignment_ranges_cannot_overlap_ERROR
insert into payroll.staff_pay_assignments (business_id,staff_profile_id,structure_id,effective_from)
values ('11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444',
        '55555555-5555-5555-5555-555555555555','2026-01-01');
insert into payroll.staff_pay_assignments (business_id,staff_profile_id,structure_id,effective_from)
values ('11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444',
        '55555555-5555-5555-5555-555555555555','2026-03-01');

\echo R05_overlapping_pay_periods_ERROR
insert into payroll.pay_periods (id,business_id,kind,frequency,period_start,period_end)
values ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111','calculation','weekly','2026-07-21','2026-07-28');
insert into payroll.pay_periods (business_id,kind,frequency,period_start,period_end)
values ('11111111-1111-1111-1111-111111111111','calculation','weekly','2026-07-24','2026-07-31');

\echo R06_adjacent_period_allowed
insert into payroll.pay_periods (id,business_id,kind,frequency,period_start,period_end)
values ('88888888-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','calculation','weekly','2026-07-28','2026-08-04');

\echo R07_rollup_parent_must_be_payment_period_ERROR
update payroll.pay_periods set parent_payment_period_id='88888888-0000-0000-0000-000000000002'
 where id='88888888-8888-8888-8888-888888888888';

insert into payroll.pay_summaries (id,business_id,pay_period_id,staff_profile_id,employment_type_snapshot,structure_version_id,net_payable_cents)
values ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','88888888-8888-8888-8888-888888888888',
        '44444444-4444-4444-4444-444444444444','employed','77777777-7777-7777-7777-777777777777',48840);
insert into payroll.pay_summary_lines (id,summary_id,sequence_no,line_type,label,amount_cents,structure_version_id)
values ('bbbbbbbb-0000-0000-0000-000000000001','99999999-9999-9999-9999-999999999999',1,'service_revenue','Revenue',180000,
        '77777777-7777-7777-7777-777777777777');

\echo R08_duplicate_live_summary_ERROR
insert into payroll.pay_summaries (business_id,pay_period_id,staff_profile_id,employment_type_snapshot,net_payable_cents)
values ('11111111-1111-1111-1111-111111111111','88888888-8888-8888-8888-888888888888',
        '44444444-4444-4444-4444-444444444444','employed',100);

\echo R09_locked_figures_cannot_be_rewritten_ERROR_then_48840
update payroll.pay_periods set status='locked', locked_at=now() where id='88888888-8888-8888-8888-888888888888';
update payroll.pay_summaries set net_payable_cents=999999 where id='99999999-9999-9999-9999-999999999999';
select net_payable_cents from payroll.pay_summaries where id='99999999-9999-9999-9999-999999999999';

\echo R10_locked_summary_cannot_be_moved_out_of_lock_ERROR
update payroll.pay_summaries set pay_period_id='88888888-0000-0000-0000-000000000002', net_payable_cents=1
 where id='99999999-9999-9999-9999-999999999999';
select pay_period_id, net_payable_cents from payroll.pay_summaries where id='99999999-9999-9999-9999-999999999999';

\echo R11_locked_summary_cannot_be_reassigned_ERROR
update payroll.pay_summaries set currency_code='USD' where id='99999999-9999-9999-9999-999999999999';
select currency_code from payroll.pay_summaries where id='99999999-9999-9999-9999-999999999999';

\echo R12_export_and_email_stamps_still_writable_after_lock
update payroll.pay_summaries set exported_at=now(), emailed_at=now(), is_stale=true, stale_reason='source edited'
 where id='99999999-9999-9999-9999-999999999999';
select (exported_at is not null) as exported,(emailed_at is not null) as emailed,is_stale
 from payroll.pay_summaries where id='99999999-9999-9999-9999-999999999999';

\echo R13_locked_line_writes_blocked_ERROR_then_1_line
insert into payroll.pay_summary_lines (summary_id,sequence_no,line_type,amount_cents)
values ('99999999-9999-9999-9999-999999999999',2,'commission',5000);
update payroll.pay_summary_lines set amount_cents=1 where id='bbbbbbbb-0000-0000-0000-000000000001';
delete from payroll.pay_summary_lines where id='bbbbbbbb-0000-0000-0000-000000000001';
select count(*) as lines_remaining from payroll.pay_summary_lines;

\echo R14_locked_period_deletion_blocked_ERROR_then_2_1_1
delete from payroll.pay_periods where id='88888888-8888-8888-8888-888888888888';
select (select count(*) from payroll.pay_periods) as periods,
       (select count(*) from payroll.pay_summaries) as summaries,
       (select count(*) from payroll.pay_summary_lines) as lines;

\echo R15_locked_to_draft_rollback_blocked_ERROR_then_locked
update payroll.pay_periods set status='draft' where id='88888888-8888-8888-8888-888888888888';
select status from payroll.pay_periods where id='88888888-8888-8888-8888-888888888888';

\echo R16_staff_with_payroll_cannot_be_deleted_ERROR
delete from core.staff_profiles where id='44444444-4444-4444-4444-444444444444';

\echo R17_used_rule_version_frozen_ERROR_then_exclusive
update payroll.pay_structure_versions set vat_basis='inclusive' where id='77777777-7777-7777-7777-777777777777';
select vat_basis from payroll.pay_structure_versions where id='77777777-7777-7777-7777-777777777777';

\echo R18_precondition_band_exists_on_used_version_expect_1_row
-- Guards the test itself: if this returns 0 rows the R18 assertions below are
-- vacuous (an UPDATE matching nothing fires no row trigger and reports
-- "UPDATE 0", which reads like a pass but proves nothing).
select count(*) as bands_on_used_version
from payroll.pay_structure_bands b
join payroll.pay_structure_stages s on s.id = b.stage_id
where s.version_id = '77777777-7777-7777-7777-777777777777'
  and exists (select 1 from payroll.pay_summaries m
              where m.structure_version_id = s.version_id);

\echo R18a_used_rule_band_rate_frozen_ERROR
update payroll.pay_structure_bands set rate_percent = 99.000
 where id = 'eeeeeeee-0000-0000-0000-000000000002';

\echo R18b_used_rule_band_threshold_frozen_ERROR
update payroll.pay_structure_bands set from_multiple = 9.9
 where id = 'eeeeeeee-0000-0000-0000-000000000002';

\echo R18c_used_rule_band_accelerator_rate_frozen_ERROR
update payroll.pay_structure_bands set accelerator_rate_percent = 99.000
 where id = 'eeeeeeee-0000-0000-0000-000000000002';

\echo R18d_used_rule_band_delete_frozen_ERROR
delete from payroll.pay_structure_bands
 where id = 'eeeeeeee-0000-0000-0000-000000000002';

\echo R18e_used_rule_band_insert_frozen_ERROR
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_multiple,rate_percent)
values ('aaaaaaaa-0000-0000-0000-000000000002',3,4.0,20.000);

\echo R18f_band_values_unchanged_expect_3.0_and_10.000_and_2_bands
select from_multiple, rate_percent from payroll.pay_structure_bands
 where id = 'eeeeeeee-0000-0000-0000-000000000002';
select count(*) as bands_remaining from payroll.pay_structure_bands
 where stage_id = 'aaaaaaaa-0000-0000-0000-000000000002';

\echo R19_adjustment_frozen_once_applied_ERROR_then_minus6000
insert into payroll.pay_adjustments (id,business_id,staff_profile_id,origin_pay_period_id,reason,amount_cents,description)
values ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        '44444444-4444-4444-4444-444444444444','88888888-8888-8888-8888-888888888888','refund',-5000,'Clawback');
update payroll.pay_adjustments set amount_cents=-6000 where id='cccccccc-0000-0000-0000-000000000001';
update payroll.pay_adjustments set applied_in_pay_period_id='88888888-0000-0000-0000-000000000002', applied_at=now()
 where id='cccccccc-0000-0000-0000-000000000001';
update payroll.pay_adjustments set amount_cents=-1 where id='cccccccc-0000-0000-0000-000000000001';
delete from payroll.pay_adjustments where id='cccccccc-0000-0000-0000-000000000001';
select amount_cents as adjustment_final from payroll.pay_adjustments where id='cccccccc-0000-0000-0000-000000000001';
