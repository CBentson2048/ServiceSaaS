/**
 * Idempotent LOH (Luke Ormsby Hair) pay-template seed for DEV review.
 *
 * Creates, for the target business:
 *   - pay structure "LOH Standard" (is_system = true) + version 1
 *   - stage 1: hourly base pay
 *   - stage 2: service commission — marginal, multiple_of_base_pay,
 *              bands 0x/0%, 3.0x/10%, 3.5x/15% with accelerator_rate 30%
 *   - stage 3: retail commission — marginal, percent_of_service_target,
 *              bands 0%/0%, 10%/10% (renders "source not captured" until
 *              retail capture ships — that is correct and expected)
 *   - all-of-three accelerator (rebooking >= 50%, retail target met,
 *              average bill >= staff benchmark)
 *   - all 8 version_hour_rules per the signed-off matrix
 *   - one staff_pay_assignment per staff profile passed via --staff (or the
 *     first active staff member when omitted)
 *
 * Values from docs/payroll-loh-template.md (confirmed by Luke 2026-07-27).
 * Rule data, not defaults — this is ONE template among many.
 *
 * ⚠️ Once a pay run prices this version, its stages/bands/conditions freeze
 * (assert_rule_version_unused). To change rates afterwards: close the version
 * (set effective_to) and insert version 2 — never edit in place.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-loh-pay-template -- --business <business_id> [--staff <staff_profile_id>...]
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from apps/api/.env(.local)
 * or the repo root .env. Never run against production.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
for (const envPath of [
  path.join(apiRoot, '.env.local'),
  path.join(apiRoot, '.env'),
  path.join(repoRoot, '.env'),
]) {
  dotenv.config({ path: envPath });
}

const STRUCTURE_NAME = 'LOH Standard';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argAll(flag: string): string[] {
  const values: string[] = [];
  process.argv.forEach((token, index) => {
    if (token === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  });
  return values;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const businessId = arg('--business');
  if (!businessId) {
    throw new Error('Pass --business <business_id>');
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const payroll = admin.schema('payroll');

  // ---- Structure (idempotent by unique lower(name) per business) ----
  const { data: existingStructure } = await payroll
    .from('pay_structures')
    .select('id')
    .eq('business_id', businessId)
    .ilike('name', STRUCTURE_NAME)
    .maybeSingle();
  let structureId = existingStructure?.id as string | undefined;
  if (!structureId) {
    const { data, error } = await payroll
      .from('pay_structures')
      .insert({
        business_id: businessId,
        name: STRUCTURE_NAME,
        description:
          'Luke Ormsby Hair template: hourly base + marginal service commission (3.0x/10%, 3.5x/15%, accelerator 30%) + retail 10% above 10%-of-target.',
        is_system: true,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`structure insert failed: ${error?.message}`);
    structureId = data.id;
    console.log(`created structure ${structureId}`);
  } else {
    console.log(`structure exists: ${structureId}`);
  }

  // ---- Version 1 (idempotent by (structure, version_no)) ----
  const { data: existingVersion } = await payroll
    .from('pay_structure_versions')
    .select('id')
    .eq('structure_id', structureId)
    .eq('version_no', 1)
    .maybeSingle();
  let versionId = existingVersion?.id as string | undefined;
  if (!versionId) {
    const { data, error } = await payroll
      .from('pay_structure_versions')
      .insert({
        business_id: businessId,
        structure_id: structureId,
        version_no: 1,
        effective_from: '2026-01-06', // a Tuesday
        discount_basis: 'headline_before_discount',
        vat_basis: 'exclusive',
        deposit_recognition: 'on_completion',
        product_cost_mode: 'none',
        notes: 'Seeded LOH template v1 (docs/payroll-loh-template.md).',
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`version insert failed: ${error?.message}`);
    versionId = data.id;
    console.log(`created version ${versionId}`);
  } else {
    console.log(`version exists: ${versionId} — stages/bands assumed present, skipping rebuild`);
  }

  // ---- Stages / bands / accelerator / hour rules (only on fresh version) ----
  const { data: stageProbe } = await payroll
    .from('pay_structure_stages')
    .select('id')
    .eq('version_id', versionId)
    .limit(1);
  if (!stageProbe || stageProbe.length === 0) {
    const { data: stages, error: stagesError } = await payroll
      .from('pay_structure_stages')
      .insert([
        {
          version_id: versionId,
          sequence_no: 1,
          stage_type: 'base_pay',
          label: 'Hourly base pay',
          config: { source: 'hourly_rate_x_payable_hours' },
        },
        {
          version_id: versionId,
          sequence_no: 2,
          stage_type: 'commission',
          label: 'Service commission',
          tier_semantics: 'marginal',
          threshold_basis: 'multiple_of_base_pay',
          revenue_stream: 'service',
          requires_data_source: 'service_revenue',
        },
        {
          version_id: versionId,
          sequence_no: 3,
          stage_type: 'commission',
          label: 'Retail commission',
          tier_semantics: 'marginal',
          threshold_basis: 'percent_of_service_target',
          revenue_stream: 'retail',
          requires_data_source: 'retail_sales',
        },
      ])
      .select('id,sequence_no');
    if (stagesError || !stages) throw new Error(`stages insert failed: ${stagesError?.message}`);
    const serviceStage = stages.find((s) => s.sequence_no === 2)!;
    const retailStage = stages.find((s) => s.sequence_no === 3)!;

    const { error: bandsError } = await payroll.from('pay_structure_bands').insert([
      { stage_id: serviceStage.id, sequence_no: 1, from_multiple: 0, rate_percent: 0 },
      { stage_id: serviceStage.id, sequence_no: 2, from_multiple: 3.0, rate_percent: 10 },
      {
        stage_id: serviceStage.id,
        sequence_no: 3,
        from_multiple: 3.5,
        rate_percent: 15,
        accelerator_rate_percent: 30,
      },
      { stage_id: retailStage.id, sequence_no: 1, from_percent: 0, rate_percent: 0 },
      { stage_id: retailStage.id, sequence_no: 2, from_percent: 10, rate_percent: 10 },
    ]);
    if (bandsError) throw new Error(`bands insert failed: ${bandsError.message}`);

    const { data: accelerator, error: accError } = await payroll
      .from('accelerators')
      .insert({
        version_id: versionId,
        stage_id: serviceStage.id,
        name: 'LOH all-three accelerator',
        evaluation_mode: 'all',
      })
      .select('id')
      .single();
    if (accError || !accelerator)
      throw new Error(`accelerator insert failed: ${accError?.message}`);

    const { error: conditionsError } = await payroll.from('accelerator_conditions').insert([
      {
        accelerator_id: accelerator.id,
        sequence_no: 1,
        metric: 'rebooking_rate_percent',
        comparator: 'gte',
        basis: 'percent',
        threshold_value: 50,
      },
      {
        accelerator_id: accelerator.id,
        sequence_no: 2,
        metric: 'retail_revenue',
        comparator: 'gte',
        basis: 'target_met',
      },
      {
        accelerator_id: accelerator.id,
        sequence_no: 3,
        metric: 'average_bill',
        comparator: 'gte',
        basis: 'staff_benchmark',
      },
    ]);
    if (conditionsError) throw new Error(`conditions insert failed: ${conditionsError.message}`);

    const hourRules: Array<{ category: string; target: boolean; paid: boolean }> = [
      { category: 'worked', target: true, paid: true },
      { category: 'additional', target: true, paid: true },
      { category: 'manual_adjustment', target: true, paid: true },
      { category: 'paid_holiday', target: false, paid: true },
      { category: 'training', target: false, paid: true },
      { category: 'sickness', target: false, paid: false },
      { category: 'authorised_absence', target: false, paid: false },
      { category: 'unpaid_leave', target: false, paid: false },
    ];
    const { error: hoursError } = await payroll.from('version_hour_rules').insert(
      hourRules.map((rule) => ({
        version_id: versionId,
        category: rule.category,
        counts_toward_target: rule.target,
        counts_as_paid: rule.paid,
      })),
    );
    if (hoursError) throw new Error(`hour rules insert failed: ${hoursError.message}`);
    console.log('created stages, bands, accelerator, conditions, hour rules');
  } else {
    console.log('stages already present — leaving rule rows untouched (they may be frozen)');
  }

  // ---- Assignments ----
  let staffIds = argAll('--staff');
  if (staffIds.length === 0) {
    const { data: staff } = await admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', businessId)
      .neq('employment_status', 'terminated')
      .limit(1);
    staffIds = (staff ?? []).map((s) => s.id);
  }
  for (const staffProfileId of staffIds) {
    const { data: existing } = await payroll
      .from('staff_pay_assignments')
      .select('id')
      .eq('staff_profile_id', staffProfileId)
      .is('effective_to', null)
      .maybeSingle();
    if (existing) {
      console.log(`assignment exists for ${staffProfileId}`);
      continue;
    }
    const { error } = await payroll.from('staff_pay_assignments').insert({
      business_id: businessId,
      staff_profile_id: staffProfileId,
      structure_id: structureId,
      effective_from: '2026-01-06',
      notes: 'Seeded LOH template assignment',
    });
    if (error) throw new Error(`assignment insert failed for ${staffProfileId}: ${error.message}`);
    console.log(`assigned ${staffProfileId}`);
  }

  console.log('LOH pay template seed complete.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
