/**
 * Idempotent demo seed for the four operational intelligence signals
 * (Wrike 4507283793).
 *
 * Builds the deterministic scenario the Luke walkthrough needs, so the demo is
 * reproducible rather than dependent on whatever happens to be in the database
 * that morning. Each signal gets one client or stylist who SHOULD trigger it and,
 * where it matters, one who should NOT — because the quiet cases are the ones
 * that earn a stylist's trust.
 *
 *   Jane Falling    settled bills £90, £95, £92 then £75, £72, £78
 *                   -> spend trend FALLING (-19%)
 *   Sara Steady     six settled bills all £100
 *                   -> spend trend STEADY, proving a quiet case stays quiet
 *   Mia Misses      8 relevant appointments, 3 no-shows
 *                   -> attendance: repeat pattern (the 3-no-show override)
 *   Carl Careful    8 attended, 4 cancellations ALL made well inside notice
 *                   -> NO pattern, proving a cancellation is never a no-show
 *   Stylist Sam     10:00-11:30 colour then 11:30-13:00 colour
 *                   -> back-to-back colour warning, 0 min buffer
 *   Stylist Olivia  09:00-10:00 and 10:30-11:30 inside a 09:00-17:00 shift
 *                   -> 30-minute slot gap
 *                   PLUS a 13:00-13:30 break between two bookings, which must
 *                   NOT be reported as a gap
 *
 * Nothing here writes a signal: they are computed on read, so there is nothing
 * to seed on that side. Everything created carries a DEMO-OS marker.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-operational-signals-demo -- --business <id> --location <id>
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

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const businessId = arg('business');
const locationId = arg('location');
if (!businessId || !locationId) {
  console.error('Usage: seed-operational-signals-demo -- --business <id> --location <id>');
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

const DAY_MS = 86_400_000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

async function main(): Promise<void> {
  console.log(`Seeding operational-signal demo for ${businessId} / ${locationId}.`);

  const clients = {
    falling: await upsertClient('DEMO-OS-FALLING', 'Jane', 'Falling'),
    steady: await upsertClient('DEMO-OS-STEADY', 'Sara', 'Steady'),
    misses: await upsertClient('DEMO-OS-MISSES', 'Mia', 'Misses'),
    careful: await upsertClient('DEMO-OS-CAREFUL', 'Carl', 'Careful'),
  };
  const staff = {
    sam: await findStaff('Sam'),
    olivia: await findStaff('Olivia'),
  };
  const colourServiceId = await ensureColourService();

  for (const id of Object.values(clients)) await clearClientHistory(id);

  // --- Spend trend ---------------------------------------------------------
  await seedSpend(clients.falling, [
    [90, 180], [95, 150], [92, 120], [75, 60], [72, 30], [78, 5],
  ]);
  console.log('  Jane Falling: £92 avg -> £75 avg  => FALLING');

  await seedSpend(clients.steady, [
    [100, 180], [100, 150], [100, 120], [100, 60], [100, 30], [100, 5],
  ]);
  console.log('  Sara Steady: £100 throughout      => STEADY (the quiet case)');

  // --- Attendance ----------------------------------------------------------
  await seedAttendance(clients.misses, [
    ...repeat(5, (i) => ({ status: 'paid', daysAgo: 20 + i * 10 })),
    { status: 'no_show', daysAgo: 12 },
    { status: 'no_show', daysAgo: 40 },
    { status: 'no_show', daysAgo: 75 },
  ]);
  console.log('  Mia Misses: 3 no-shows of 8       => REPEAT PATTERN');

  await seedAttendance(clients.careful, [
    ...repeat(8, (i) => ({ status: 'paid', daysAgo: 15 + i * 10 })),
    // Cancelled 10 days BEFORE the appointment — far outside any notice window.
    ...repeat(4, (i) => ({ status: 'cancelled', daysAgo: 20 + i * 15, cancelledDaysBefore: 10 })),
  ]);
  console.log('  Carl Careful: 4 early cancellations => NO PATTERN (never a no-show)');

  // --- Diary ---------------------------------------------------------------
  if (staff.sam) {
    await seedColourPair(staff.sam, colourServiceId, clients.falling, clients.steady);
    console.log('  Stylist Sam: 10:00 + 11:30 colour => BACK-TO-BACK WARNING (0 min)');
  } else {
    console.log('  (no stylist named Sam — skipped the colour-sequencing scenario)');
  }

  if (staff.olivia) {
    await seedGapDay(staff.olivia, clients.careful);
    console.log('  Stylist Olivia: 30-min gap at 10:00, and a 13:00 break that is NOT a gap');
  } else {
    console.log('  (no stylist named Olivia — skipped the slot-gap scenario)');
  }

  console.log('');
  console.log('Open a client profile for the spend/attendance signals, and the diary for today.');
  console.log('Thresholds live at Settings -> Intelligence sensitivity.');
}

const repeat = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function upsertClient(code: string, firstName: string, lastName: string): Promise<string> {
  const { data, error } = await admin
    .schema('core')
    .from('client_profiles')
    .upsert(
      {
        business_id: businessId,
        client_code: code,
        primary_location_id: locationId,
        first_name: firstName,
        last_name: lastName,
        email: `${code.toLowerCase()}@example.com`,
        source: 'demo_seed',
      },
      { onConflict: 'business_id,client_code' },
    )
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`client ${code}: ${error.message}`);
  if (!data) throw new Error(`client ${code}: no row returned`);
  return data.id;
}

/** The demo uses whatever stylists the salon already has, matched by first name. */
async function findStaff(firstName: string): Promise<string | null> {
  const { data } = await admin
    .schema('core')
    .from('staff_profiles')
    .select('id,display_name')
    .eq('business_id', businessId)
    .ilike('display_name', `${firstName}%`)
    .limit(1)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

async function ensureColourService(): Promise<string> {
  const { data: category } = await admin
    .schema('booking')
    .from('service_categories')
    .upsert(
      { business_id: businessId, name: 'Demo Signals Colour', billing_category: 'permanent_colour' },
      { onConflict: 'business_id,name' },
    )
    .select('id')
    .maybeSingle<{ id: string }>();

  const { data, error } = await admin
    .schema('booking')
    .from('services')
    .upsert(
      {
        business_id: businessId,
        slug: 'demo-os-colour',
        name: 'Demo Signals Colour',
        service_category_id: category?.id ?? null,
        estimated_duration_minutes: 90,
        base_price: 95,
      },
      { onConflict: 'business_id,slug' },
    )
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`colour service: ${error.message}`);
  if (!data) throw new Error('colour service: no row returned');
  return data.id;
}

