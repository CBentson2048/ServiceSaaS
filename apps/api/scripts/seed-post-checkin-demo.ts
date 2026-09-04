/**
 * Idempotent demo seed for the post-check-in service lifecycle (0110).
 *
 * Builds exactly the starting state Luke's walkthrough needs, so the demo is
 * reproducible rather than dependent on whatever is in the diary that morning:
 *
 *   Client "Jane Test", checked in, with TWO BOOKED services
 *       DEMO-PC-COLOUR  Full Head Colour  £95
 *       DEMO-PC-CUT     Cut & Finish      £45
 *   and two more services in the catalogue, NOT on the appointment, for the
 *   consultation to add:
 *       DEMO-PC-TONER   Toner             £35
 *       DEMO-PC-TREAT   Olaplex Treatment £25
 *
 * The seed stops at check-in ON PURPOSE. Every subsequent step of the demo —
 * remove Cut & Finish, add Toner, add Treatment to a second stylist, check out,
 * pay, then fail to edit — is performed live through the real UI and the real
 * canonical mutation, because that is the thing under demonstration. Nothing
 * here writes a service change, a bill or a history row.
 *
 * Both stylists are made eligible for all four services: eligibility is a hard
 * block on adding a service (the same one the booking flow applies), so without
 * it the demo's "add Toner" would correctly 409.
 *
 * Re-running rebuilds the same scenario: the catalogue and client upsert on
 * their natural keys, and the demo appointment is deleted and re-created for
 * today so it is always in the book you are looking at.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-post-checkin-demo -- --business <id> --location <id>
 *     [--stylist <staffProfileId>] [--second-stylist <staffProfileId>]
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
const stylistArg = arg('stylist');
const secondStylistArg = arg('second-stylist');

if (!businessId || !locationId) {
  console.error(
    'Usage: seed-post-checkin-demo -- --business <id> --location <id> [--stylist <id>] [--second-stylist <id>]',
  );
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

/** The two booked lines, then the two the consultation adds. */
const SERVICES = [
  { slug: 'demo-pc-colour', name: 'Full Head Colour', minutes: 120, price: 95, booked: true },
  { slug: 'demo-pc-cut', name: 'Cut & Finish', minutes: 45, price: 45, booked: true },
  { slug: 'demo-pc-toner', name: 'Toner', minutes: 30, price: 35, booked: false },
  { slug: 'demo-pc-treatment', name: 'Olaplex Treatment', minutes: 20, price: 25, booked: false },
] as const;

interface StaffRow {
  id: string;
  display_name: string | null;
  is_bookable: boolean | null;
}

async function resolveStylists(): Promise<StaffRow[]> {
  const { data, error } = await admin
    .schema('core')
    .from('staff_profiles')
    .select('id,display_name,is_bookable')
    .eq('business_id', businessId)
    .order('created_at', { ascending: true })
    .returns<StaffRow[]>();
  if (error) throw new Error(`staff_profiles: ${error.message}`);

  const all = data ?? [];
  const byId = new Map(all.map((row) => [row.id, row]));
  const chosen: StaffRow[] = [];
  for (const requested of [stylistArg, secondStylistArg]) {
    if (!requested) continue;
    const row = byId.get(requested);
    if (!row) throw new Error(`staff profile ${requested} is not in this business`);
    chosen.push(row);
  }
  // Fill any remaining slot from the bookable staff, skipping ones already picked.
  for (const row of all.filter((candidate) => candidate.is_bookable !== false)) {
    if (chosen.length >= 2) break;
    if (chosen.some((picked) => picked.id === row.id)) continue;
    chosen.push(row);
  }
  if (chosen.length === 0) {
    throw new Error('No staff profiles found for this business — the demo needs at least one stylist.');
  }
  return chosen;
}

