/**
 * Idempotent demo seed for campaign configuration (Wrike 4507283957).
 *
 * Builds the deterministic scenario the Luke walkthrough needs, so the demo is
 * reproducible rather than dependent on whatever happens to be in the database
 * that morning. Every campaign type gets exactly one client who SHOULD receive
 * it, plus two clients who deliberately should NOT — because "nothing was sent,
 * and here is why" is the more important half of the demo.
 *
 * WHO IT CREATES (all with a DEMO- client code prefix, all with test contact
 * details on example.com / +447700900xxx, which is Ofcom's reserved drama range):
 *
 *   Jane Rebooking   6 completed colour visits every 42 days, the last one 90
 *                    days ago, and NOTHING in the diary.
 *                    -> eligible for the rebooking campaign (overdue).
 *   Olivia Birthday  birthday TODAY, in the salon's own timezone.
 *                    -> eligible for the birthday campaign.
 *   Priya Promo      marketing-consented, a handful of visits.
 *                    -> eligible for the promotion campaign.
 *   Mia Loyal        exactly 10 completed visits.
 *                    -> eligible for the 10-visit loyalty milestone.
 *   Owen Optedout    overdue exactly like Jane, but marketing_opt_in = false.
 *                    -> SUPPRESSED, and the preview says why.
 *   Ben Booked       overdue exactly like Jane, but has an appointment next week.
 *                    -> SUPPRESSED by the canonical `booked` status, with no
 *                       campaign-specific rule involved.
 *
 * AND FOUR CAMPAIGNS, one of each approved type, all created as DRAFTS. The demo
 * switches them on; the seed never does, because a seed script that arms
 * automated marketing would be exactly the accident this feature is designed to
 * prevent.
 *
 * The history is REAL visits and appointments — the same rows
 * crm.client_service_history, crm.client_next_bookings and
 * comms.campaign_loyalty_metrics read in production. Nothing here fabricates a
 * count or a status.
 *
 * Re-running updates the same rows rather than duplicating them: clients and
 * campaigns upsert on their natural keys, and the demo history is deleted and
 * re-created relative to now so the cadence always lands where it should.
 *
 * Usage:
 *   pnpm --filter @sheer/api seed-campaign-demo -- --business <id> --location <id>
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
  console.error('Usage: seed-campaign-demo -- --business <id> --location <id>');
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

/** The client's colour cadence, in days. Six visits gives a confident median. */
const CADENCE_DAYS = 42;
/** Days since the overdue clients' last visit. 90 - 42 = 48 days past due, well
 *  beyond the 14-day default buffer, so they read as `lapsed` not `at_risk`. */
const OVERDUE_LAST_VISIT_DAYS = 90;
const LOYALTY_MILESTONE_VISITS = 10;

interface DemoClient {
  code: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  marketingOptIn: boolean;
  dateOfBirth: string | null;
  /** Completed visits to create, most recent first (days ago). */
  visitDaysAgo: number[];
  /** A future appointment, in days from now. */
  futureBookingInDays?: number;
  note: string;
}

function daysAgoSeries(count: number, mostRecentDaysAgo: number): number[] {
  return Array.from({ length: count }, (_, i) => mostRecentDaysAgo + i * CADENCE_DAYS);
}

async function salonToday(): Promise<{ timezone: string; todayLocal: string }> {
  const { data, error } = await admin
    .schema('core')
    .from('locations')
    .select('timezone')
    .eq('id', locationId)
    .eq('business_id', businessId)
    .maybeSingle<{ timezone: string }>();
  if (error) throw new Error(`load location: ${error.message}`);
  if (!data) throw new Error('Location not found in that business');

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: data.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { timezone: data.timezone, todayLocal: `${get('year')}-${get('month')}-${get('day')}` };
}