/** Deleting first is what makes this re-runnable: everything is anchored to now. */
async function clearClientHistory(clientId: string): Promise<void> {
  const { data: appointments } = await admin
    .schema('booking')
    .from('appointments')
    .select('id')
    .eq('client_profile_id', clientId)
    .returns<Array<{ id: string }>>();
  const ids = (appointments ?? []).map((a) => a.id);
  if (ids.length > 0) {
    await admin.schema('billing').from('bills').delete().in('appointment_id', ids);
  }
  await admin.schema('billing').from('bills').delete().eq('client_profile_id', clientId);
  await admin.schema('booking').from('visits').delete().eq('client_profile_id', clientId);
  await admin.schema('booking').from('appointments').delete().eq('client_profile_id', clientId);
}

/**
 * Settled visits with bills. `billing.bills.visit_id` is UNIQUE and NOT NULL —
 * exactly one bill per visit — so each spend point needs its own visit row.
 */
async function seedSpend(clientId: string, points: Array<[number, number]>): Promise<void> {
  let billNumber = Date.now() % 1_000_000;
  for (const [pounds, daysAgo] of points) {
    const at = iso(-daysAgo * DAY_MS);
    const { data: visit, error: visitError } = await admin
      .schema('booking')
      .from('visits')
      .insert({
        business_id: businessId,
        location_id: locationId,
        client_profile_id: clientId,
        status: 'paid',
        checked_in_at: at,
        started_at: at,
        completed_at: at,
        source: 'demo_seed',
      })
      .select('id')
      .maybeSingle<{ id: string }>();
    if (visitError) throw new Error(`visit: ${visitError.message}`);
    if (!visit) continue;

    const gross = Math.round(pounds * 100);
    const { error } = await admin.schema('billing').from('bills').insert({
      business_id: businessId,
      location_id: locationId,
      visit_id: visit.id,
      client_profile_id: clientId,
      bill_number: billNumber++,
      // Only a `paid` bill is spend. A voided one is excluded by the reader.
      status: 'paid',
      net_cents: gross,
      tax_cents: 0,
      gross_cents: gross,
      occurred_at: at,
    });
    if (error) throw new Error(`bill: ${error.message}`);
  }
}

