/**
 * Idempotent Week 6 ticket 7 demo seed — Dead stock alerts.
 *
 * Dead stock needs HISTORY: an item is only dead after weeks without an
 * outbound movement, which no live walkthrough can produce on the day. This
 * seed writes that history with backdated movements so the screen has
 * something honest to show:
 *
 *   WEEK6-DEAD-MASK    gram  restocked 200 days ago, last used 120 days ago
 *                            -> DEAD by the location default (90 days)
 *   WEEK6-DEAD-SPRAY   unit  restocked 60 days ago, never used, 30-day
 *                            product override -> DEAD, shown as "Never used"
 *   WEEK6-DEAD-GLOSS   gram  used 5 days ago -> alive, must NOT appear
 *
 * Re-running is safe: products upsert on their SKU, stock is reset to the
 * exact demo quantities, and previous demo movements (tagged with the
 * 'week6-dead-stock-demo' reason) are deleted before being re-inserted.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-dead-stock -- --business <id> --location <id>
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
  console.error('Usage: seed-dead-stock -- --business <id> --location <id>');
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

const DEMO_REASON = 'week6-dead-stock-demo';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Demo products keyed by SKU, with their backdated movement history. */
const PRODUCTS = [
  {
    sku: 'WEEK6-DEAD-MASK',
    name: 'Demo Treatment Mask',
    brand: 'Week6 Demo',
    stock_unit: 'gram',
    pack_size: 200,
    size_value: 200,
    default_cost_per_gram_cents: 4,
    dead_stock_days: null,
    stockQuantity: 400,
    stockCreatedDaysAgo: 200,
    movements: [
      { movement_type: 'restock', quantity_delta_grams: 500, daysAgo: 200 },
      { movement_type: 'formula_usage', quantity_delta_grams: -100, daysAgo: 120 },
    ],
  },
  {
    sku: 'WEEK6-DEAD-SPRAY',
    name: 'Demo Finishing Spray',
    brand: 'Week6 Demo',
    stock_unit: 'unit',
    pack_size: null,
    size_value: null,
    default_cost_per_gram_cents: 850,
    // Product override: dead after 30 days, whatever the location default says.
    dead_stock_days: 30,
    stockQuantity: 12,
    stockCreatedDaysAgo: 60,
    movements: [{ movement_type: 'restock', quantity_delta_grams: 12, daysAgo: 60 }],
  },
  {
    sku: 'WEEK6-DEAD-GLOSS',
    name: 'Demo Gloss',
    brand: 'Week6 Demo',
    stock_unit: 'gram',
    pack_size: 100,
    size_value: 100,
    default_cost_per_gram_cents: 6,
    dead_stock_days: null,
    stockQuantity: 300,
    stockCreatedDaysAgo: 200,
    movements: [
      { movement_type: 'restock', quantity_delta_grams: 350, daysAgo: 200 },
      { movement_type: 'formula_usage', quantity_delta_grams: -50, daysAgo: 5 },
    ],
  },
] as const;

async function main(): Promise<void> {
  console.log(`Seeding dead-stock demo for business ${businessId} / location ${locationId}`);

  for (const product of PRODUCTS) {
    const { stockQuantity, stockCreatedDaysAgo, movements, ...columns } = product;

    const { data, error } = await admin
      .schema('inventory')
      .from('products')
      .upsert(
        {
          ...columns,
          business_id: businessId,
          default_unit: product.stock_unit === 'unit' ? 'unit' : 'g',
          low_stock_threshold_grams: 0,
          is_active: true,
          is_lab_use: true,
          is_salon_use: false,
          is_retail: false,
        },
        { onConflict: 'business_id,sku' },
      )
      .select('id')
      .single<{ id: string }>();
    if (error || !data) throw new Error(`products ${product.sku}: ${error?.message ?? 'no row'}`);
    const productId = data.id;

    // Reset the shelf record to the exact demo state, including the backdated
    // created_at that anchors the idle clock for never-used stock.
    const { error: stockError } = await admin
      .schema('inventory')
      .from('location_stock')
      .upsert(
        {
          business_id: businessId,
          location_id: locationId,
          product_id: productId,
          quantity_on_hand_grams: stockQuantity,
          is_active: true,
          created_at: daysAgo(stockCreatedDaysAgo),
        },
        { onConflict: 'location_id,product_id' },
      );
    if (stockError) throw new Error(`location_stock ${product.sku}: ${stockError.message}`);

    // Replace this product's demo movement history rather than stacking a new
    // copy on every run.
    const { error: clearError } = await admin
      .schema('inventory')
      .from('stock_movements')
      .delete()
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .eq('product_id', productId)
      .eq('reason', DEMO_REASON);
    if (clearError) throw new Error(`clear movements ${product.sku}: ${clearError.message}`);

    const { error: movementError } = await admin
      .schema('inventory')
      .from('stock_movements')
      .insert(
        movements.map((movement) => ({
          business_id: businessId,
          location_id: locationId,
          product_id: productId,
          movement_type: movement.movement_type,
          quantity_delta_grams: movement.quantity_delta_grams,
          reason: DEMO_REASON,
          created_at: daysAgo(movement.daysAgo),
        })),
      );
    if (movementError) throw new Error(`movements ${product.sku}: ${movementError.message}`);

    console.log(`  ${product.sku} -> ${productId} (${movements.length} movements)`);
  }

  console.log('');
  console.log('Done. Expected on /inventory (Dead stock section):');
  console.log('  Demo Treatment Mask  DEAD  ~120 idle days vs the location default (90)');
  console.log('  Demo Finishing Spray DEAD  ~60 idle days vs its 30-day product override, "Never used"');
  console.log('  Demo Gloss           absent (used 5 days ago)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