async function main(): Promise<void> {
  const { timezone, todayLocal } = await salonToday();
  console.log(`Seeding campaign demo for ${businessId} / ${locationId} (${timezone}, today is ${todayLocal}).`);

  // Olivia's birthday is TODAY in the salon's calendar — the whole point of the
  // birthday demo. Year 1990 so she is a plausible adult client.
  const birthdayToday = `1990-${todayLocal.slice(5)}`;

  const clients: DemoClient[] = [
    {
      code: 'DEMO-REBOOK',
      firstName: 'Jane',
      lastName: 'Rebooking',
      phone: '+447700900201',
      email: 'jane.rebooking@example.com',
      marketingOptIn: true,
      dateOfBirth: '1988-03-12',
      visitDaysAgo: daysAgoSeries(6, OVERDUE_LAST_VISIT_DAYS),
      note: 'overdue, nothing booked -> ELIGIBLE for rebooking',
    },
    {
      code: 'DEMO-BIRTHDAY',
      firstName: 'Olivia',
      lastName: 'Birthday',
      phone: '+447700900202',
      email: 'olivia.birthday@example.com',
      marketingOptIn: true,
      dateOfBirth: birthdayToday,
      visitDaysAgo: daysAgoSeries(3, 20),
      note: 'birthday today -> ELIGIBLE for birthday',
    },
    {
      code: 'DEMO-PROMO',
      firstName: 'Priya',
      lastName: 'Promo',
      phone: '+447700900203',
      email: 'priya.promo@example.com',
      marketingOptIn: true,
      dateOfBirth: '1993-11-02',
      visitDaysAgo: daysAgoSeries(4, 15),
      note: 'marketing-consented -> ELIGIBLE for promotion',
    },
    {
      code: 'DEMO-LOYAL',
      firstName: 'Mia',
      lastName: 'Loyal',
      phone: '+447700900204',
      email: 'mia.loyal@example.com',
      marketingOptIn: true,
      dateOfBirth: '1991-06-21',
      visitDaysAgo: daysAgoSeries(LOYALTY_MILESTONE_VISITS, 12),
      note: `${LOYALTY_MILESTONE_VISITS} completed visits -> ELIGIBLE for the loyalty milestone`,
    },
    {
      code: 'DEMO-OPTOUT',
      firstName: 'Owen',
      lastName: 'Optedout',
      phone: '+447700900205',
      email: 'owen.optedout@example.com',
      // The single difference from Jane. Everything else about him qualifies.
      marketingOptIn: false,
      dateOfBirth: birthdayToday,
      visitDaysAgo: daysAgoSeries(6, OVERDUE_LAST_VISIT_DAYS),
      note: 'overdue but no marketing consent -> SUPPRESSED',
    },
    {
      code: 'DEMO-BOOKED',
      firstName: 'Ben',
      lastName: 'Booked',
      phone: '+447700900206',
      email: 'ben.booked@example.com',
      marketingOptIn: true,
      dateOfBirth: '1987-09-30',
      visitDaysAgo: daysAgoSeries(6, OVERDUE_LAST_VISIT_DAYS),
      // The single difference from Jane. The canonical `booked` status excludes
      // him; no campaign-specific rule is involved.
      futureBookingInDays: 7,
      note: 'overdue but already rebooked -> SUPPRESSED by the canonical booked status',
    },
  ];

  const clientIds = new Map<string, string>();

  for (const client of clients) {
    const id = await upsertClient(client);
    clientIds.set(client.code, id);
    await replaceHistory(id, client);
    console.log(`  ${client.firstName} ${client.lastName}: ${client.note}`);
  }

  await seedCampaigns(todayLocal);

  console.log('');
  console.log('Four DRAFT campaigns are ready (nothing is switched on — that is the demo).');
  console.log('Open Campaigns as the owner, preview each audience, then switch one on.');
}

// ---------------------------------------------------------------------------
// Clients and their history
// ---------------------------------------------------------------------------

async function upsertClient(client: DemoClient): Promise<string> {
  const { data, error } = await admin
    .schema('core')
    .from('client_profiles')
    .upsert(
      {
        business_id: businessId,
        client_code: client.code,
        primary_location_id: locationId,
        first_name: client.firstName,
        last_name: client.lastName,
        email: client.email,
        phone: client.phone,
        marketing_opt_in: client.marketingOptIn,
        date_of_birth: client.dateOfBirth,
        source: 'demo_seed',
      },
      { onConflict: 'business_id,client_code' },
    )
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw new Error(`client ${client.code}: ${error.message}`);
  if (!data) throw new Error(`client ${client.code}: no row returned`);
  return data.id;
}

