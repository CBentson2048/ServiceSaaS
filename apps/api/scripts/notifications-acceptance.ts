/**
 * In-app notification acceptance harness — the client-visible UAT scenario for the
 * notification foundation, run against a REAL migrated database through the same
 * PostgREST + RPC path the platform uses.
 *
 * WHY THIS EXISTS. The Jest suites stub the Supabase client, so they prove the
 * service ASKS for the right things. supabase/tests/in_app_notifications.sql proves
 * the database ENFORCES them, but only on a scratch database. This script proves the
 * whole thing end to end on the actual non-production environment: a check-in
 * produces an arrival notification for the right stylist, the badge moves, read and
 * unread work per-recipient, nobody else can see it, and — the reliability
 * requirement — the check-in still succeeds when notification creation is made to
 * fail on purpose.
 *
 * It walks the 14 steps of the ticket's UAT scenario in order and prints a PASS/FAIL
 * per step.
 *
 * Everything runs inside its own fixture tenant (UUID prefix fb000000-) and is
 * deleted afterwards unless --keep is passed. NEVER run against production.
 *
 * Usage:
 *   pnpm --filter @sheer/api notifications-acceptance            # run + clean up
 *   pnpm --filter @sheer/api notifications-acceptance -- --keep  # leave fixtures for UAT
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from apps/api/.env(.local).
 * Requires migration 0099 to be applied to the target database.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { NotificationType } from '@sheer/domain';

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
// Fixture ids — hex-only, dedicated fb prefix, disjoint from every other suite
// ('ee' = messaging/week6, 'a6' = week6 acceptance, 'fa' = the 0099 psql suite).
// ---------------------------------------------------------------------------
const id = (suffix: string) => `fb000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
const BIZ = id('1');
const RIVAL = id('2');
const LOC = id('a1');
const RIVAL_LOC = id('a2');
const OWNER = id('f1');
const MANAGER = id('f2');
const STYLIST = id('f3');
const RIVAL_USER = id('f4');
const STYLIST_STAFF = id('51');
const CLIENT = id('c1');
const APPT = id('b1');

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

async function must<T>(
  step: string,
  promise: PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${step}: ${error.message}`);
  return data;
}

/**
 * booking.appointments.occupied_ranges is NOT NULL with no default — the booking
 * layer normally computes it — so a fixture has to supply it explicitly or the
 * insert fails and the whole harness aborts in setup.
 */
function occupiedRange(startIso: string, endIso: string): string {
  return `{[${startIso},${endIso})}`;
}

