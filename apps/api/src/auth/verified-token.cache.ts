import { createHash } from 'node:crypto';
import type { AuthUser } from '@sheer/domain';

/**
 * How long a successfully verified access token is trusted without asking
 * Supabase again.
 *
 * WHY THERE IS A CACHE AT ALL. Every authenticated request runs
 * `SupabaseAuthGuard` → `verifyAccessToken`, which is one HTTPS round trip to
 * GoTrue plus `resolveAuthUser`'s seven-or-so PostgREST queries and a
 * `last_seen_at` write — before the endpoint does any of its own work. A single
 * dashboard page fires half a dozen of those. That is slow, and it is a
 * liability: GoTrue's rate limits are per IP, the API is one IP for every
 * salon, and a throttled or flaky auth call used to surface as "your session
 * expired" (see `isAuthoritativeRejection`).
 *
 * WHY IT IS SHORT. The cached entry is an authorisation decision, so anything
 * that should revoke access — a suspended membership, a lowered security level,
 * a password change — takes effect one window late. Thirty seconds is long
 * enough to collapse a page's burst of calls into one verification and short
 * enough that no one waits meaningfully for a revocation to bite. Sign-out is
 * not subject to the window at all: `AuthService.logout` invalidates the token
 * as it revokes it.
 */
export const VERIFIED_TOKEN_TTL_MS = 30_000;

/** Bounded so a long-lived process cannot accumulate tokens without limit. */
export const VERIFIED_TOKEN_MAX_ENTRIES = 5_000;

interface CacheEntry {
  user: AuthUser;
  /** Epoch ms after which this entry must be re-verified. */
  expiresAt: number;
}

/**
 * A small, in-process cache of verified access tokens.
 *
 * Keys are sha256 digests rather than the tokens themselves: the raw bearer
 * credential should not sit in a long-lived map that could reach a heap dump or
 * a debug log. Nothing here is shared between API instances, which is fine —
 * the worst case for a second instance is that it verifies the token itself.
 */
export class VerifiedTokenCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = VERIFIED_TOKEN_TTL_MS,
    private readonly maxEntries: number = VERIFIED_TOKEN_MAX_ENTRIES,
  ) {}

  get(token: string, now: number = Date.now()): AuthUser | null {
    const key = digest(token);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.user;
  }

  set(token: string, user: AuthUser, now: number = Date.now()): void {
    const key = digest(token);
    // Re-inserting moves the key to the end of the Map's insertion order, which
    // is what makes the eviction below oldest-first.
    this.entries.delete(key);
    this.entries.set(key, { user, expiresAt: now + this.ttlMs });
    this.evict(now);
  }

  /** Drop a token immediately — used when a session is deliberately revoked. */
  invalidate(token: string): void {
    this.entries.delete(digest(token));
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    if (this.entries.size <= this.maxEntries) return;
    // Expired entries first — they cost nothing to lose.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Still over: drop the oldest insertions until we are under the cap.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) return;
      this.entries.delete(key);
    }
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
