-- payroll_validation.sql — Week 3 Financial Rules Engine validation suite.
--
-- 21 cases proving the schema expresses Luke's confirmed rules (2026-07-27)
-- exactly as specified, and that the guard rails around them hold.
--
-- Run against a SCRATCH database only:
--   psql -d <scratch> -f supabase/tests/payroll_validation.sql
-- Cases whose name ends in _ERROR are expected to raise; everything else is
-- expected to succeed. See docs/payroll-loh-template.md for the arithmetic and
-- docs/financial-rules-engine-principles.md for the design rules being checked.

\set ON_ERROR_STOP off
\pset pager off

insert into core.businesses (id,name,slug) values ('11111111-1111-1111-1111-111111111111','Luke Ormsby Hair','loh');
insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','L1','Main','main','1 St','Leeds','LS1 1AA','Europe/London');
insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name)
values ('33333333-3333-3333-3333-333333333333','a@t.com','A Stylist','A','Stylist','A Stylist');
insert into core.staff_profiles (id,business_id,user_profile_id,primary_location_id,display_name,hourly_rate,contracted_hours)
values ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','A Stylist',12.21,40);

insert into payroll.pay_structures (id,business_id,name,is_system)
values ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','Luke Ormsby Hair',true);
insert into payroll.pay_structure_versions (id,business_id,structure_id,version_no,effective_from,vat_basis,discount_basis)
values ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555',1,'2026-01-01','exclusive','headline_before_discount');

\echo V01_business_defaults_seeded
select week_start_day, default_calculation_frequency, default_payment_frequency from payroll.payroll_settings;

\echo V02_data_source_capture_matrix
select source, is_captured from payroll.business_data_sources order by source;

insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,in_greater_of_comparison,config)
values ('a0000000-0000-0000-0000-000000000001','77777777-7777-7777-7777-777777777777',1,'base_pay','Hourly base pay',false,'{"source":"hourly_rate_x_payable_hours"}');
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream,requires_data_source)
values ('a0000000-0000-0000-0000-000000000002','77777777-7777-7777-7777-777777777777',2,'commission','Service commission','marginal','multiple_of_base_pay','service','service_revenue');
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream,requires_data_source)
values ('a0000000-0000-0000-0000-000000000003','77777777-7777-7777-7777-777777777777',3,'commission','Retail commission','marginal','percent_of_service_target','retail','retail_sales');

\echo V03_LOH_marginal_bands_with_accelerator_rate
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_multiple,rate_percent,accelerator_rate_percent) values
 ('a0000000-0000-0000-0000-000000000002',1,0.0, 0.000,null),
 ('a0000000-0000-0000-0000-000000000002',2,3.0,10.000,null),
 ('a0000000-0000-0000-0000-000000000002',3,3.5,15.000,30.000);
select sequence_no,from_multiple,rate_percent,accelerator_rate_percent from payroll.pay_structure_bands
 where stage_id='a0000000-0000-0000-0000-000000000002' order by sequence_no;

\echo V04_LOH_retail_target_10pct_of_service_revenue_target
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_percent,rate_percent) values
 ('a0000000-0000-0000-0000-000000000003',1, 0.0, 0.000),
 ('a0000000-0000-0000-0000-000000000003',2,10.0,10.000);
select sequence_no,from_percent,rate_percent from payroll.pay_structure_bands
 where stage_id='a0000000-0000-0000-0000-000000000003' order by sequence_no;

\echo V05_LOH_accelerator_all_three_kpis
insert into payroll.accelerators (id,version_id,stage_id,name,evaluation_mode)
values ('b0000000-0000-0000-0000-000000000001','77777777-7777-7777-7777-777777777777',
        'a0000000-0000-0000-0000-000000000002','All three KPIs','all');
insert into payroll.accelerator_conditions (accelerator_id,sequence_no,metric,comparator,basis,threshold_value) values
 ('b0000000-0000-0000-0000-000000000001',1,'rebooking_rate_percent','gte','percent',50),
 ('b0000000-0000-0000-0000-000000000001',2,'retail_revenue','gte','target_met',null),
 ('b0000000-0000-0000-0000-000000000001',3,'average_bill','gte','staff_benchmark',null);
select a.evaluation_mode,(select count(*) from payroll.accelerator_conditions c where c.accelerator_id=a.id) as conditions
 from payroll.accelerators a where a.id='b0000000-0000-0000-0000-000000000001';

\echo V06_LOH_hour_rules_worked_additional_manual_only
insert into payroll.version_hour_rules (version_id,category,counts_toward_target,counts_as_paid) values
 ('77777777-7777-7777-7777-777777777777','worked',             true,  true),
 ('77777777-7777-7777-7777-777777777777','paid_holiday',       false, true),
 ('77777777-7777-7777-7777-777777777777','training',           false, true),
 ('77777777-7777-7777-7777-777777777777','sickness',           false, false),
 ('77777777-7777-7777-7777-777777777777','authorised_absence', false, false),
 ('77777777-7777-7777-7777-777777777777','unpaid_leave',       false, false),
 ('77777777-7777-7777-7777-777777777777','additional',         true,  true),
 ('77777777-7777-7777-7777-777777777777','manual_adjustment',  true,  true);
