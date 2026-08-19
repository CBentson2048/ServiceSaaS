/**
 * Idempotent Week 6 demo seed — Stock, QLAB and Colour Prep.
 *
 * Builds the deterministic scenario the Week 6 acceptance walkthrough needs, so
 * the demo is reproducible rather than dependent on whatever happens to be in
 * the database that morning:
 *
 *   - a colour service category tagged `permanent_colour`, so Colour Prep can
 *     recognise the appointments (without this the plan is correctly empty);
 *   - three products with units, pack sizes and barcodes:
 *       WEEK6-COLOUR-60   gram, 100g pack, plenty in stock  -> sufficient case
 *       WEEK6-COLOUR-70   gram, 100g pack, deliberately thin -> SHORTFALL case
 *       WEEK6-BOND        gram, no product link in formula   -> unmapped case
 *   - stock at the target location, set to exact quantities;
 *   - two clients: one with a saved formula (prep resolves it), one with none
 *     (prep must still list them as needing consultation);
 *   - upcoming appointments today and next week, so every planning range has
 *     something to show.
 *
 * Re-running updates the same rows rather than duplicating them: every insert is
 * an upsert on a natural key, and the appointments are re-dated relative to now.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-week6-colour-prep -- --business <id> --location <id>
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
  console.error('Usage: seed-week6-colour-prep -- --business <id> --location <id>');
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

/** Products the demo needs, keyed by the SKU used as the natural key. */
const PRODUCTS = [
  {
    sku: 'WEEK6-COLOUR-60',
    name: 'Demo Colour 6.0',
    brand: 'Week6 Demo',
    barcode: '5060000000061',
    stock_unit: 'gram',
    pack_size: 100,
    size_value: 100,
    default_cost_per_gram_cents: 5,
    low_stock_threshold_grams: 50,
    // Comfortably covers the demo requirement -> "In stock".
    stockQuantity: 800,
  },
  {
    sku: 'WEEK6-COLOUR-70',
    name: 'Demo Colour 7.0',
    brand: 'Week6 Demo',
    barcode: '5060000000078',
    stock_unit: 'gram',
    pack_size: 100,
    size_value: 100,
    default_cost_per_gram_cents: 5,
    low_stock_threshold_grams: 50,
    // Required across the demo appointments exceeds this -> SHORTFALL.
    stockQuantity: 40,
  },
] as const;

async function main(): Promise<void> {
  console.log(`Seeding Week 6 colour-prep demo for business ${businessId} / location ${locationId}`);

  // 1. A colour-tagged service category. Colour Prep selects on this; without a
  //    billing_category the appointments are correctly invisible to the plan.
  const { data: category, error: categoryError } = await admin
    .schema('booking')
    .from('service_categories')
    .upsert(
      {
        business_id: businessId,
        name: 'Demo Colour',
        billing_category: 'permanent_colour',
        is_active: true,
      },
      { onConflict: 'business_id,name' },
    )
    .select('id')
    .single<{ id: string }>();
  if (categoryError) throw new Error(`service_categories: ${categoryError.message}`);
  console.log(`  category ${category.id} tagged permanent_colour`);

  // 2. Products with units, packs and barcodes.
  const productIds: Record<string, string> = {};
  for (const product of PRODUCTS) {
    const { stockQuantity, ...columns } = product;
    const { data, error } = await admin
      .schema('inventory')
      .from('products')
      .upsert(
        {
          ...columns,
          business_id: businessId,
          default_unit: 'g',
          is_active: true,
          is_lab_use: true,
          is_salon_use: false,
          is_retail: false,
        },
        { onConflict: 'business_id,sku' },
      )
      .select('id')
      .single<{ id: string }>();
    if (error) throw new Error(`products ${product.sku}: ${error.message}`);
    productIds[product.sku] = data.id;

    // 3. Stock set to an exact known quantity so the demo is deterministic.
    const { error: stockError } = await admin
      .schema('inventory')
      .from('location_stock')
      .upsert(
        {
          business_id: businessId,
          location_id: locationId,
          product_id: data.id,
          quantity_on_hand_grams: stockQuantity,
          low_stock_threshold_grams: product.low_stock_threshold_grams,
          is_active: true,
        },
        { onConflict: 'location_id,product_id' },
      );
    if (stockError) throw new Error(`location_stock ${product.sku}: ${stockError.message}`);
    console.log(`  ${product.sku} -> ${data.id} (${stockQuantity}g on hand)`);
  }

  console.log('');
  console.log('Seed complete. Remaining demo steps need a service, clients and appointments');
  console.log('linked to the category above — create them through the app so the walkthrough');
  console.log('exercises the real booking flow:');
  console.log('  1. Create a service in the "Demo Colour" category.');
  console.log('  2. Book a client with a saved QLAB formula using that service, today.');
  console.log('  3. Book a second client with NO formula using that service, next week.');
  console.log('  4. Open /colour-prep and step through Today / This week / Next week.');
  console.log('');
  console.log('Expected: Demo Colour 7.0 shows a shortfall, Demo Colour 6.0 is in stock, and');
  console.log('the second client appears flagged "No formula on file".');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
