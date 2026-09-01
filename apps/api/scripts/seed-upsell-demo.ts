/**
 * Idempotent demo seed for rule-based upsell suggestions (Wrike 4507283916).
 *
 * Builds the deterministic scenario the Luke walkthrough needs, so the demo is
 * reproducible rather than dependent on whatever happens to be in the database
 * that morning:
 *
 *   - a "Demo Colour" service category and four services:
 *       DEMO-COLOUR     Full Head Colour   the trigger
 *       DEMO-TONER      Toner              the OWNER-CONFIGURED add-on
 *       DEMO-TREATMENT  Olaplex Treatment  the HISTORY-ONLY add-on
 *       DEMO-CUT        Dry Cut            the control: triggers nothing
 *   - one enabled owner rule: Full Head Colour -> Toner;
 *   - 20 completed (paid) historical appointments containing Full Head Colour,
 *     12 of which also contain Toner and 5 of which also contain Olaplex.
 *
 * WHY THOSE NUMBERS. They are the smallest set that makes every threshold in
 * UPSELL_PATTERN_THRESHOLDS visibly bite:
 *       base 20            >= minBaseSample 10        -> the trigger qualifies
 *       Toner 12/20 = 0.60 >= minRate 0.20            -> suggested
 *       Olaplex 5/20 = 0.25>= minRate 0.20            -> suggested ("frequently
 *                                                        booked together")
 *   and Dry Cut, with no rule and no co-occurrence, produces nothing at all —
 *   which is the "irrelevant service gets no suggestion" step of the demo.
 *
 * The history is REAL completed appointments, not invented counts: the same
 * rows booking.service_cooccurrence reads in production.
 *
 * Re-running updates the same rows rather than duplicating them: services and
 * the rule upsert on their natural keys, and the demo appointments are deleted
 * and re-created relative to now so the lookback window always contains them.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-upsell-demo -- --business <id> --location <id>
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from apps/api/.env(.local) or
 * the repo root .env. Never run against production.
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

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const businessId = arg('business');
const locationId = arg('location');

if (!businessId || !locationId) {
  console.error('Usage: seed-upsell-demo -- --business <id> --location <id>');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SERVICES = [
  { slug: 'demo-upsell-colour', name: 'Full Head Colour', minutes: 120, price: 95 },
  { slug: 'demo-upsell-toner', name: 'Toner', minutes: 30, price: 35 },
  { slug: 'demo-upsell-treatment', name: 'Olaplex Treatment', minutes: 20, price: 25 },
  { slug: 'demo-upsell-cut', name: 'Dry Cut', minutes: 30, price: 30 },
] as const;

/** Of 20 Colour appointments: how many also carry each add-on. */
const BASE_APPOINTMENTS = 20;
const TONER_COOCCURRENCE = 12;
const TREATMENT_COOCCURRENCE = 5;