async function seedAttendance(
  clientId: string,
  events: Array<{ status: string; daysAgo: number; cancelledDaysBefore?: number }>,
): Promise<void> {
  for (const event of events) {
    const start = new Date(Date.now() - event.daysAgo * DAY_MS);
    const { error } = await admin.schema('booking').from('appointments').insert({
      business_id: businessId,
      location_id: locationId,
      client_profile_id: clientId,
      status: event.status,
      scheduled_start_at: start.toISOString(),
      scheduled_end_at: new Date(start.getTime() + 3_600_000).toISOString(),
      ...(event.status === 'paid' ? { completed_at: start.toISOString() } : {}),
      ...(event.cancelledDaysBefore !== undefined
        ? { cancelled_at: new Date(start.getTime() - event.cancelledDaysBefore * DAY_MS).toISOString() }
        : {}),
    });
    if (error) throw new Error(`attendance appointment: ${error.message}`);
  }
}

/** Two colour appointments touching end-to-end on ONE stylist. */
async function seedColourPair(
  staffProfileId: string,
  serviceId: string,
  clientA: string,
  clientB: string,
): Promise<void> {
  const slots: Array<[string, string, string]> = [
    ['10:00', '11:30', clientA],
    ['11:30', '13:00', clientB],
  ];
  for (const [start, end, clientId] of slots) {
    await seedDiaryAppointment({ staffProfileId, clientId, start, end, serviceId });
  }
}

/** A shift with two bookings 30 min apart, plus a break that must not read as a gap. */
async function seedGapDay(staffProfileId: string, clientId: string): Promise<void> {
  await seedDiaryAppointment({ staffProfileId, clientId, start: '09:00', end: '10:00' });
  await seedDiaryAppointment({ staffProfileId, clientId, start: '10:30', end: '11:30' });
  await seedDiaryAppointment({ staffProfileId, clientId, start: '12:30', end: '13:00' });
  await seedDiaryAppointment({ staffProfileId, clientId, start: '13:30', end: '14:30' });

  const { data: shift, error } = await admin
    .schema('rota')
    .from('shifts')
    .insert({
      business_id: businessId,
      location_id: locationId,
      staff_profile_id: staffProfileId,
      // Only published/completed shifts count as a commitment to be at work.
      status: 'published',
      scheduled_start_at: today('09:00'),
      scheduled_end_at: today('17:00'),
      source: 'demo_seed',
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`shift: ${error.message}`);
  if (!shift) return;

  // 13:00-13:30 lunch, exactly filling the space between two bookings.
  const { error: breakError } = await admin.schema('rota').from('shift_breaks').insert({
    business_id: businessId,
    location_id: locationId,
    shift_id: shift.id,
    started_at: today('13:00'),
    ended_at: today('13:30'),
  });
  if (breakError) throw new Error(`shift break: ${breakError.message}`);
}

async function seedDiaryAppointment(input: {
  staffProfileId: string;
  clientId: string;
  start: string;
  end: string;
  serviceId?: string;
}): Promise<void> {
  const startsAt = today(input.start);
  const endsAt = today(input.end);
  const { data, error } = await admin
    .schema('booking')
    .from('appointments')
    .insert({
      business_id: businessId,
      location_id: locationId,
      client_profile_id: input.clientId,
      assigned_staff_profile_id: input.staffProfileId,
      status: 'accepted',
      scheduled_start_at: startsAt,
      scheduled_end_at: endsAt,
      // The canonical stylist-busy window the signals read.
      occupied_ranges: `{["${startsAt}","${endsAt}")}`,
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`diary appointment: ${error.message}`);
  if (!data || !input.serviceId) return;

  // The service link is what makes an appointment structurally colour work.
  const { error: linkError } = await admin.schema('booking').from('appointment_services').insert({
    business_id: businessId,
    location_id: locationId,
    appointment_id: data.id,
    service_id: input.serviceId,
    sequence_no: 1,
    service_name_snapshot: 'Demo Signals Colour',
    duration_minutes: 90,
  });
  if (linkError) throw new Error(`appointment service: ${linkError.message}`);
}

/** Today at a given UTC wall-clock time. The demo salon runs on Europe/London. */
function today(hhmm: string): string {
  const now = new Date();
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m)).toISOString();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
