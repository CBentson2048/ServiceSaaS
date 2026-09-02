/**
 * Idempotent demo seed for formula change detection (Wrike 4507283774).
 *
 * Builds the deterministic scenario the Luke walkthrough needs, so the demo is
 * reproducible rather than dependent on whatever happens to be in the database
 * that morning. It creates ONE client with THREE colour visits that step through
 * the exact behaviour the ticket asks to be proven:
 *
 *   Visit 1 (12 weeks ago)  50% Product A  +  50% Product B     the baseline
 *   Visit 2 (6 weeks ago)   48% Product A  +  52% Product B     a 2% ratio tweak
 *                                                               -> NO flag
 *   Visit 3 (today)         20% Product A  +  80% Product C     a real swap
 *                                                               -> SIGNIFICANT
 *
 * Visit 3's reasons are exactly what the stylist sees:
 *   - formula composition changed by 60%
 *   - Product C added (80% of the mix)
 *   - Product B removed (was 52% of the mix)
 *
 * A FOURTH visit is deliberately seeded as a TONER, so the demo can show that a
 * toner is never compared against a root colour — the comparability rule that
 * stops the feature crying wolf.
 *
 * WHAT THIS DOES NOT DO. It never touches a real client's formulas, never
 * deducts stock, and never writes an assessment: detection is computed on read,
 * so there is nothing to seed on that side. The demo products carry a DEMO-FC
 * SKU prefix and the client a DEMO-FC client code, so everything it creates is
 * identifiable and removable.
 *
 * Re-running replaces this client's demo history rather than stacking a second
 * set of visits on top of it.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-formula-change-demo -- --business <id> --location <id>
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
  console.error('Usage: seed-formula-change-demo -- --business <id> --location <id>');
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

const CLIENT_CODE = 'DEMO-FC';
const PRODUCTS = [
  { sku: 'DEMO-FC-A', name: 'Demo Colour A', brand: 'Demo' },
  { sku: 'DEMO-FC-B', name: 'Demo Colour B', brand: 'Demo' },
  { sku: 'DEMO-FC-C', name: 'Demo Colour C', brand: 'Demo' },
  { sku: 'DEMO-FC-T', name: 'Demo Toner T', brand: 'Demo' },
];

interface DemoVisit {
  label: string;
  daysAgo: number;
  /** Colour billing category for the appointment's service. */
  billingCategory: 'permanent_colour' | 'semi_toners';
  /** sku -> grams. */
  mix: Record<string, number>;
  developer: string;
  expectation: string;
}

const VISITS: DemoVisit[] = [
  {
    label: 'Visit 1 — baseline',
    daysAgo: 84,
    billingCategory: 'permanent_colour',
    mix: { 'DEMO-FC-A': 50, 'DEMO-FC-B': 50 },
    developer: '20 vol',
    expectation: 'the baseline formula',
  },
  {
    label: 'Visit 2 — minor tweak',
    daysAgo: 42,
    billingCategory: 'permanent_colour',
    mix: { 'DEMO-FC-A': 48, 'DEMO-FC-B': 52 },
    developer: '20 vol',
    expectation: 'NO significant change (2% composition shift)',
  },
  {
    label: 'Visit 3 — material change',
    daysAgo: 0,
    billingCategory: 'permanent_colour',
    mix: { 'DEMO-FC-A': 20, 'DEMO-FC-C': 80 },
    developer: '20 vol',
    expectation: 'SIGNIFICANT: composition 60%, C added, B removed',
  },
  {
    label: 'Visit 4 — toner (not comparable)',
    daysAgo: 7,
    billingCategory: 'semi_toners',
    mix: { 'DEMO-FC-T': 100 },
    developer: '10 vol',
    expectation: 'never compared against the root colour above',
  },
];

async function main(): Promise<void> {
  console.log(`Seeding formula-change demo for ${businessId} / ${locationId}.`);

  const productIds = await upsertProducts();
  const clientId = await upsertClient();
  const categoryIds = await ensureServiceCategories();
  const serviceIds = await ensureServices(categoryIds);

  await clearDemoHistory(clientId);

  for (const visit of VISITS) {
    await seedVisit(visit, clientId, productIds, serviceIds[visit.billingCategory]);
    console.log(`  ${visit.label}: ${visit.expectation}`);
  }

  console.log('');
  console.log('Open the client profile for DEMO-FC to see the flag on Visit 3.');
  console.log('Thresholds live at Settings -> Formula change alerts.');
}

// ---------------------------------------------------------------------------
// Catalogue and client
// ---------------------------------------------------------------------------

async function upsertProducts(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const product of PRODUCTS) {
    const { data, error } = await admin
      .schema('inventory')
      .from('products')
      .upsert(
        {
          business_id: businessId,
          sku: product.sku,
          name: product.name,
          brand: product.brand,
          // Grams throughout, so shares are computed over one basis. A demo that
          // mixed units would exercise the "unavailable" path instead.
          stock_unit: 'gram',
          is_lab_use: true,
        },
        { onConflict: 'business_id,sku' },
      )
      .select('id,sku')
      .maybeSingle<{ id: string; sku: string }>();
    if (error) throw new Error(`product ${product.sku}: ${error.message}`);
    if (data) ids.set(product.sku, data.id);
  }
  return ids;
}

async function upsertClient(): Promise<string> {
  const { data, error } = await admin
    .schema('core')
    .from('client_profiles')
    .upsert(
      {
        business_id: businessId,
        client_code: CLIENT_CODE,
        primary_location_id: locationId,
        first_name: 'Jane',
        last_name: 'Formula',
        email: 'jane.formula@example.com',
        phone: '+447700900301',
        source: 'demo_seed',
      },
      { onConflict: 'business_id,client_code' },
    )
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`client: ${error.message}`);
  if (!data) throw new Error('client: no row returned');
  return data.id;
}

