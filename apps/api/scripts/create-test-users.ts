/**
 * Creates deterministic Supabase Auth users for RLS + workflow testing.
 *
 * Environment files:
 * - Loads repo-root `.env.local` then `.env` first (monorepo convenience)
 * - Then loads `apps/api/.env.local` then `apps/api/.env` **with override**, so API-local values win
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

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient, type User } from '@supabase/supabase-js';

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '..', '..');

// Load env files with predictable precedence:
// - repo root first
// - then `apps/api` last (override) so local API secrets win over accidental root values
dotenv.config({ path: path.join(repoRoot, '.env.local') });
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(apiRoot, '.env.local'), override: true });
dotenv.config({ path: path.join(apiRoot, '.env'), override: true });

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

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;

  const b64url = parts[1];
  if (!b64url) return null;

  // JWT uses base64url without padding; normalize to base64 for broad Node compatibility.
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  try {
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function assertSupabaseServiceRoleKey(serviceRoleKey: string): void {
  const trimmed = serviceRoleKey.trim();
  const payload = decodeJwtPayload(trimmed);
  const role = typeof payload?.role === 'string' ? payload.role : undefined;

  if (role === 'anon') {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY looks like the anon/public key (JWT role is "anon"). ' +
        'Use the service_role secret from Supabase Dashboard → Project Settings → API.',
    );
  }

  if (role && role !== 'service_role') {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY JWT role is "${role}", expected "service_role". ` +
        'Paste the service_role secret from Supabase Dashboard → Project Settings → API.',
    );
  }
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
  assertSupabaseServiceRoleKey(serviceRoleKey);
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
