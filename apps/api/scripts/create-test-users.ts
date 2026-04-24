/**
 * Creates deterministic Supabase Auth users for RLS + workflow testing.
 *
 * Requires:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   SHEER_TEST_USER_PASSWORD (defaults to SheerTest123!)
 *
 * Run from repo root:
 *   pnpm --filter @sheer/api create-test-users
 *
 * Idempotent: skips users that already exist (matched by email, case-insensitive).
 */

import { createClient, type User } from '@supabase/supabase-js';

const SEED_TAG = 'sheer_rls_fixture';

const TEST_USERS: Array<{ email: string; fullName: string }> = [
  { email: 'owner@sheer.local', fullName: 'Luke Ormsby' },
  { email: 'manager.alpha@sheer.local', fullName: 'Manager Alpha' },
  { email: 'manager.beta@sheer.local', fullName: 'Manager Beta' },
  { email: 'stylist.alpha@sheer.local', fullName: 'Stylist Alpha' },
  { email: 'stylist.beta@sheer.local', fullName: 'Stylist Beta' },
  { email: 'client.alice@sheer.local', fullName: 'Alice Carter' },
  { email: 'client.bob@sheer.local', fullName: 'Bob Morgan' },
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

async function findUserByEmail(
  admin: ReturnType<typeof createClient>['auth']['admin'],
  email: string,
): Promise<User | null> {
  const normalized = email.toLowerCase();
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await admin.listUsers({ page, perPage });
    if (error) throw error;
    const found = data.users.find((u) => u.email?.toLowerCase() === normalized) ?? null;
    if (found) return found;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function main(): Promise<void> {
  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const password = process.env.SHEER_TEST_USER_PASSWORD?.trim() || 'SheerTest123!';

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const admin = supabase.auth.admin;

  for (const u of TEST_USERS) {
    const existing = await findUserByEmail(admin, u.email);
    if (existing) {
      console.log(`exists\t${u.email}\t${existing.id}`);
      continue;
    }

    const { data, error } = await admin.createUser({
      email: u.email,
      password,
      email_confirm: true,
      user_metadata: {
        seed: SEED_TAG,
        full_name: u.fullName,
      },
    });

    if (error) {
      // Race-safe idempotency
      if (String(error.message).toLowerCase().includes('already')) {
        const again = await findUserByEmail(admin, u.email);
        if (again) {
          console.log(`exists\t${u.email}\t${again.id}`);
          continue;
        }
      }
      throw error;
    }

    if (!data.user) {
      throw new Error(`createUser returned no user for ${u.email}`);
    }

    console.log(`created\t${u.email}\t${data.user.id}`);
  }

  console.log('\nDone. Next: apply relational seed (supabase db reset, or run seed.sql against your DB).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