select category,counts_toward_target,counts_as_paid from payroll.version_hour_rules
 where version_id='77777777-7777-7777-7777-777777777777' order by category;

\echo V07_paid_holiday_pays_wage_but_not_target
select counts_as_paid, counts_toward_target from payroll.version_hour_rules
 where version_id='77777777-7777-7777-7777-777777777777' and category='paid_holiday';

insert into payroll.pay_structures (id,business_id,name) values ('55555555-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Modes Test');
insert into payroll.pay_structure_versions (id,business_id,structure_id,version_no,effective_from)
values ('77777777-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000002',1,'2026-01-01');
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,tier_semantics,threshold_basis,revenue_stream)
values ('a0000000-0000-0000-0000-000000000010','77777777-0000-0000-0000-000000000002',1,'commission','marginal','multiple_of_base_pay','service');

\echo V08_accelerator_any_two_of_three
insert into payroll.accelerators (id,version_id,stage_id,evaluation_mode,required_condition_count)
values ('b0000000-0000-0000-0000-000000000002','77777777-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000010','at_least_n',2);
select evaluation_mode,required_condition_count from payroll.accelerators where id='b0000000-0000-0000-0000-000000000002';

\echo V09_at_least_n_without_count_ERROR
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,tier_semantics,threshold_basis,revenue_stream)
values ('a0000000-0000-0000-0000-000000000011','77777777-0000-0000-0000-000000000002',2,'commission','marginal','multiple_of_base_pay','service');
insert into payroll.accelerators (version_id,stage_id,evaluation_mode)
values ('77777777-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000011','at_least_n');

\echo V10_accelerator_weighted_scoring
insert into payroll.accelerators (id,version_id,stage_id,evaluation_mode,required_score)
values ('b0000000-0000-0000-0000-000000000003','77777777-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000011','weighted',5);
insert into payroll.accelerator_conditions (accelerator_id,sequence_no,metric,basis,threshold_value,weight) values
 ('b0000000-0000-0000-0000-000000000003',1,'rebooking_rate_percent','percent',50,3),
 ('b0000000-0000-0000-0000-000000000003',2,'average_bill','staff_benchmark',null,2);
select a.evaluation_mode,a.required_score,
       (select sum(weight) from payroll.accelerator_conditions c where c.accelerator_id=a.id) as total_weight
 from payroll.accelerators a where a.id='b0000000-0000-0000-0000-000000000003';

\echo V11_all_mode_with_stray_count_ERROR
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,tier_semantics,threshold_basis,revenue_stream)
values ('a0000000-0000-0000-0000-000000000012','77777777-0000-0000-0000-000000000002',3,'commission','marginal','multiple_of_base_pay','service');
insert into payroll.accelerators (version_id,stage_id,evaluation_mode,required_condition_count)
values ('77777777-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000012','all',2);

\echo V12_percent_basis_requires_from_percent_ERROR
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,tier_semantics,threshold_basis,revenue_stream)
values ('a0000000-0000-0000-0000-000000000013','77777777-0000-0000-0000-000000000002',4,'commission','marginal','percent_of_service_revenue','retail');
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_amount_cents,rate_percent)
values ('a0000000-0000-0000-0000-000000000013',1,15000,10);

\echo V13_per_client_basis_takes_amount
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,tier_semantics,threshold_basis,revenue_stream)
values ('a0000000-0000-0000-0000-000000000014','77777777-0000-0000-0000-000000000002',5,'commission','marginal','per_client','retail');
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_amount_cents,rate_percent)
values ('a0000000-0000-0000-0000-000000000014',1,500,10);
select from_amount_cents,rate_percent from payroll.pay_structure_bands
 where stage_id='a0000000-0000-0000-0000-000000000014';

\echo V14_band_XOR_two_bounds_ERROR
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_multiple,from_amount_cents,rate_percent)
values ('a0000000-0000-0000-0000-000000000002',8,1.0,100,5.0);

\echo V15_band_XOR_three_bounds_ERROR
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_multiple,from_amount_cents,from_percent,rate_percent)
values ('a0000000-0000-0000-0000-000000000002',9,1.0,100,5.0,5.0);

\echo V16_band_XOR_no_bounds_ERROR
insert into payroll.pay_structure_bands (stage_id,sequence_no,rate_percent)
values ('a0000000-0000-0000-0000-000000000002',10,5.0);

\echo V17_band_on_non_commission_stage_ERROR
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_multiple,rate_percent)
values ('a0000000-0000-0000-0000-000000000001',1,1.0,5.0);