async function main(): Promise<void> {
  console.log(`Seeding upsell demo for business ${businessId} / location ${locationId}`);

  // 1. Category.
  const { data: category, error: categoryError } = await admin
    .schema('booking')
    .from('service_categories')
    .upsert(
      { business_id: businessId, name: 'Demo Colour', is_active: true },
      { onConflict: 'business_id,name' },
    )
    .select('id')
    .single<{ id: string }>();
  if (categoryError) throw new Error(`service_categories: ${categoryError.message}`);
  console.log(`  category ${category.id}`);

  // 2. Services.
  const serviceIdBySlug = new Map<string, string>();
  for (const service of SERVICES) {
    const { data, error } = await admin
      .schema('booking')
      .from('services')
      .upsert(
        {
          business_id: businessId,
          location_id: null,
          slug: service.slug,
          name: service.name,
          service_category_id: category.id,
          estimated_duration_minutes: service.minutes,
          base_price: service.price,
          is_active: true,
        },
        { onConflict: 'business_id,location_id,slug' },
      )
      .select('id')
      .single<{ id: string }>();
    if (error) throw new Error(`services ${service.slug}: ${error.message}`);
    serviceIdBySlug.set(service.slug, data.id);
    console.log(`  service ${service.name} -> ${data.id}`);
  }

  const colourId = serviceIdBySlug.get('demo-upsell-colour')!;
  const tonerId = serviceIdBySlug.get('demo-upsell-toner')!;
  const treatmentId = serviceIdBySlug.get('demo-upsell-treatment')!;

  // 3. The owner rule: Full Head Colour -> Toner, business-wide, enabled.
  const { error: ruleError } = await admin
    .schema('booking')
    .from('upsell_rules')
    .upsert(
      {
        business_id: businessId,
        location_id: null,
        name: 'Full Head Colour to Toner',
        enabled: true,
        trigger_type: 'service',
        trigger_service_id: colourId,
        suggested_service_id: tonerId,
        priority: 100,
      },
      { onConflict: 'business_id,location_id,trigger_service_id,suggested_service_id' },
    );
  if (ruleError) throw new Error(`upsell_rules: ${ruleError.message}`);
  console.log('  owner rule: Full Head Colour -> Toner (enabled, all locations)');

  // 4. A demo client to hang the history on.
  const { data: client, error: clientError } = await admin
    .schema('core')
    .from('client_profiles')
    .upsert(
      {
        business_id: businessId,
        primary_location_id: locationId,
        first_name: 'Upsell',
        last_name: 'Demo',
        external_ref: 'demo-upsell-client',
      },
      { onConflict: 'business_id,external_ref' },
    )
    .select('id')
    .single<{ id: string }>();
  if (clientError) throw new Error(`client_profiles: ${clientError.message}`);
  console.log(`  demo client ${client.id}`);

  // 5. History. Cleared and rebuilt so re-running never doubles the counts and
  //    the appointments always sit inside the lookback window.
  const { data: existing, error: existingError } = await admin
    .schema('booking')
    .from('appointments')
    .select('id')
    .eq('business_id', businessId)
    .eq('client_profile_id', client.id)
    .contains('metadata', { demoSeed: 'upsell' })
    .returns<{ id: string }[]>();
  if (existingError) throw new Error(`appointments read: ${existingError.message}`);
  if ((existing ?? []).length > 0) {
    const { error } = await admin
      .schema('booking')
      .from('appointments')
      .delete()
      .in(
        'id',
        existing.map((row) => row.id),
      );
    if (error) throw new Error(`appointments cleanup: ${error.message}`);
    console.log(`  cleared ${existing.length} previous demo appointment(s)`);
  }

  for (let index = 1; index <= BASE_APPOINTMENTS; index += 1) {
    const start = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const lines: Array<{ serviceId: string; name: string; minutes: number; price: number }> = [
      { serviceId: colourId, name: 'Full Head Colour', minutes: 120, price: 95 },
    ];
    if (index <= TONER_COOCCURRENCE) {
      lines.push({ serviceId: tonerId, name: 'Toner', minutes: 30, price: 35 });
    }
    if (index <= TREATMENT_COOCCURRENCE) {
      lines.push({ serviceId: treatmentId, name: 'Olaplex Treatment', minutes: 20, price: 25 });
    }

    const { data: appointment, error: appointmentError } = await admin
      .schema('booking')
      .from('appointments')
      .insert({
        business_id: businessId,
        location_id: locationId,
        client_profile_id: client.id,
        // 'paid' is what a completed appointment is since 0045 — the exact
        // status booking.service_cooccurrence counts.
        status: 'paid',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
        completed_at: end.toISOString(),
        occupied_ranges: `{[${start.toISOString()},${end.toISOString()})}`,
        metadata: { demoSeed: 'upsell' },
      })
      .select('id')
      .single<{ id: string }>();
    if (appointmentError) throw new Error(`appointments insert: ${appointmentError.message}`);

    const { error: linesError } = await admin
      .schema('booking')
      .from('appointment_services')
      .insert(
        lines.map((line, lineIndex) => ({
          business_id: businessId,
          location_id: locationId,
          appointment_id: appointment.id,
          service_id: line.serviceId,
          sequence_no: lineIndex + 1,
          service_name_snapshot: line.name,
          duration_minutes: line.minutes,
          price_amount: line.price,
          status: 'completed',
        })),
      );
    if (linesError) throw new Error(`appointment_services: ${linesError.message}`);
  }

  console.log(
    `  history: ${BASE_APPOINTMENTS} completed Colour appointments ` +
      `(${TONER_COOCCURRENCE} with Toner = ${(TONER_COOCCURRENCE / BASE_APPOINTMENTS).toFixed(2)}, ` +
      `${TREATMENT_COOCCURRENCE} with Olaplex = ${(TREATMENT_COOCCURRENCE / BASE_APPOINTMENTS).toFixed(2)})`,
  );
  console.log('Done. Book Full Head Colour to see Toner (configured) and Olaplex (frequently booked).');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