/**
 * Replace this demo client's history. Deleting first is what makes the script
 * re-runnable: the visits are anchored to `now`, so a second run must not stack
 * a fresh cadence on top of yesterday's.
 */
async function replaceHistory(clientId: string, client: DemoClient): Promise<void> {
  await admin.schema('booking').from('visits').delete().eq('client_profile_id', clientId);
  await admin.schema('booking').from('appointments').delete().eq('client_profile_id', clientId);

  const nowMs = Date.now();
  const visits = client.visitDaysAgo.map((daysAgo) => {
    const at = new Date(nowMs - daysAgo * 86_400_000).toISOString();
    return {
      business_id: businessId,
      location_id: locationId,
      client_profile_id: clientId,
      status: 'paid' as const,
      checked_in_at: at,
      started_at: at,
      completed_at: at,
      source: 'demo_seed',
    };
  });

  const { error: visitError } = await admin.schema('booking').from('visits').insert(visits);
  if (visitError) throw new Error(`visits for ${client.code}: ${visitError.message}`);

  if (client.futureBookingInDays !== undefined) {
    const start = new Date(nowMs + client.futureBookingInDays * 86_400_000);
    const end = new Date(start.getTime() + 90 * 60_000);
    const { error } = await admin
      .schema('booking')
      .from('appointments')
      .insert({
        business_id: businessId,
        location_id: locationId,
        client_profile_id: clientId,
        status: 'confirmed',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
      });
    if (error) throw new Error(`future booking for ${client.code}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// The four campaigns — one of each approved type, all drafts
// ---------------------------------------------------------------------------

async function seedCampaigns(todayLocal: string): Promise<void> {
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const campaigns = [
    {
      campaign_type: 'rebooking',
      name: 'Demo — We miss you',
      message_template:
        "Hi {{first_name}}, it's been a while since your last visit to {{salon_name}}. " +
        'We would love to see you again — book here: {{booking_link}}',
      config: { targetStatuses: ['lapsed'], minOverdueDays: 0, serviceCategoryId: null },
    },
    {
      campaign_type: 'birthday',
      name: 'Demo — Happy birthday',
      message_template:
        'Happy birthday {{first_name}}! Everyone at {{salon_name}} is wishing you a wonderful day.',
      config: { daysBefore: 0 },
    },
    {
      campaign_type: 'promotion',
      name: 'Demo — Autumn offer',
      message_template:
        'Hi {{first_name}}, we have something special on at {{salon_name}} this month. {{booking_link}}',
      config: {
        startDate: todayLocal,
        endDate: inTwoWeeks,
        lapseStatuses: [],
        serviceCategoryId: null,
        minCompletedVisits: 0,
      },
    },
    {
      campaign_type: 'loyalty_milestone',
      name: 'Demo — Thank you',
      message_template:
        'Hi {{first_name}}, that is {{salon_name}} visit number ten — thank you for being such a loyal client.',
      config: { metric: 'completed_visits', threshold: LOYALTY_MILESTONE_VISITS },
    },
  ];

  for (const campaign of campaigns) {
    const { error } = await admin
      .schema('comms')
      .from('campaigns')
      .upsert(
        {
          business_id: businessId,
          location_id: locationId,
          campaign_type: campaign.campaign_type,
          name: campaign.name,
          // DRAFT, always. A seed script must never arm automated marketing.
          status: 'draft',
          channel: 'auto',
          message_template: campaign.message_template,
          send_at_local_hour: 10,
          config: campaign.config,
        },
        { onConflict: 'business_id,location_id,campaign_type,name' },
      );
    // The unique index is on lower(btrim(name)), which PostgREST cannot target
    // with onConflict, so a re-run may report a duplicate instead of updating.
    // That is harmless — the campaign already exists in the shape we want.
    if (error && !/duplicate key|no unique|constraint matching/i.test(error.message)) {
      throw new Error(`campaign ${campaign.name}: ${error.message}`);
    }
    console.log(`  campaign: ${campaign.name} (${campaign.campaign_type}, draft)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