insert into payroll.pay_structures (id,business_id,name) values ('55555555-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Example A2');
insert into payroll.pay_structure_versions (id,business_id,structure_id,version_no,effective_from)
values ('77777777-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000003',1,'2026-01-01');

\echo V18_A2_guarantee_vs_commission_retail_outside_comparison
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,in_greater_of_comparison,config)
values ('a0000000-0000-0000-0000-000000000020','77777777-0000-0000-0000-000000000003',1,'base_pay','Guaranteed minimum wage',true,'{"source":"hourly_rate_x_payable_hours"}');
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream,in_greater_of_comparison,requires_data_source)
values ('a0000000-0000-0000-0000-000000000021','77777777-0000-0000-0000-000000000003',2,'commission','Commission-only entitlement','retroactive','absolute','service',true,'service_revenue');
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_amount_cents,rate_percent)
values ('a0000000-0000-0000-0000-000000000021',1,0,30.000);
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,in_greater_of_comparison,config)
values ('a0000000-0000-0000-0000-000000000022','77777777-0000-0000-0000-000000000003',3,'greater_of','Higher of wage or commission',false,'{}');
insert into payroll.pay_structure_stages (id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream,in_greater_of_comparison,requires_data_source)
values ('a0000000-0000-0000-0000-000000000023','77777777-0000-0000-0000-000000000003',4,'commission','Retail commission on top','marginal','absolute','retail',false,'retail_sales');
insert into payroll.pay_structure_bands (stage_id,sequence_no,from_amount_cents,rate_percent)
values ('a0000000-0000-0000-0000-000000000023',1,0,10.000);
select sequence_no,stage_type,label,in_greater_of_comparison from payroll.pay_structure_stages
 where version_id='77777777-0000-0000-0000-000000000003' order by sequence_no;

\echo V19_A2_commission_is_retroactive_30pct_of_all_revenue
select s.tier_semantics,b.rate_percent from payroll.pay_structure_stages s
 join payroll.pay_structure_bands b on b.stage_id=s.id
 where s.id='a0000000-0000-0000-0000-000000000021';

insert into payroll.pay_periods (id,business_id,kind,frequency,period_start,period_end)
values ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111','calculation','weekly','2026-07-21','2026-07-28');

\echo V20_target_adjustment_requires_reason_and_actor
insert into payroll.target_adjustments (id,business_id,staff_profile_id,pay_period_id,original_target_cents,adjusted_target_cents,reason,adjusted_by_user_profile_id)
values ('d0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444',
        '88888888-8888-8888-8888-888888888888',146520,120000,'Covered reception for two days at owner request','33333333-3333-3333-3333-333333333333');
select original_target_cents,adjusted_target_cents,(adjusted_at is not null) as stamped from payroll.target_adjustments;

\echo V20a_blank_reason_ERROR
insert into payroll.target_adjustments (business_id,staff_profile_id,pay_period_id,original_target_cents,adjusted_target_cents,reason,adjusted_by_user_profile_id)
values ('11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','88888888-8888-8888-8888-888888888888',146520,120000,'   ','33333333-3333-3333-3333-333333333333');

\echo V20b_no_actor_ERROR
insert into payroll.target_adjustments (business_id,staff_profile_id,pay_period_id,original_target_cents,adjusted_target_cents,reason)
values ('11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','88888888-8888-8888-8888-888888888888',146520,120000,'No actor');

\echo V20c_adjustment_is_append_only_ERROR
update payroll.target_adjustments set adjusted_target_cents=1 where id='d0000000-0000-0000-0000-000000000001';
delete from payroll.target_adjustments where id='d0000000-0000-0000-0000-000000000001';
select adjusted_target_cents from payroll.target_adjustments where id='d0000000-0000-0000-0000-000000000001';

\echo V21_uncaptured_source_shows_warning_not_zero
insert into payroll.pay_summaries (id,business_id,pay_period_id,staff_profile_id,employment_type_snapshot,structure_version_id,gross_payable_cents)
values ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','88888888-8888-8888-8888-888888888888',
        '44444444-4444-4444-4444-444444444444','employed','77777777-7777-7777-7777-777777777777',0);
select tips_paid_out_cents,tips_owed_cents from payroll.pay_summaries;
insert into payroll.pay_summary_lines (summary_id,sequence_no,line_type,label,amount_cents,source_unavailable,unavailable_source)
values ('99999999-9999-9999-9999-999999999999',1,'tip','Tips',0,true,'tips');
select label,source_unavailable,unavailable_source from payroll.pay_summary_lines;

\echo V21a_uncaptured_line_with_nonzero_figure_ERROR
insert into payroll.pay_summary_lines (summary_id,sequence_no,line_type,amount_cents,source_unavailable,unavailable_source)
values ('99999999-9999-9999-9999-999999999999',2,'tip',5000,true,'tips');

\echo V21b_missing_sources_reported_for_LOH_template
select source,stage_label from payroll.missing_data_sources('77777777-7777-7777-7777-777777777777');
