/**
 * Week 6 acceptance harness — runs the behavioural suites against a REAL
 * migrated database (dev_test) through the same RPCs the platform uses.
 *
 * WHY THIS EXISTS. The Week 6 arithmetic lives in plpgsql
 * (save_formula_with_reconciliation, adjust_location_stock, dead_stock_report,
 * create_purchase_order, reorder_usage). The Jest suites stub the Supabase
 * client, so they can never prove that a 30g -> 20g correction nets to 20g on
 * a real ledger. The psql suites in supabase/tests/ prove it on a scratch
 * database; THIS script proves it on the actual non-production environment,
 * via PostgREST with the service-role key — no psql or dashboard needed.
 *
 * Everything runs inside its own fixture tenant (UUID prefix a6000000-) and is
 * deleted afterwards unless --keep is passed. NEVER run against production.
 *
 * Usage:
 *   pnpm --filter @sheer/api week6-acceptance            # run + clean up
 *   pnpm --filter @sheer/api week6-acceptance -- --keep  # leave fixtures for UAT
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from apps/api/.env(.local).
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
// The package entry, not a deep path into src: a relative directory import
// resolves to the built package here and silently yielded a module without
// the resolver, which skipped the whole §43 pricing chain at runtime.
import {
  resolveRetailPricing,
  type RetailPricingCandidates,
  type RetailPricingScope,
} from '@sheer/domain';

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');
for (const envPath of [
  path.join(apiRoot, '.env.local'),
  path.join(apiRoot, '.env'),
  path.join(repoRoot, '.env'),
]) {
  dotenv.config({ path: envPath });
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}
if (supabaseUrl.includes('cdjtsqcrcgywjdwvbxyf')) {
  console.error('Refusing to run: SUPABASE_URL points at the PRODUCTION project.');
  process.exit(1);
}

const keep = process.argv.includes('--keep');
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Fixture ids — hex-only, dedicated a6 prefix, disjoint from every other suite
// ---------------------------------------------------------------------------
const id = (suffix: string) => `a6000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
const BIZ = id('1');
const RIVAL = id('2');
const L1 = id('a1');
const L2 = id('a2');
const L3 = id('a3');
const CLIENT = id('c1');
const PREP_CLIENT = id('c3');
const PREP_CLIENT_NEW = id('c4');
// QLAB products
const P_A = id('11');
const P_B = id('12');
const P_UNIT = id('13');
const P_GATED = id('14');
// dead-stock products
const D_BASIC = id('21');
const D_RESTOCKED = id('22');
const D_FRESH = id('23');
const D_ZERO = id('24');
const D_OVER60 = id('25');
const D_OVER20 = id('26');
const D_NEVER = id('27');
const D_ARCHIVED = id('28');
const D_ONLYRESTOCK = id('29');
// suppliers + order product
const SUP_A = id('51');
const SUP_B = id('52');
// colour prep
const CAT_COLOUR = id('61');
const CAT_PLAIN = id('62');
const SVC_COLOUR = id('71');
const SVC_PLAIN = id('72');
const APPT_TOMORROW = id('81');
const APPT_NEXTWEEK = id('82');
const APPT_L2 = id('83');
const APPT_RIVAL = id('84');
const APPT_UNTAGGED = id('85');
const RIVAL_CLIENT = id('c2');
const RIVAL_CAT = id('63');
const RIVAL_SVC = id('73');

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function report(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function must<T>(step: string, promise: Promise<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${step}: ${error.message}`);
  return data;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const daysAhead = (days: number, hour = 10) => {
  const date = new Date(Date.now() + days * 86_400_000);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

async function stockOf(locationId: string, productId: string): Promise<number> {
  const rows = await must(
    'read stock',
    admin
      .schema('inventory')
      .from('location_stock')
      .select('quantity_on_hand_grams')
      .eq('location_id', locationId)
      .eq('product_id', productId) as never,
  );
  const list = rows as { quantity_on_hand_grams: number | string }[];
  return list.length ? Number(list[0].quantity_on_hand_grams) : NaN;
}

async function saveFormula(formulaId: string, items: Record<string, unknown>[], locationId = L1) {
  return admin.schema('lab').rpc('save_formula_with_reconciliation', {
    p_payload: {
      formulaId,
      businessId: BIZ,
      locationId,
      clientProfileId: CLIENT,
      items,
    },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  console.log('\nSetting up the a6 fixture tenant…');
  await must('businesses', admin.schema('core').from('businesses').upsert([
    { id: BIZ, name: 'W6 Acceptance Salon', slug: 'w6-acceptance' },
    { id: RIVAL, name: 'W6 Rival Salon', slug: 'w6-acceptance-rival' },
  ]) as never);
  await must('locations', admin.schema('core').from('locations').upsert([
    { id: L1, business_id: BIZ, code: 'W61', name: 'Acceptance Main', slug: 'w6a-main', address_line_1: '1 Test St', city: 'Leeds', postal_code: 'LS9 1AA', timezone: 'Europe/London' },
    { id: L2, business_id: BIZ, code: 'W62', name: 'Acceptance Second', slug: 'w6a-second', address_line_1: '2 Test St', city: 'Leeds', postal_code: 'LS9 2AA', timezone: 'Europe/London' },
    { id: L3, business_id: RIVAL, code: 'W63', name: 'Rival Main', slug: 'w6a-rival', address_line_1: '3 Test St', city: 'Leeds', postal_code: 'LS9 3AA', timezone: 'Europe/London' },
  ]) as never);
  // Settings rows are created WITHOUT any week-6 column on purpose: the
  // migration-default checks below (A6) read what 0091/0093/0094 actually gave
  // them. NOTE: every row in a PostgREST bulk insert must carry the SAME keys —
  // mixed shapes fill the gaps with null, not the column default.
  await must('location_settings', admin.schema('core').from('location_settings').upsert([
    { business_id: BIZ, location_id: L1 },
    { business_id: BIZ, location_id: L2 },
  ], { onConflict: 'location_id' }) as never);
  await must('clients', admin.schema('core').from('client_profiles').upsert([
    { id: CLIENT, business_id: BIZ, first_name: 'Accept', last_name: 'Ance' },
    { id: PREP_CLIENT, business_id: BIZ, first_name: 'Colour', last_name: 'Regular' },
    { id: PREP_CLIENT_NEW, business_id: BIZ, first_name: 'First', last_name: 'Timer' },
    { id: RIVAL_CLIENT, business_id: RIVAL, first_name: 'Rival', last_name: 'Client' },
  ]) as never);
  await must('suppliers', admin.schema('inventory').from('suppliers').upsert([
    { id: SUP_A, business_id: BIZ, name: 'W6A Supplier A', contact_email: 'a@w6a.test' },
    { id: SUP_B, business_id: BIZ, name: 'W6A Supplier B', contact_email: 'b@w6a.test' },
  ]) as never);

  // Every row carries the SAME keys (PostgREST bulk-insert rule): missing keys
  // in a mixed batch become null, not the column default.
  // sku is unique NULLS NOT DISTINCT per business, so every fixture needs one.
  const product = (pid: string, name: string, extra: Record<string, unknown> = {}) => ({
    id: pid, business_id: BIZ, name, sku: `W6A-${pid.slice(-4)}`, default_unit: 'g', stock_unit: 'gram',
    default_cost_per_gram_cents: 5, low_stock_threshold_grams: 0, is_active: true,
    pack_size: null as number | null, supplier_id: null as string | null,
    minimum_order_quantity: 1, order_multiple: 1, dead_stock_days: null as number | null,
    ...extra,
  });
  await must('products', admin.schema('inventory').from('products').upsert([
    product(P_A, 'W6A Colour A', { pack_size: 100, supplier_id: SUP_A, minimum_order_quantity: 6, order_multiple: 6 }),
    product(P_B, 'W6A Colour B', { pack_size: 100, supplier_id: SUP_B }),
    product(P_UNIT, 'W6A Comb', { default_unit: 'unit', stock_unit: 'unit', default_cost_per_gram_cents: 0 }),
    product(P_GATED, 'W6A Gated Colour'),
    product(D_BASIC, 'W6A Dusty Toner'),
    product(D_RESTOCKED, 'W6A Restocked Dust'),
    product(D_FRESH, 'W6A Fresh Mover'),
    product(D_ZERO, 'W6A Sold Out'),
    product(D_OVER60, 'W6A Patient', { dead_stock_days: 60 }),
    product(D_OVER20, 'W6A Impatient', { dead_stock_days: 20 }),
    product(D_NEVER, 'W6A Never Touched'),
    product(D_ARCHIVED, 'W6A Archived Relic', { is_active: false }),
    product(D_ONLYRESTOCK, 'W6A Only Restocked'),
  ]) as never);

  const shelf = (pid: string, qty: number, createdDaysAgo = 300, locationId = L1) => ({
    business_id: BIZ, location_id: locationId, product_id: pid,
    quantity_on_hand_grams: qty, created_at: daysAgo(createdDaysAgo),
  });
  await must('location_stock', admin.schema('inventory').from('location_stock').upsert([
    shelf(P_A, 1000), shelf(P_B, 1000), shelf(P_UNIT, 20), shelf(P_GATED, 500),
    shelf(D_BASIC, 500), shelf(D_RESTOCKED, 500), shelf(D_FRESH, 500), shelf(D_ZERO, 0),
    shelf(D_OVER60, 500), shelf(D_OVER20, 500), shelf(D_NEVER, 500, 200),
    shelf(D_ARCHIVED, 500), shelf(D_ONLYRESTOCK, 500),
  ], { onConflict: 'location_id,product_id' }) as never);

  const move = (pid: string, type: string, delta: number, ago: number) => ({
    business_id: BIZ, location_id: L1, product_id: pid, movement_type: type,
    quantity_delta_grams: delta, reason: 'w6-acceptance', created_at: daysAgo(ago),
  });
  await must('movements', admin.schema('inventory').from('stock_movements').insert([
    move(D_BASIC, 'restock', 600, 300), move(D_BASIC, 'formula_usage', -100, 40),
    move(D_RESTOCKED, 'restock', 400, 300), move(D_RESTOCKED, 'formula_usage', -100, 40), move(D_RESTOCKED, 'restock', 200, 5),
    move(D_FRESH, 'formula_usage', -100, 100), move(D_FRESH, 'retail_sale', -50, 3),
    move(D_ZERO, 'retail_sale', -500, 40),
    move(D_OVER60, 'formula_usage', -100, 45),
    move(D_OVER20, 'formula_usage', -100, 25),
    move(D_ARCHIVED, 'formula_usage', -100, 250),
    move(D_ONLYRESTOCK, 'restock', 500, 50),
    // reorder usage for P_A: 400g outbound inside 28 days, plus noise outside
    move(P_A, 'formula_usage', -250, 9), move(P_A, 'retail_sale', -150, 2),
    move(P_A, 'formula_usage', -500, 60), move(P_A, 'restock', 1000, 10),
  ]) as never);

  // Colour prep fixtures: tagged + untagged categories, services, appointments.
  await must('service_categories', admin.schema('booking').from('service_categories').upsert([
    { id: CAT_COLOUR, business_id: BIZ, name: 'W6A Colour Work', billing_category: 'permanent_colour' },
    { id: CAT_PLAIN, business_id: BIZ, name: 'W6A Cutting', billing_category: null },
    { id: RIVAL_CAT, business_id: RIVAL, name: 'W6A Rival Colour', billing_category: 'permanent_colour' },
  ]) as never);
  await must('services', admin.schema('booking').from('services').upsert([
    { id: SVC_COLOUR, business_id: BIZ, slug: 'w6a-full-colour', name: 'W6A Full Colour', estimated_duration_minutes: 90, service_category_id: CAT_COLOUR },
    { id: SVC_PLAIN, business_id: BIZ, slug: 'w6a-dry-cut', name: 'W6A Dry Cut', estimated_duration_minutes: 45, service_category_id: CAT_PLAIN },
    { id: RIVAL_SVC, business_id: RIVAL, slug: 'w6a-rival-colour', name: 'W6A Rival Colour', estimated_duration_minutes: 90, service_category_id: RIVAL_CAT },
  ]) as never);
  const appt = (aid: string, clientId: string, start: string, locationId = L1, businessId = BIZ) => {
    const end = new Date(new Date(start).getTime() + 90 * 60_000).toISOString();
    return {
      id: aid, business_id: businessId, location_id: locationId, client_profile_id: clientId,
      status: 'pending', scheduled_start_at: start, scheduled_end_at: end,
      // tstzmultirange snapshot the double-booking guard keys on (0050).
      occupied_ranges: `{["${start}","${end}")}`,
    };
  };
  await must('appointments', admin.schema('booking').from('appointments').upsert([
    appt(APPT_TOMORROW, PREP_CLIENT, daysAhead(1)),
    appt(APPT_NEXTWEEK, PREP_CLIENT_NEW, daysAhead(8)),
    appt(APPT_L2, PREP_CLIENT, daysAhead(1, 14), L2),
    appt(APPT_UNTAGGED, PREP_CLIENT, daysAhead(1, 16)),
    appt(APPT_RIVAL, RIVAL_CLIENT, daysAhead(1, 11), L3, RIVAL),
  ]) as never);
  const apptService = (aid: string, serviceId: string, name: string, locationId = L1, businessId = BIZ) => ({
    business_id: businessId, location_id: locationId, appointment_id: aid, service_id: serviceId,
    sequence_no: 1, service_name_snapshot: name, duration_minutes: 90,
  });
  await must('appointment_services', admin.schema('booking').from('appointment_services').upsert([
    apptService(APPT_TOMORROW, SVC_COLOUR, 'W6A Full Colour'),
    apptService(APPT_NEXTWEEK, SVC_COLOUR, 'W6A Full Colour'),
    apptService(APPT_L2, SVC_COLOUR, 'W6A Full Colour', L2),
    apptService(APPT_UNTAGGED, SVC_PLAIN, 'W6A Dry Cut'),
    apptService(APPT_RIVAL, RIVAL_SVC, 'W6A Rival Colour', L3, RIVAL),
  ]) as never);
  console.log('Fixtures ready.');
}

// ---------------------------------------------------------------------------
// Phase A — QLAB reconciliation on the real ledger
// ---------------------------------------------------------------------------

async function phaseQlab(): Promise<void> {
  console.log('\nPhase A — QLAB -> stock reconciliation');
  const F1 = 'w6a-f1';
  const itemA = (grams: number, waste = 0) => ({ id: 'i1', productId: P_A, productName: 'W6A Colour A', capturedGrams: grams, wasteGrams: waste });
  const itemB = (grams: number) => ({ id: 'i2', productId: P_B, productName: 'W6A Colour B', capturedGrams: grams, wasteGrams: 0 });

  const save1 = await saveFormula(F1, [itemA(30), itemB(20)]);
  report('A1 normal usage: A -30g', save1.error === null && (await stockOf(L1, P_A)) === 970, save1.error?.message ?? `A=${await stockOf(L1, P_A)}`);
  report('A1 normal usage: B -20g', (await stockOf(L1, P_B)) === 980);

  await saveFormula(F1, [itemA(20), itemB(20)]);
  report('A2 correction 30->20 nets to -20g, not -50g', (await stockOf(L1, P_A)) === 980, `A=${await stockOf(L1, P_A)}`);

  await saveFormula(F1, [itemB(40)]);
  report('A3 product swap: A fully restored', (await stockOf(L1, P_A)) === 1000, `A=${await stockOf(L1, P_A)}`);
  report('A3 product swap: B consumed 40g', (await stockOf(L1, P_B)) === 960, `B=${await stockOf(L1, P_B)}`);

  await saveFormula(F1, [itemB(40)]);
  report('A4 identical re-save does not double-deduct', (await stockOf(L1, P_B)) === 960, `B=${await stockOf(L1, P_B)}`);

  await saveFormula('w6a-f2', [itemA(10, 5)]);
  report('A5 waste allowance: captured 10 + waste 5 deducts 15', (await stockOf(L1, P_A)) === 985, `A=${await stockOf(L1, P_A)}`);

  // Gate: the migration default for a pre-existing/settings-less location.
  const settings = await must('read L1 settings', admin.schema('core').from('location_settings')
    .select('stock_deduction_enabled,allow_negative_stock,waste_allowance_percent,dead_stock_days_default,reorder_usage_window_weeks,reorder_coverage_weeks')
    .eq('location_id', L1) as never) as Record<string, unknown>[];
  report('A6 migration defaults: deduction ON, negative allowed, dead 90, window 8/4',
    settings[0]?.stock_deduction_enabled === true && settings[0]?.allow_negative_stock === true
      && Number(settings[0]?.dead_stock_days_default) === 90
      && Number(settings[0]?.reorder_usage_window_weeks) === 8
      && Number(settings[0]?.reorder_coverage_weeks) === 4,
    JSON.stringify(settings[0]));

  await must('gate off', admin.schema('core').from('location_settings').update({ stock_deduction_enabled: false }).eq('location_id', L1) as never);
  await saveFormula('w6a-f3', [{ id: 'i1', productId: P_GATED, productName: 'W6A Gated Colour', capturedGrams: 50, wasteGrams: 0 }]);
  report('A7 gate OFF: save deducts nothing', (await stockOf(L1, P_GATED)) === 500, `gated=${await stockOf(L1, P_GATED)}`);
  await must('gate on', admin.schema('core').from('location_settings').update({ stock_deduction_enabled: true }).eq('location_id', L1) as never);
  await saveFormula('w6a-f4', [{ id: 'i1', productId: P_GATED, productName: 'W6A Gated Colour', capturedGrams: 50, wasteGrams: 0 }]);
  report('A8 gate ON again: save deducts', (await stockOf(L1, P_GATED)) === 450, `gated=${await stockOf(L1, P_GATED)}`);

  // Idempotent consumption through the authoritative RPC (the barcode path).
  const consume = () => admin.schema('inventory').rpc('adjust_location_stock', {
    p_payload: { businessId: BIZ, locationId: L1, productId: P_UNIT, quantityDeltaGrams: -2, movementType: 'salon_consumption', reason: 'w6-acceptance', idempotencyKey: 'w6a-scan-1' },
  });
  const first = await consume();
  const second = await consume();
  const secondBody = (second.data ?? {}) as { idempotentReplay?: boolean };
  report('A9 idempotency key: retried scan replays instead of double-deducting',
    first.error === null && second.error === null && secondBody.idempotentReplay === true && (await stockOf(L1, P_UNIT)) === 18,
    `unit=${await stockOf(L1, P_UNIT)} replay=${String(secondBody.idempotentReplay)}`);

  // Negative stock policy.
  await must('forbid negative', admin.schema('core').from('location_settings').update({ allow_negative_stock: false }).eq('location_id', L1) as never);
  const refused = await admin.schema('inventory').rpc('adjust_location_stock', {
    p_payload: { businessId: BIZ, locationId: L1, productId: P_UNIT, quantityDeltaGrams: -500, movementType: 'salon_consumption', reason: 'w6-acceptance' },
  });
  report('A10 negative stock refused when the location forbids it',
    refused.error !== null && /insufficient/i.test(refused.error?.message ?? '') && (await stockOf(L1, P_UNIT)) === 18,
    refused.error?.message ?? 'no error raised');
  await must('allow negative', admin.schema('core').from('location_settings').update({ allow_negative_stock: true }).eq('location_id', L1) as never);

  // Environment-wide honesty check: has ANY real location been switched off?
  const gatedOff = await must('count gate-off rows', admin.schema('core').from('location_settings')
    .select('location_id').eq('stock_deduction_enabled', false) as never) as unknown[];
  report('A11 no location in this environment silently lost deduction', gatedOff.length === 0, `${gatedOff.length} rows have deduction disabled`);
}

// ---------------------------------------------------------------------------
// Phase B — dead stock on the real ledger
// ---------------------------------------------------------------------------

async function deadReport(locations: string[] = [L1]) {
  const rows = await must('dead_stock_report', admin.schema('inventory').rpc('dead_stock_report', {
    p_business_id: BIZ, p_location_ids: locations,
  }) as never) as { product_id: string; location_id: string; days_idle: number; threshold_days: number; threshold_source: string; last_outbound_at: string | null }[];
  return rows;
}

async function phaseDeadStock(): Promise<void> {
  console.log('\nPhase B — dead stock report');
  await must('L1 default 30', admin.schema('core').from('location_settings').update({ dead_stock_days_default: 30 }).eq('location_id', L1) as never);

  const rows = await deadReport();
  const by = (pid: string) => rows.find((row) => row.product_id === pid);

  const basic = by(D_BASIC);
  report('B1 40 idle days vs 30-day default is dead (location_default)',
    !!basic && basic.days_idle >= 39 && basic.days_idle <= 41 && basic.threshold_source === 'location_default', JSON.stringify(basic));
  report('B2 a restock 5 days ago does NOT reset the idle clock', !!by(D_RESTOCKED));
  report('B3 an outbound 3 days ago keeps a product alive', !by(D_FRESH));
  report('B4 zero on hand is out of stock, not dead stock', !by(D_ZERO));
  report('B5 a 60-day product override keeps 45 idle days alive', !by(D_OVER60));
  const over = by(D_OVER20);
  report('B6 a 20-day product override fires and says so', !!over && over.threshold_days === 20 && over.threshold_source === 'product', JSON.stringify(over));
  const never = by(D_NEVER);
  report('B7 never-moved stock anchors to the shelf record, "never used"',
    !!never && never.last_outbound_at === null && never.days_idle >= 199 && never.days_idle <= 201, JSON.stringify(never));
  const onlyRestock = by(D_ONLYRESTOCK);
  report('B8 only-restocked anchors to its first movement (50d), not the shelf age',
    !!onlyRestock && onlyRestock.last_outbound_at === null && onlyRestock.days_idle >= 49 && onlyRestock.days_idle <= 51, JSON.stringify(onlyRestock));
  report('B9 archived products are excluded', !by(D_ARCHIVED));

  await must('L1 default 400', admin.schema('core').from('location_settings').update({ dead_stock_days_default: 400 }).eq('location_id', L1) as never);
  const relaxed = await deadReport();
  report('B10 raising the threshold reclassifies on read (nothing materialised)',
    !relaxed.find((row) => row.product_id === D_BASIC) && !!relaxed.find((row) => row.product_id === D_OVER20),
    `rows=${relaxed.length}`);
  await must('L1 default 30 back', admin.schema('core').from('location_settings').update({ dead_stock_days_default: 30 }).eq('location_id', L1) as never);
}

// ---------------------------------------------------------------------------
// Phase C — purchase orders: numbering, retry safety, 0095 semantics
// ---------------------------------------------------------------------------

async function createOrder(supplierId: string) {
  const { data, error } = await admin.schema('inventory').rpc('create_purchase_order', {
    p_order: { business_id: BIZ, location_id: L1, supplier_id: supplierId, subtotal_cents: 3000 },
    p_lines: [{ product_id: P_A, product_name: 'W6A Colour A', pack_size: 100, stock_unit: 'gram', suggested_quantity: 6, ordered_quantity: 6, unit_cost_cents: 500, line_total_cents: 3000 }],
  });
  if (error) throw new Error(`create_purchase_order: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { id: string; order_number: string; created: boolean };
  return row;
}

async function phaseOrders(): Promise<{ zeroNinetyFiveApplied: boolean }> {
  console.log('\nPhase C — purchase orders');
  const first = await createOrder(SUP_A);
  report('C1 first order created with a PO number', first.created === true && /^PO-\d{5}$/.test(first.order_number), JSON.stringify(first));

  const retry = await createOrder(SUP_A);
  report('C2 retried generate returns the SAME order, no duplicate', retry.created === false && retry.id === first.id, JSON.stringify(retry));

  const second = await createOrder(SUP_B);
  report('C3 second supplier gets the next gapless number',
    second.created === true && second.order_number !== first.order_number, JSON.stringify(second));

  const lines = await must('read lines', admin.schema('inventory').from('purchase_order_lines')
    .select('product_name_snapshot,pack_size_snapshot,stock_unit_snapshot,ordered_quantity,line_total_cents')
    .eq('purchase_order_id', first.id) as never) as Record<string, unknown>[];
  report('C4 line snapshots frozen (name, pack, unit, totals)',
    lines.length === 1 && lines[0].product_name_snapshot === 'W6A Colour A' && Number(lines[0].pack_size_snapshot) === 100
      && lines[0].stock_unit_snapshot === 'gram' && Number(lines[0].line_total_cents) === 3000, JSON.stringify(lines[0]));

  // 0095 semantics: approve the first order; a fresh generate must STILL be blocked.
  await must('approve first', admin.schema('inventory').from('purchase_orders')
    .update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', first.id) as never);
  const afterApprove = await createOrder(SUP_A);
  const zeroNinetyFiveApplied = afterApprove.created === false;
  report('C5 [0095] approved-but-unsent order still blocks a duplicate generate',
    zeroNinetyFiveApplied, zeroNinetyFiveApplied ? '' : '0095 NOT applied to this database — approved orders can be duplicated');
  if (!zeroNinetyFiveApplied) {
    await must('cleanup dup', admin.schema('inventory').from('purchase_orders').delete().eq('id', afterApprove.id) as never);
  }

  await must('cancel first', admin.schema('inventory').from('purchase_orders')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', first.id) as never);
  const afterCancel = await createOrder(SUP_A);
  report('C6 cancelling frees the slot for a fresh order', afterCancel.created === true, JSON.stringify(afterCancel));

  const usage = await must('reorder_usage', admin.schema('inventory').rpc('reorder_usage', {
    p_business_id: BIZ, p_location_id: L1, p_from: daysAgo(28),
  }) as never) as { product_id: string; outbound_base: number | string }[];
  // Expected outbound on P_A inside 28 days: seeded -250 and -150, plus Phase
  // A's formula movements today (-30 first save, -20 corrected save, -10
  // captured, -5 waste) = 465. Reversals are positive and must not count;
  // the -500 sixty days ago and the +1000 restock must not count.
  const pa = usage.find((row) => row.product_id === P_A);
  report('C7 reorder usage: outbound-only inside the window (excludes restocks, reversals, old rows)',
    !!pa && Number(pa.outbound_base) === 465,
    `outbound=${pa?.outbound_base}`);

  const levels = await must('security levels', admin.schema('core').from('security_levels')
    .select('key,permissions').eq('is_system', true).in('key', ['owner', 'group_admin', 'manager']) as never) as { key: string; permissions: string[] }[];
  const managers = levels.filter((level) => level.key === 'manager');
  const admins = levels.filter((level) => level.key !== 'manager');
  report('C8 permission seeds: manager prepares (view+manage), never approves; owner/group_admin approve',
    managers.length > 0 && managers.every((m) => m.permissions.includes('orders.view') && m.permissions.includes('orders.manage') && !m.permissions.includes('orders.approve'))
      && admins.length > 0 && admins.every((a) => a.permissions.includes('orders.approve')),
    `managers=${managers.length} admins=${admins.length}`);
  return { zeroNinetyFiveApplied };
}

// ---------------------------------------------------------------------------
// Phase D — colour prep joins on real data
// ---------------------------------------------------------------------------

async function phaseColourPrep(): Promise<void> {
  console.log('\nPhase D — colour prep pipeline (real joins)');

  // A saved formula for the regular client, including one deliberately
  // unmapped line so "missing data" paths are present in real rows.
  const { error: prepFormulaError } = await admin.schema('lab').rpc('save_formula_with_reconciliation', {
    p_payload: {
      formulaId: 'w6a-prep-f1', businessId: BIZ, locationId: L1, clientProfileId: PREP_CLIENT,
      items: [
        { id: 'i1', productId: P_B, productName: 'W6A Colour B', capturedGrams: 40, wasteGrams: 0 },
        { id: 'i2', productName: 'W6A Mystery Toner', capturedGrams: 15, wasteGrams: 0 },
      ],
    },
  });
  report('D1 prep formula saved (with an unmapped line)', prepFormulaError === null, prepFormulaError?.message);

  // The exact selection colour prep makes: tomorrow's window at L1.
  const from = daysAhead(1, 0);
  const to = daysAhead(2, 0);
  const appts = await must('appointments window', admin.schema('booking').from('appointments')
    .select('id,location_id,client_profile_id,status')
    .eq('business_id', BIZ).gte('scheduled_start_at', from).lt('scheduled_start_at', to)
    .in('status', ['pending', 'accepted', 'checked_in']).eq('location_id', L1) as never) as { id: string }[];
  const ids = appts.map((a) => a.id);
  report('D2 window+location selection finds tomorrow\'s L1 appointments only',
    ids.includes(APPT_TOMORROW) && ids.includes(APPT_UNTAGGED) && !ids.includes(APPT_L2) && !ids.includes(APPT_RIVAL) && !ids.includes(APPT_NEXTWEEK),
    JSON.stringify(ids));

  const services = await must('services join', admin.schema('booking').from('appointment_services')
    .select('appointment_id,service_id').in('appointment_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']) as never) as { appointment_id: string; service_id: string }[];
  const serviceRows = await must('service categories', admin.schema('booking').from('services')
    .select('id,service_category_id').in('id', services.map((s) => s.service_id)) as never) as { id: string; service_category_id: string | null }[];
  const categoryRows = await must('billing tags', admin.schema('booking').from('service_categories')
    .select('id,billing_category').in('id', serviceRows.map((s) => s.service_category_id).filter(Boolean) as string[]) as never) as { id: string; billing_category: string | null }[];
  const colourCategoryIds = new Set(categoryRows.filter((c) => c.billing_category !== null).map((c) => c.id));
  const colourServiceIds = new Set(serviceRows.filter((s) => s.service_category_id && colourCategoryIds.has(s.service_category_id)).map((s) => s.id));
  const colourAppointments = new Set(services.filter((s) => colourServiceIds.has(s.service_id)).map((s) => s.appointment_id));
  report('D3 billing tag decides colour work: tagged in, untagged out',
    colourAppointments.has(APPT_TOMORROW) && !colourAppointments.has(APPT_UNTAGGED), JSON.stringify([...colourAppointments]));

  const formulas = await must('latest formula', admin.schema('lab').from('formulas')
    .select('id,client_profile_id,status').eq('business_id', BIZ).eq('client_profile_id', PREP_CLIENT).eq('status', 'saved')
    .order('saved_at', { ascending: false }).limit(1) as never) as { id: string }[];
  report('D4 latest saved formula resolves for the regular client', formulas.length === 1);

  const newClientFormulas = await must('no formula', admin.schema('lab').from('formulas')
    .select('id').eq('business_id', BIZ).eq('client_profile_id', PREP_CLIENT_NEW).eq('status', 'saved') as never) as unknown[];
  report('D5 the first-time client really has no formula (prep must flag, not drop)', newClientFormulas.length === 0);

  const items = await must('formula items', admin.schema('lab').from('formula_items')
    .select('product_id,product_name,captured_grams').eq('formula_id', (formulas[0] as { id: string }).id) as never) as { product_id: string | null; product_name: string }[];
  report('D6 the unmapped line survives with no product link (never renders as "enough stock")',
    items.some((item) => item.product_id === null && item.product_name === 'W6A Mystery Toner'), JSON.stringify(items));

  const waste = await must('waste allowance', admin.schema('core').from('location_settings')
    .select('waste_allowance_percent').eq('location_id', L1) as never) as { waste_allowance_percent: number | string | null }[];
  report('D7 waste allowance available to the prep uplift (default 10)', Number(waste[0]?.waste_allowance_percent ?? 10) === 10, JSON.stringify(waste[0]));

  // Category tagging write-path rules on the real DB.
  const badTag = await admin.schema('booking').from('service_categories')
    .update({ billing_category: 'sparkles' }).eq('id', CAT_PLAIN);
  report('D8 an invalid billing_category value is rejected by the enum', badTag.error !== null, badTag.error?.message ?? 'accepted!');
  const clearTag = await admin.schema('booking').from('service_categories')
    .update({ billing_category: null }).eq('id', CAT_COLOUR).select('billing_category');
  const retag = await admin.schema('booking').from('service_categories')
    .update({ billing_category: 'permanent_colour' }).eq('id', CAT_COLOUR).select('billing_category');
  report('D9 tag can be cleared and re-set (recomputes on read; nothing cached)',
    clearTag.error === null && retag.error === null, clearTag.error?.message ?? retag.error?.message);
}

// ---------------------------------------------------------------------------
// Phase E — retail pricing (0096): constraints, Luke's §43 chain, immutability
// ---------------------------------------------------------------------------

const PRICE_PRODUCT = id('31');
const PRICE_CATEGORY = id('91');

async function phasePricing(): Promise<void> {
  console.log('\nPhase E — retail pricing (classification CR, 0096)');

  const probe = await admin.schema('inventory').from('retail_pricing_rules').select('id').limit(1);
  if (probe.error) {
    report('E0 [0096] retail_pricing_rules exists', false, '0096 NOT applied to this database — apply it, then re-run');
    return;
  }
  report('E0 [0096] retail_pricing_rules exists', true);

  // Fixtures: a £10-cost retail product (10c/g × 100g pack) with a legacy
  // retail price of £14.99, in a category, stocked at L1.
  await must('pricing category', admin.schema('inventory').from('categories').upsert([
    { id: PRICE_CATEGORY, business_id: BIZ, name: 'W6A Pricing Category', is_active: true },
  ]) as never);
  await must('pricing product', admin.schema('inventory').from('products').upsert([{
    id: PRICE_PRODUCT, business_id: BIZ, name: 'W6A Priced Serum', sku: 'W6A-PRICE',
    default_unit: 'g', stock_unit: 'gram', pack_size: 100, size_value: 100,
    default_cost_per_gram_cents: 10, retail_price_cents: 1499,
    low_stock_threshold_grams: 0, is_active: true, is_retail: true,
    category_id: PRICE_CATEGORY,
  }]) as never);
  await must('pricing stock', admin.schema('inventory').from('location_stock').upsert([
    { business_id: BIZ, location_id: L1, product_id: PRICE_PRODUCT, quantity_on_hand_grams: 1000, is_active: true },
  ], { onConflict: 'location_id,product_id' }) as never);

  // E1/E2/E3: the money constraints hold on the real table.
  const badPair = await admin.schema('inventory').from('retail_pricing_rules').insert({
    business_id: BIZ, scope: 'product', product_id: PRICE_PRODUCT,
    pricing_mode: 'percentage_markup', fixed_price_cents: 1800,
  });
  report('E1 mode/value pairing enforced (percentage with a fixed price rejected)', badPair.error !== null, badPair.error?.message ?? 'accepted!');

  const badShape = await admin.schema('inventory').from('retail_pricing_rules').insert({
    business_id: BIZ, scope: 'product', product_id: PRICE_PRODUCT, location_id: L1,
    pricing_mode: 'percentage_markup', markup_percent: 10,
  });
  report('E2 scope shape enforced (product rule with a stray location rejected)', badShape.error !== null, badShape.error?.message ?? 'accepted!');

  const rule = (scope: RetailPricingScope, mode: 'percentage_markup' | 'fixed_price', value: number, locationId?: string) => ({
    business_id: BIZ,
    scope,
    product_id: scope === 'location_product' || scope === 'product' ? PRICE_PRODUCT : null,
    category_id: scope === 'location_category' || scope === 'category' ? PRICE_CATEGORY : null,
    location_id: scope === 'location_product' || scope === 'location_category' || scope === 'location' ? (locationId ?? L1) : null,
    pricing_mode: mode,
    markup_percent: mode === 'percentage_markup' ? value : null,
    fixed_price_cents: mode === 'fixed_price' ? value : null,
  });

  await must('seed product rule', admin.schema('inventory').from('retail_pricing_rules').insert(rule('product', 'percentage_markup', 30)) as never);
  const dupe = await admin.schema('inventory').from('retail_pricing_rules').insert(rule('product', 'percentage_markup', 40));
  report('E3 one rule per level per target (duplicate product rule rejected)', dupe.error !== null, dupe.error?.message ?? 'accepted!');

  const zero = await admin.schema('inventory').from('retail_pricing_rules').insert(rule('location', 'percentage_markup', 0));
  report('E4 explicit 0% is storable — 0 is configuration, not absence', zero.error === null, zero.error?.message);
  await must('clear zero', admin.schema('inventory').from('retail_pricing_rules').delete()
    .eq('business_id', BIZ).eq('scope', 'location') as never);

  // §43 — Luke's exact UAT chain, against REAL rows, resolved by the one
  // canonical resolver the API uses. Cost £10, legacy £14.99.
  const resolveNow = async (): Promise<{ price: number | null; source: string }> => {
    const rows = await must('read rules', admin.schema('inventory').from('retail_pricing_rules')
      .select('id,scope,product_id,category_id,location_id,pricing_mode,markup_percent,fixed_price_cents')
      .eq('business_id', BIZ) as never) as {
      id: string; scope: RetailPricingScope; product_id: string | null; category_id: string | null;
      location_id: string | null; pricing_mode: 'percentage_markup' | 'fixed_price';
      markup_percent: number | string | null; fixed_price_cents: number | null;
    }[];
    const candidates: RetailPricingCandidates = {};
    for (const row of rows) {
      const belongs =
        (row.scope === 'location_product' && row.product_id === PRICE_PRODUCT && row.location_id === L1) ||
        (row.scope === 'product' && row.product_id === PRICE_PRODUCT) ||
        (row.scope === 'location_category' && row.category_id === PRICE_CATEGORY && row.location_id === L1) ||
        (row.scope === 'category' && row.category_id === PRICE_CATEGORY) ||
        (row.scope === 'location' && row.location_id === L1);
      if (!belongs) continue;
      candidates[row.scope] = {
        id: row.id,
        pricingMode: row.pricing_mode,
        markupPercent: row.markup_percent === null ? undefined : Number(row.markup_percent),
        fixedPriceCents: row.fixed_price_cents ?? undefined,
      };
    }
    const resolved = resolveRetailPricing({
      productId: PRICE_PRODUCT, locationId: L1, unitCostCents: 1000,
      legacyRetailPriceCents: 1499, candidates,
    });
    return { price: resolved.sellingPriceCents, source: resolved.source };
  };
  const clearScope = (scope: RetailPricingScope) =>
    admin.schema('inventory').from('retail_pricing_rules').delete().eq('business_id', BIZ).eq('scope', scope);

  await must('LD 10%', admin.schema('inventory').from('retail_pricing_rules').insert(rule('location', 'percentage_markup', 10)) as never);
  await must('CD 20%', admin.schema('inventory').from('retail_pricing_rules').insert(rule('category', 'percentage_markup', 20)) as never);
  await must('LC 25%', admin.schema('inventory').from('retail_pricing_rules').insert(rule('location_category', 'percentage_markup', 25)) as never);
  await must('LP £18', admin.schema('inventory').from('retail_pricing_rules').insert(rule('location_product', 'fixed_price', 1800)) as never);
  // (product 30% was already inserted above)

  let step = await resolveNow();
  report('E5 §43: Location A → £18, source location product', step.price === 1800 && step.source === 'location_product', JSON.stringify(step));
  await must('drop LP', clearScope('location_product') as never);
  step = await resolveNow();
  report('E6 §43: remove LP → product default 30% → £13', step.price === 1300 && step.source === 'product_default', JSON.stringify(step));
  await must('drop PD', clearScope('product') as never);
  step = await resolveNow();
  report('E7 §43: PD null → location category 25% → £12.50', step.price === 1250 && step.source === 'location_category', JSON.stringify(step));
  await must('drop LC', clearScope('location_category') as never);
  step = await resolveNow();
  report('E8 §43: LC null → category default 20% → £12', step.price === 1200 && step.source === 'category_default', JSON.stringify(step));
  await must('drop CD', clearScope('category') as never);
  step = await resolveNow();
  report('E9 §43: CD null → location default 10% → £11', step.price === 1100 && step.source === 'location_default', JSON.stringify(step));
  await must('PD 0%', admin.schema('inventory').from('retail_pricing_rules').insert(rule('product', 'percentage_markup', 0)) as never);
  step = await resolveNow();
  report('E10 §43: PD 0% → £10, stops inheritance (location default ignored)', step.price === 1000 && step.source === 'product_default', JSON.stringify(step));
  await must('drop PD 0', clearScope('product') as never);
  await must('PD fixed £17', admin.schema('inventory').from('retail_pricing_rules').insert(rule('product', 'fixed_price', 1700)) as never);
  step = await resolveNow();
  report('E11 §43: PD fixed £17 → £17, provenance product default', step.price === 1700 && step.source === 'product_default', JSON.stringify(step));

  // E12/E13 — the transaction snapshot and its immutability on the real table.
  const sale = await admin.schema('billing').rpc('record_retail_sale', {
    p_payload: {
      businessId: BIZ, locationId: L1, productId: PRICE_PRODUCT, quantity: 1,
      unitPriceCents: 1700, soldAt: new Date().toISOString(),
      pricing: {
        unitCostCents: 1000, pricingMode: 'fixed_price', pricingSource: 'product_default',
        configuredValue: 1700, effectiveMarkupPercent: 70,
      },
    },
  });
  const saleRow = (Array.isArray(sale.data) ? sale.data[0] : sale.data) as
    | { id: string; unit_price_cents: number; pricing_source: string | null; pricing_configured_value: number | string | null }
    | null;
  report('E12 record_retail_sale persists the pricing snapshot',
    sale.error === null && saleRow !== null && Number(saleRow.unit_price_cents) === 1700
      && saleRow.pricing_source === 'product_default' && Number(saleRow.pricing_configured_value) === 1700,
    sale.error?.message ?? JSON.stringify(saleRow));

  // Change every rule, then re-read the completed sale: it must be untouched.
  await must('drop PD fixed', clearScope('product') as never);
  await must('LP £99', admin.schema('inventory').from('retail_pricing_rules').insert(rule('location_product', 'fixed_price', 9900)) as never);
  const after = await must('re-read sale', admin.schema('billing').from('retail_sales')
    .select('unit_price_cents,pricing_source,pricing_configured_value')
    .eq('id', saleRow?.id ?? '00000000-0000-0000-0000-000000000000') as never) as Record<string, unknown>[];
  report('E13 completed sale unchanged after every rule changed (£17 stays £17)',
    after.length === 1 && Number(after[0].unit_price_cents) === 1700 && after[0].pricing_source === 'product_default',
    JSON.stringify(after[0] ?? null));
  await must('drop LP 99', clearScope('location_product') as never);
  await must('drop LD', clearScope('location') as never);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  console.log('\nCleaning up the a6 fixture tenant…');
  const del = async (schema: string, table: string, column: string, values: string[]) => {
    const { error } = await admin.schema(schema).from(table).delete().in(column, values);
    if (error) console.warn(`  cleanup ${schema}.${table}: ${error.message}`);
  };
  await del('billing', 'retail_sales', 'business_id', [BIZ]);
  await del('inventory', 'retail_pricing_rules', 'business_id', [BIZ]);
  await del('booking', 'appointment_services', 'business_id', [BIZ, RIVAL]);
  await del('booking', 'appointments', 'business_id', [BIZ, RIVAL]);
  await del('booking', 'services', 'business_id', [BIZ, RIVAL]);
  await del('booking', 'service_categories', 'business_id', [BIZ, RIVAL]);
  await del('inventory', 'purchase_order_lines', 'product_id', [P_A]);
  await del('inventory', 'purchase_orders', 'business_id', [BIZ]);
  await del('inventory', 'purchase_order_counters', 'business_id', [BIZ]);
  await del('inventory', 'waste_events', 'business_id', [BIZ]);
  await del('inventory', 'low_stock_alerts', 'business_id', [BIZ]);
  await del('inventory', 'stock_movements', 'business_id', [BIZ]);
  await del('lab', 'formula_items', 'formula_id',
    ((await admin.schema('lab').from('formulas').select('id').eq('business_id', BIZ)).data ?? []).map((row: { id: string }) => row.id));
  await del('lab', 'formulas', 'business_id', [BIZ]);
  await del('inventory', 'location_stock', 'business_id', [BIZ]);
  await del('inventory', 'products', 'business_id', [BIZ]);
  await del('inventory', 'categories', 'business_id', [BIZ]);
  await del('inventory', 'suppliers', 'business_id', [BIZ]);
  await del('core', 'client_profiles', 'business_id', [BIZ, RIVAL]);
  await del('core', 'location_settings', 'location_id', [L1, L2, L3]);
  await del('core', 'locations', 'business_id', [BIZ, RIVAL]);
  await del('core', 'businesses', 'id', [BIZ, RIVAL]);
  console.log('Cleanup done.');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Week 6 acceptance against ${supabaseUrl} ${keep ? '(keeping fixtures)' : ''}`);
  try {
    await setup();
    await phaseQlab();
    await phaseDeadStock();
    await phaseOrders();
    await phaseColourPrep();
    await phasePricing();
  } finally {
    if (!keep) await cleanup();
    else console.log('\n--keep: fixtures left in place for UAT.');
  }
  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if (failures.length) {
    for (const failure of failures) console.log(`  FAILED: ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