/**
 * Colour service categories mapped to their billing category — the linkage that
 * makes a formula comparable (or not) to another.
 */
async function ensureServiceCategories(): Promise<Record<string, string>> {
  const wanted = [
    { name: 'Demo Colour', billing: 'permanent_colour' },
    { name: 'Demo Toning', billing: 'semi_toners' },
  ];
  const ids: Record<string, string> = {};

  for (const category of wanted) {
    const { data: existing } = await admin
      .schema('booking')
      .from('service_categories')
      .select('id')
      .eq('business_id', businessId)
      .eq('name', category.name)
      .maybeSingle<{ id: string }>();

    if (existing) {
      await admin
        .schema('booking')
        .from('service_categories')
        .update({ billing_category: category.billing })
        .eq('id', existing.id);
      ids[category.billing] = existing.id;
      continue;
    }

    const { data, error } = await admin
      .schema('booking')
      .from('service_categories')
      .insert({ business_id: businessId, name: category.name, billing_category: category.billing })
      .select('id')
      .maybeSingle<{ id: string }>();
    if (error) throw new Error(`service category ${category.name}: ${error.message}`);
    if (data) ids[category.billing] = data.id;
  }
  return ids;
}

async function ensureServices(categoryIds: Record<string, string>): Promise<Record<string, string>> {
  const wanted = [
    { slug: 'demo-fc-colour', name: 'Demo Full Head Colour', billing: 'permanent_colour' },
    { slug: 'demo-fc-toner', name: 'Demo Toner', billing: 'semi_toners' },
  ];
  const ids: Record<string, string> = {};

  for (const service of wanted) {
    const { data, error } = await admin
      .schema('booking')
      .from('services')
      .upsert(
        {
          business_id: businessId,
          slug: service.slug,
          name: service.name,
          service_category_id: categoryIds[service.billing],
          estimated_duration_minutes: 90,
          base_price: 95,
        },
        { onConflict: 'business_id,slug' },
      )
      .select('id')
      .maybeSingle<{ id: string }>();
    if (error) throw new Error(`service ${service.slug}: ${error.message}`);
    if (data) ids[service.billing] = data.id;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Deleting first is what makes this re-runnable: visits are anchored to now. */
async function clearDemoHistory(clientId: string): Promise<void> {
  await admin.schema('lab').from('formulas').delete().eq('client_profile_id', clientId);
  await admin.schema('booking').from('appointments').delete().eq('client_profile_id', clientId);
}

async function seedVisit(
  visit: DemoVisit,
  clientId: string,
  productIds: Map<string, string>,
  serviceId: string,
): Promise<void> {
  const at = new Date(Date.now() - visit.daysAgo * 86_400_000);
  const end = new Date(at.getTime() + 90 * 60_000);

  const { data: appointment, error: appointmentError } = await admin
    .schema('booking')
    .from('appointments')
    .insert({
      business_id: businessId,
      location_id: locationId,
      client_profile_id: clientId,
      status: 'paid',
      scheduled_start_at: at.toISOString(),
      scheduled_end_at: end.toISOString(),
      completed_at: end.toISOString(),
      // NOT NULL since 0050. Every sibling seed sets it; omitting it here made
      // this ticket's own demo abort on the first appointment insert.
      occupied_ranges: `{["${at.toISOString()}","${end.toISOString()}")}`,
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (appointmentError) throw new Error(`appointment: ${appointmentError.message}`);
  if (!appointment) throw new Error('appointment: no row returned');

  // The service link is what gives the formula its comparability key.
  const { error: linkError } = await admin
    .schema('booking')
    .from('appointment_services')
    .insert({
      business_id: businessId,
      location_id: locationId,
      appointment_id: appointment.id,
      service_id: serviceId,
      sequence_no: 1,
      service_name_snapshot: visit.billingCategory === 'semi_toners' ? 'Demo Toner' : 'Demo Full Head Colour',
      duration_minutes: 90,
    });
  if (linkError) throw new Error(`appointment service: ${linkError.message}`);

  // status='saved' + saved_at is what makes this a FINALISED formula, which is
  // the only kind detection reads.
  const { data: formula, error: formulaError } = await admin
    .schema('lab')
    .from('formulas')
    .insert({
      business_id: businessId,
      location_id: locationId,
      client_profile_id: clientId,
      appointment_id: appointment.id,
      external_formula_id: `demo-fc-${visit.daysAgo}`,
      status: 'saved',
      saved_at: end.toISOString(),
      service_name_snapshot: visit.billingCategory === 'semi_toners' ? 'Demo Toner' : 'Demo Full Head Colour',
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (formulaError) throw new Error(`formula: ${formulaError.message}`);
  if (!formula) throw new Error('formula: no row returned');

  const items = Object.entries(visit.mix).map(([sku, grams], index) => ({
    formula_id: formula.id,
    external_item_id: `${formula.id}-${index}`,
    product_id: productIds.get(sku) ?? null,
    product_name: PRODUCTS.find((p) => p.sku === sku)?.name ?? sku,
    brand: 'Demo',
    developer: visit.developer,
    captured_grams: grams,
    entry_mode: 'manual' as const,
  }));

  const { error: itemsError } = await admin.schema('lab').from('formula_items').insert(items);
  if (itemsError) throw new Error(`formula items: ${itemsError.message}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