async function main(): Promise<void> {
  console.log(`Seeding post-check-in demo for business ${businessId} / location ${locationId}`);

  const stylists = await resolveStylists();
  const primary = stylists[0];
  const second = stylists[1];
  console.log(`  stylist        ${primary.display_name ?? primary.id}`);
  console.log(
    second
      ? `  second stylist ${second.display_name ?? second.id} (for the attribution step)`
      : '  second stylist none found — the attribution step will use one stylist',
  );

  // 1. Category.
  const { data: category, error: categoryError } = await admin
    .schema('booking')
    .from('service_categories')
    .upsert(
      { business_id: businessId, name: 'Demo Visit', is_active: true },
      { onConflict: 'business_id,name' },
    )
    .select('id')
    .single<{ id: string }>();
  if (categoryError) throw new Error(`service_categories: ${categoryError.message}`);

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
    console.log(`  service ${service.name.padEnd(18)} £${service.price}`);
  }

  // 3. Eligibility — a hard block on adding a service, so both stylists get all four.
  const eligibility = stylists.flatMap((stylist) =>
    Array.from(serviceIdBySlug.values()).map((serviceId) => ({
      business_id: businessId,
      service_id: serviceId,
      staff_profile_id: stylist.id,
    })),
  );
  const { error: eligibilityError } = await admin
    .schema('booking')
    .from('staff_service_eligibility')
    .upsert(eligibility, { onConflict: 'service_id,staff_profile_id' });
  if (eligibilityError) throw new Error(`staff_service_eligibility: ${eligibilityError.message}`);
  console.log(`  eligibility ${eligibility.length} row(s) — every demo stylist can perform every demo service`);

  // 4. The client.
  const { data: client, error: clientError } = await admin
    .schema('core')
    .from('client_profiles')
    .upsert(
      {
        business_id: businessId,
        primary_location_id: locationId,
        first_name: 'Jane',
        last_name: 'Test',
        external_ref: 'demo-post-checkin-client',
      },
      { onConflict: 'business_id,external_ref' },
    )
    .select('id')
    .single<{ id: string }>();
  if (clientError) throw new Error(`client_profiles: ${clientError.message}`);
  console.log(`  client Jane Test ${client.id}`);

  // 5. Clear any previous run, so re-seeding never leaves two Jane Tests in the book.
  const { data: existing, error: existingError } = await admin
    .schema('booking')
    .from('appointments')
    .select('id')
    .eq('business_id', businessId)
    .eq('client_profile_id', client.id)
    .contains('metadata', { demoSeed: 'post-checkin' })
    .returns<{ id: string }[]>();
  if (existingError) throw new Error(`appointments read: ${existingError.message}`);
  if ((existing ?? []).length > 0) {
    const { error } = await admin
      .schema('booking')
      .from('appointments')
      .delete()
      .in('id', existing.map((row) => row.id));
    if (error) {
      throw new Error(
        `appointments cleanup: ${error.message}. A PAID demo appointment is immutable by design — ` +
          'archive it by hand or seed against a fresh client.',
      );
    }
    console.log(`  cleared ${existing.length} previous demo appointment(s)`);
  }

  // 6. The appointment: today, CHECKED IN, with the two booked lines.
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const booked = SERVICES.filter((service) => service.booked);
  const totalMinutes = booked.reduce((sum, service) => sum + service.minutes, 0);
  const end = new Date(start.getTime() + totalMinutes * 60 * 1000);

  const { data: appointment, error: appointmentError } = await admin
    .schema('booking')
    .from('appointments')
    .insert({
      business_id: businessId,
      location_id: locationId,
      client_profile_id: client.id,
      assigned_staff_profile_id: primary.id,
      // Created as 'accepted', then checked in AFTER its lines exist — the real
      // sequence, and the one that lets the T0 snapshot trigger fire (0110 only
      // captures an original booking for an appointment that has not yet
      // arrived, so a line added later can never be mislabelled "original").
      status: 'accepted',
      scheduled_start_at: start.toISOString(),
      scheduled_end_at: end.toISOString(),
      occupied_ranges: `{[${start.toISOString()},${end.toISOString()})}`,
      metadata: { demoSeed: 'post-checkin' },
    })
    .select('id')
    .single<{ id: string }>();
  if (appointmentError) throw new Error(`appointments insert: ${appointmentError.message}`);

  // Booked lines carry their diary window; `origin` defaults to 'booked' (0110).
  let cursor = start.getTime();
  const lines = booked.map((service, index) => {
    const lineStart = new Date(cursor);
    cursor += service.minutes * 60 * 1000;
    return {
      business_id: businessId,
      location_id: locationId,
      appointment_id: appointment.id,
      service_id: serviceIdBySlug.get(service.slug)!,
      assigned_staff_profile_id: primary.id,
      sequence_no: index + 1,
      service_name_snapshot: service.name,
      duration_minutes: service.minutes,
      price_amount: service.price,
      deposit_required_amount: 0,
      status: 'scheduled',
      scheduled_start_at: lineStart.toISOString(),
      scheduled_end_at: new Date(cursor).toISOString(),
    };
  });
  const { error: linesError } = await admin
    .schema('booking')
    .from('appointment_services')
    .insert(lines);
  if (linesError) throw new Error(`appointment_services: ${linesError.message}`);

  // Now arrive. The T0 snapshot is already written and is immutable from here on.
  const { error: checkInError } = await admin
    .schema('booking')
    .from('appointments')
    .update({ status: 'checked_in', check_in_at: new Date().toISOString() })
    .eq('id', appointment.id);
  if (checkInError) throw new Error(`check-in: ${checkInError.message}`);

  const bookedTotal = booked.reduce((sum, service) => sum + service.price, 0);
  console.log(`  appointment ${appointment.id}`);
  console.log(`  checked in at ${start.toISOString()} — booked £${bookedTotal} (Full Head Colour + Cut & Finish)`);
  console.log('');
  console.log('WALKTHROUGH (all live, through the real UI):');
  console.log('  1. Open the book, click Jane Test — "Services on this visit" shows the two BOOKED lines.');
  console.log('  2. Remove Cut & Finish        -> stays on the record, struck through, "Booked, not performed".');
  console.log('  3. Add Toner                  -> badge "Added during visit", total moves £140 -> £130.');
  console.log(
    second
      ? '  4. Add Olaplex Treatment, then reassign it to the second stylist -> £155, their revenue.'
      : '  4. Add Olaplex Treatment      -> £155.',
  );
  console.log('  5. "Show change history"      -> who did what, when, at what price.');
  console.log('  6. Complete + check out       -> the bill IS the performed set; each added line is marked.');
  console.log('  7. Take payment, then try to change a service -> refused: paid services are final.');
  console.log('  8. The history and the booked baseline are still readable after payment.');
  console.log('');
  console.log('ORIGINAL vs BOOKED vs PERFORMED, as structured data:');
  console.log(`  select original_services_snapshot from booking.appointments where id = '${appointment.id}';`);
  console.log(`  -- T0: what the client originally booked, immutable`);
  console.log(`  select service_name_snapshot, origin, status from booking.appointment_services`);
  console.log(`   where appointment_id = '${appointment.id}' order by sequence_no;`);
  console.log(`  -- booked    = origin = 'booked'      -- performed = status <> 'cancelled'`);
  console.log(`  select action, before->>'serviceName', after->>'serviceName', created_at`);
  console.log(`    from booking.appointment_service_changes`);
  console.log(`   where appointment_id = '${appointment.id}' order by created_at, change_no;`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