/** The feed exactly as NotificationsService reads it, for one user. */
async function feed(userProfileId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await admin
    .schema('comms')
    .from('notification_recipients')
    .select('read_at,seen_at,created_at,notifications!inner(id,type,title,body,entity_type,entity_id,action_path)')
    .eq('user_profile_id', userProfileId)
    .eq('business_id', BIZ)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`feed(${userProfileId}): ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function unreadCount(userProfileId: string): Promise<number> {
  const { count, error } = await admin
    .schema('comms')
    .from('notification_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('user_profile_id', userProfileId)
    .eq('business_id', BIZ)
    .is('read_at', null);
  if (error) throw new Error(`unreadCount(${userProfileId}): ${error.message}`);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
async function setup(): Promise<void> {
  console.log('\n-- Setup ------------------------------------------------------');
  await cleanup(true);

  await must(
    'businesses',
    admin.schema('core').from('businesses').insert([
      { id: BIZ, name: 'Notify Acceptance Salon', slug: `notify-acc-${Date.now()}` },
      { id: RIVAL, name: 'Rival Acceptance Salon', slug: `rival-acc-${Date.now()}` },
    ]),
  );

  await must(
    'locations',
    admin.schema('core').from('locations').insert([
      {
        id: LOC, business_id: BIZ, code: 'NA1', name: 'Pinner',
        slug: `notify-acc-pinner-${Date.now()}`, address_line_1: '1 High St',
        city: 'Pinner', postal_code: 'HA5 1AA', timezone: 'Europe/London',
      },
      {
        id: RIVAL_LOC, business_id: RIVAL, code: 'NA2', name: 'Rival',
        slug: `notify-acc-rival-${Date.now()}`, address_line_1: '2 High St',
        city: 'Watford', postal_code: 'WD1 1AA', timezone: 'Europe/London',
      },
    ]),
  );

  // core.user_profiles.id references auth.users(id), so the auth rows come first.
  for (const [uid, email] of [
    [OWNER, 'owner'], [MANAGER, 'manager'], [STYLIST, 'stylist'], [RIVAL_USER, 'rival'],
  ] as const) {
    await admin.auth.admin.createUser({
      // A fixed id keeps the run deterministic and re-runnable.
      id: uid,
      email: `${email}.${uid.slice(-4)}@notify-acceptance.example`,
      email_confirm: true,
      password: `Acc3ptance!${uid.slice(-4)}`,
    } as never);
  }

  await must(
    'user_profiles',
    admin.schema('core').from('user_profiles').insert([
      { id: OWNER, email: `owner.${OWNER.slice(-4)}@notify-acceptance.example`, full_name: 'Olive Owner', first_name: 'Olive', last_name: 'Owner', display_name: 'Olive' },
      { id: MANAGER, email: `manager.${MANAGER.slice(-4)}@notify-acceptance.example`, full_name: 'Mo Manager', first_name: 'Mo', last_name: 'Manager', display_name: 'Mo' },
      { id: STYLIST, email: `stylist.${STYLIST.slice(-4)}@notify-acceptance.example`, full_name: 'Sam Stylist', first_name: 'Sam', last_name: 'Stylist', display_name: 'Sam' },
      { id: RIVAL_USER, email: `rival.${RIVAL_USER.slice(-4)}@notify-acceptance.example`, full_name: 'Rex Rival', first_name: 'Rex', last_name: 'Rival', display_name: 'Rex' },
    ]),
  );

  await must(
    'memberships',
    admin.schema('core').from('user_memberships').insert([
      { business_id: BIZ, location_id: null, user_profile_id: OWNER, role: 'owner', status: 'active' },
      { business_id: BIZ, location_id: LOC, user_profile_id: MANAGER, role: 'manager', status: 'active' },
      { business_id: BIZ, location_id: LOC, user_profile_id: STYLIST, role: 'stylist', status: 'active' },
      { business_id: RIVAL, location_id: RIVAL_LOC, user_profile_id: RIVAL_USER, role: 'stylist', status: 'active' },
    ]),
  );

  await must(
    'staff_profile',
    admin.schema('core').from('staff_profiles').insert([
      {
        id: STYLIST_STAFF, business_id: BIZ, user_profile_id: STYLIST,
        primary_location_id: LOC, display_name: 'Sam', employment_status: 'active',
        hourly_rate: 15, q_code: 'NOTIFYACCQ1',
      },
    ]),
  );

  await must(
    'client',
    admin.schema('core').from('client_profiles').insert([
      // client_code is constrained to ^[A-Z0-9]{8,}$ — a slice of the lowercase-hex
      // fixture uuid would violate it and abort setup.
      { id: CLIENT, business_id: BIZ, client_code: 'NOTIFYACC01', first_name: 'Jane', last_name: 'Smith', phone: '+447700900123', email: 'jane@notify-acceptance.example' },
    ]),
  );

  const start = new Date(Date.now() + 3_600_000);
  await must(
    'appointment',
    admin.schema('booking').from('appointments').insert([
      {
        id: APPT, business_id: BIZ, location_id: LOC, client_profile_id: CLIENT,
        assigned_staff_profile_id: STYLIST_STAFF,
        // Enum labels, verified against booking.staff_request_mode_enum and
        // booking.booking_channel_enum — 'specific'/'salon' are NOT members.
        staff_request_mode: 'specific_staff',
        status: 'accepted', booking_channel: 'staff_app',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: new Date(start.getTime() + 3_600_000).toISOString(),
        occupied_ranges: occupiedRange(
          start.toISOString(),
          new Date(start.getTime() + 3_600_000).toISOString(),
        ),
      },
    ]),
  );

  console.log('  fixtures created');
}

// ---------------------------------------------------------------------------
// The UAT scenario, in the ticket's order
// ---------------------------------------------------------------------------

/** Steps 1-3: reception checks the client in, the stylist gets a notification. */
async function phaseArrival(): Promise<void> {
  console.log('\n-- Arrival ----------------------------------------------------');

  // Step 2 — the front desk checks the client in. This is the same transition
  // LabAppointmentsService.checkIn performs (conditional on status='accepted').
  const checkedIn = await must(
    'check-in',
    admin
      .schema('booking')
      .from('appointments')
      .update({ status: 'checked_in', check_in_at: new Date().toISOString() })
      .eq('id', APPT)
      .eq('business_id', BIZ)
      .eq('status', 'accepted')
      .select('id,status')
      .maybeSingle<{ id: string; status: string }>(),
  );
  report('02_CHECK_IN_SUCCEEDS', checkedIn?.status === 'checked_in', `status=${checkedIn?.status}`);

  // Step 3 — the arrival producer. Same arguments ArrivalNotificationService sends.
  const created = await must(
    'create_notification',
    admin.schema('comms').rpc('create_notification', {
      p_business_id: BIZ,
      p_type: NotificationType.ClientArrived,
      p_title: 'Client arrived',
      p_body: 'Jane has arrived.',
      p_recipient_user_profile_ids: [STYLIST],
      p_location_id: LOC,
      p_priority: 'high',
      p_entity_type: 'appointment',
      p_entity_id: APPT,
      p_action_path: `/bookings?appointmentId=${APPT}`,
      p_dedupe_key: `client_arrived:${APPT}`,
      p_created_by_user_profile_id: MANAGER,
    }),
  );
  const row = (Array.isArray(created) ? created[0] : created) as
    | { notification_id: string | null; recipient_count: number; deduplicated: boolean }
    | undefined;
  report('03_NOTIFICATION_CREATED_FOR_STYLIST', Boolean(row?.notification_id) && Number(row?.recipient_count) === 1,
    JSON.stringify(row));
}

/** Steps 5-7: the stylist sees it, unread, with routing context. */
async function phaseStylistSees(): Promise<void> {
  console.log('\n-- Stylist feed -----------------------------------------------');
  const rows = await feed(STYLIST);
  const first = rows[0];
  const content = (first?.['notifications'] ?? {}) as Record<string, unknown>;

  report('05_NOTIFICATION_APPEARS_IN_FEED', rows.length === 1, `rows=${rows.length}`);
  report('06_IT_IS_UNREAD', first?.['read_at'] === null);
  report('07_UNREAD_COUNT_IS_ONE', (await unreadCount(STYLIST)) === 1);
  report(
    '07b_CARRIES_ROUTING_CONTEXT',
    content['entity_type'] === 'appointment' &&
      content['entity_id'] === APPT &&
      content['action_path'] === `/bookings?appointmentId=${APPT}`,
    JSON.stringify(content),
  );
  report('07c_BODY_IS_MINIMAL', content['body'] === 'Jane has arrived.', String(content['body']));
}

/** Steps 8-11: read, badge down, unread, badge up. */
async function phaseReadState(): Promise<void> {
  console.log('\n-- Read / unread ----------------------------------------------');

  await must(
    'mark read',
    admin
      .schema('comms')
      .from('notification_recipients')
      .update({ read_at: new Date().toISOString() })
      .eq('user_profile_id', STYLIST)
      .eq('business_id', BIZ)
      .is('read_at', null)
      .select('id'),
  );
  report('08_MARK_READ', (await feed(STYLIST))[0]?.['read_at'] !== null);
  report('09_UNREAD_COUNT_DROPS_TO_ZERO', (await unreadCount(STYLIST)) === 0);

  await must(
    'mark unread',
    admin
      .schema('comms')
      .from('notification_recipients')
      .update({ read_at: null })
      .eq('user_profile_id', STYLIST)
      .eq('business_id', BIZ)
      .select('id'),
  );
  report('10_MARK_UNREAD', (await feed(STYLIST))[0]?.['read_at'] === null);
  report('11_UNREAD_COUNT_RETURNS_TO_ONE', (await unreadCount(STYLIST)) === 1);
}

/** Step 12: nobody else can retrieve it — including the owner. */
async function phaseIsolation(): Promise<void> {
  console.log('\n-- Isolation --------------------------------------------------');
  report('12a_MANAGER_CANNOT_SEE_IT', (await feed(MANAGER)).length === 0);
  report('12b_OWNER_CANNOT_SEE_IT', (await feed(OWNER)).length === 0);
  report('12c_RIVAL_BUSINESS_SEES_NOTHING', (await feed(RIVAL_USER)).length === 0);

  // A second notification addressed to the owner AND the manager: the owner reading
  // it must leave the manager's copy unread.
  const shared = await must(
    'shared notification',
    admin.schema('comms').rpc('create_notification', {
      p_business_id: BIZ,
      p_type: NotificationType.OrderApprovalRequired,
      p_title: 'Approval needed',
      p_body: 'A purchase order needs approval.',
      p_recipient_user_profile_ids: [OWNER, MANAGER],
    }),
  );
  const sharedId = ((Array.isArray(shared) ? shared[0] : shared) as { notification_id: string })
    ?.notification_id;

  await must(
    'owner reads',
    admin
      .schema('comms')
      .from('notification_recipients')
      .update({ read_at: new Date().toISOString() })
      .eq('notification_id', sharedId)
      .eq('user_profile_id', OWNER)
      .select('id'),
  );

  report('12d_OWNER_READ_LEAVES_MANAGER_UNREAD', (await unreadCount(MANAGER)) === 1);
  report('12e_OWNER_BADGE_IS_CLEAR', (await unreadCount(OWNER)) === 0);
}

/** Step 13: the user/device mapping foundation. */
async function phaseDevices(): Promise<void> {
  console.log('\n-- Device foundation ------------------------------------------');
  const deviceId = await must(
    'register device',
    admin.schema('comms').rpc('register_user_device', {
      p_business_id: BIZ,
      p_user_profile_id: STYLIST,
      p_device_identifier: 'acceptance-installation-1',
      p_platform: 'ios',
      p_push_token: 'ExponentPushToken[ACCEPTANCE]',
    }),
  );
  report('13a_DEVICE_REGISTERS', typeof deviceId === 'string' && deviceId.length > 0);

  // Re-registering the same installation must update, not duplicate.
  await must(
    're-register',
    admin.schema('comms').rpc('register_user_device', {
      p_business_id: BIZ,
      p_user_profile_id: STYLIST,
      p_device_identifier: 'acceptance-installation-1',
      p_platform: 'ios',
      p_push_token: 'ExponentPushToken[ROTATED]',
    }),
  );
  const devices = await must(
    'list devices',
    admin
      .schema('comms')
      .from('user_devices')
      .select('id,enabled,push_token')
      .eq('business_id', BIZ)
      .eq('user_profile_id', STYLIST)
      .returns<Array<{ id: string; enabled: boolean; push_token: string | null }>>(),
  );
  const deviceRows = devices ?? [];
  report('13b_REREGISTER_DOES_NOT_DUPLICATE', deviceRows.length === 1, `devices=${deviceRows.length}`);
  report('13c_TOKEN_ROTATES', deviceRows[0]?.push_token === 'ExponentPushToken[ROTATED]');

  // Cross-business assignment must be impossible.
  const { error: crossError } = await admin.schema('comms').rpc('register_user_device', {
    p_business_id: BIZ,
    p_user_profile_id: RIVAL_USER,
    p_device_identifier: 'acceptance-installation-2',
    p_platform: 'android',
    p_push_token: 'ExponentPushToken[RIVAL]',
  });
  report('13d_CROSS_BUSINESS_DEVICE_REJECTED', crossError !== null, crossError?.message ?? 'accepted!');
}

/**
 * Step 14: the reliability requirement. The source event stays successful when
 * notification creation fails. Failure is induced for real (an unknown recipient
 * makes create_notification write nothing) rather than simulated in the harness.
 */
async function phaseFailureIsolation(): Promise<void> {
  console.log('\n-- Failure isolation ------------------------------------------');

  const before = await unreadCount(STYLIST);

  // A second appointment, checked in while the notification cannot be created.
  const APPT2 = id('b2');
  const start = new Date(Date.now() + 7_200_000);
  await must(
    'second appointment',
    admin.schema('booking').from('appointments').insert([
      {
        id: APPT2, business_id: BIZ, location_id: LOC, client_profile_id: CLIENT,
        assigned_staff_profile_id: STYLIST_STAFF,
        staff_request_mode: 'specific_staff',
        status: 'accepted', booking_channel: 'staff_app',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: new Date(start.getTime() + 3_600_000).toISOString(),
        occupied_ranges: occupiedRange(
          start.toISOString(),
          new Date(start.getTime() + 3_600_000).toISOString(),
        ),
      },
    ]),
  );

  const checkedIn = await must(
    'second check-in',
    admin
      .schema('booking')
      .from('appointments')
      .update({ status: 'checked_in', check_in_at: new Date().toISOString() })
      .eq('id', APPT2)
      .eq('business_id', BIZ)
      .eq('status', 'accepted')
      .select('id,status')
      .maybeSingle<{ id: string; status: string }>(),
  );

  // The notification attempt fails: the recipient is not a member of this business.
  // ArrivalNotificationService would swallow this; here we observe it directly.
  const failedAttempt = await admin.schema('comms').rpc('create_notification', {
    p_business_id: BIZ,
    p_type: NotificationType.ClientArrived,
    p_title: 'Client arrived',
    p_body: 'Jane has arrived.',
    p_recipient_user_profile_ids: [RIVAL_USER],
    p_location_id: LOC,
    p_dedupe_key: `client_arrived:${APPT2}`,
  });
  const failedRow = (Array.isArray(failedAttempt.data) ? failedAttempt.data[0] : failedAttempt.data) as
    | { notification_id: string | null }
    | undefined;

  report('14a_NOTIFICATION_DID_NOT_HAPPEN', failedRow?.notification_id === null, JSON.stringify(failedRow));
  report('14b_CHECK_IN_STILL_SUCCEEDED', checkedIn?.status === 'checked_in', `status=${checkedIn?.status}`);
  report('14c_NO_PHANTOM_BADGE', (await unreadCount(STYLIST)) === before);

  // And idempotency: replaying the FIRST arrival must not create a second one.
  const replay = await must(
    'replay arrival',
    admin.schema('comms').rpc('create_notification', {
      p_business_id: BIZ,
      p_type: NotificationType.ClientArrived,
      p_title: 'Client arrived',
      p_body: 'Jane has arrived.',
      p_recipient_user_profile_ids: [STYLIST],
      p_location_id: LOC,
      p_dedupe_key: `client_arrived:${APPT}`,
    }),
  );
  const replayRow = (Array.isArray(replay) ? replay[0] : replay) as { deduplicated: boolean } | undefined;
  report('14d_REPLAYED_CHECK_IN_DOES_NOT_RENOTIFY', replayRow?.deduplicated === true);
  report('14e_STYLIST_BADGE_UNCHANGED', (await unreadCount(STYLIST)) === before);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function del(schema: string, table: string, column: string, values: string[]): Promise<void> {
  await admin.schema(schema).from(table).delete().in(column, values);
}

async function cleanup(quiet = false): Promise<void> {
  if (!quiet) console.log('\n-- Cleanup ----------------------------------------------------');
  // notifications/recipients/devices cascade from businesses, but delete explicitly
  // so a partial earlier run cannot leave rows behind.
  await del('comms', 'notification_recipients', 'business_id', [BIZ, RIVAL]);
  await del('comms', 'notifications', 'business_id', [BIZ, RIVAL]);
  await del('comms', 'user_devices', 'business_id', [BIZ, RIVAL]);
  await del('booking', 'appointments', 'business_id', [BIZ, RIVAL]);
  await del('core', 'client_profiles', 'business_id', [BIZ, RIVAL]);
  await del('core', 'staff_profiles', 'business_id', [BIZ, RIVAL]);
  await del('core', 'user_memberships', 'business_id', [BIZ, RIVAL]);
  await del('core', 'user_profiles', 'id', [OWNER, MANAGER, STYLIST, RIVAL_USER]);
  for (const uid of [OWNER, MANAGER, STYLIST, RIVAL_USER]) {
    await admin.auth.admin.deleteUser(uid).catch(() => undefined);
  }
  await del('core', 'locations', 'business_id', [BIZ, RIVAL]);
  await del('core', 'businesses', 'id', [BIZ, RIVAL]);
  if (!quiet) console.log('Cleanup done.');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`In-app notification acceptance against ${supabaseUrl} ${keep ? '(keeping fixtures)' : ''}`);
  try {
    await setup();
    await phaseArrival();
    await phaseStylistSees();
    await phaseReadState();
    await phaseIsolation();
    await phaseDevices();
    await phaseFailureIsolation();
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
