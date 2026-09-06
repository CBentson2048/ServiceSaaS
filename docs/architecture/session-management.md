# User sessions

How a person stays signed in across the four surfaces, what used to go wrong,
and what is still outstanding.

Audited and largely rebuilt on **2026-09-06**. Everything below was read from
the code; the failures described are ones that were traced end to end, not
guesses.

---

## 1. The shape of a session

QLOOQO does **not** use `supabase-js` in any client. Every surface talks to the
NestJS API, and only the API talks to Supabase Auth:

```
browser / phone / tablet          apps/api                     Supabase
──────────────────────────────────────────────────────────────────────────────
POST /api/auth/login        →  AuthService.login          →  signInWithPassword
                            ←  { session, user }          ←  access + refresh
GET  /api/<anything>        →  SupabaseAuthGuard          →  getUser(jwt)
   Authorization: Bearer …  →  resolveAuthUser(id)        →  core.* queries
POST /api/auth/refresh      →  AuthService.refresh        →  refreshSession
POST /api/auth/logout       →  AuthService.logout         →  signOut(local)
```

`AuthSession` (`packages/domain`) is what a client stores:

| Field | Meaning |
|---|---|
| `accessToken` | Supabase JWT. **Lifetime one hour** (`supabase/config.toml` `jwt_expiry = 3600`). Sent as `Authorization: Bearer` on every call. |
| `refreshToken` | Exchanged for a new session. **Rotated on every use**, with a 10-second reuse interval. |
| `expiresAt` | ISO timestamp of the access token's expiry. Clients rotate a minute before this. |

`AuthUser` is *never* persisted — only the session is. The user (roles,
permissions, locations) is re-resolved from the database on every verification,
so a role change takes effect without anyone signing out.

### Where each surface keeps it

| Surface | Storage | Cross-tab / restart |
|---|---|---|
| `apps/web` dashboard | `localStorage['sheer.web.auth.session']` | Shared between tabs; a `storage` event propagates sign-in, sign-out and rotation |
| `apps/sheer-app` (Expo) | `expo-secure-store` | Survives restarts |
| `apps/sheer-lab` (tablet) | in-memory module variable | Lost on reload — see §5 |
| API | nothing | Stateless per request, plus a 30-second verified-token cache |

---

## 2. Staying signed in

Two mechanisms, one proactive and one reactive. Both were added on 2026-09-06;
before that, **nothing refreshed a token during a live session**.

### Scheduled rotation (the main one)

`AuthProvider` (web and mobile) sets a timer for `expiresAt − 60s`. When it
fires, it rotates the refresh token, stores the new session and re-arms. A
device that was asleep past the deadline computes a negative delay and rotates
immediately; the web also re-arms when the tab becomes visible or the browser
comes back online, and the phone when the app is foregrounded.

If a rotation fails for a reason that is **not** a rejection, it retries with a
back-off starting at 2 seconds — inside Supabase's reuse interval, so a retry
after a failure mid-rotation still succeeds.

Two rotations are never scheduled closer than a minute apart
(`MIN_ROTATION_SPACING_MS`). A device with a badly wrong clock sees every fresh
token as already past its deadline; the floor turns what would be a tight loop
into one wasted refresh a minute. The session itself is unaffected — the server
judges expiry by its own clock.

### Refresh-and-replay (the safety net)

`request()` in `apps/web/src/auth/api.ts` and `apps/sheer-app/src/auth/api.ts`
retries **once** on a 401: it asks the provider for a fresh token and replays
the call. The caller never sees the blip. Auth endpoints are excluded (they are
what the handler calls).

### Rotation is serialised

Supabase rotates refresh tokens, so replaying one fails. The web guards against
that twice: an in-flight promise per tab, and a cross-tab **Web Lock**
(`sheer.web.auth.refresh`). A tab that waited for the lock re-reads storage
first and adopts whatever another tab already obtained rather than replaying a
spent token.

---

## 3. What is *not* an expired session

This is the rule the whole design turns on:

> Only Supabase **answering** "these credentials are not valid" proves a session
> is dead. Anything else — a network failure, a 5xx during a redeploy, a 429
> from the shared per-IP auth budget — means *we could not tell*.

It matters because every client deletes its stored session when it hears 401/403
from an auth endpoint. Reporting an outage as 401 therefore signs **every user**
out over someone else's problem, and destroys refresh tokens that were fine.

- API: `isAuthoritativeRejection` (`auth.service.ts`) — a 4xx other than 408/429
  is Supabase's verdict; everything else raises **503 Service Unavailable**.
- Web: only 401/403 clears the session. A transient failure "stands down" — the
  stored session is **kept** and retried when the tab is next visible or the
  browser reconnects.
- Mobile: identical rule at cold start and on the refresh path.

---

## 4. Signing out

`AuthService.logout` revokes with **`scope: 'local'`** — this session only.

auth-js defaults to `scope: 'global'`, which revokes every session the person
holds. Until 2026-09-06 that was the behaviour: signing out of the dashboard
also signed the same owner out of their phone and the salon's Lab tablet. Each
surface signs in separately and now signs out separately. ("Sign out everywhere"
would be a deliberate, separate action; it does not exist yet.)

Logout is best-effort — the client has already forgotten the session — but not a
no-op. It tries, in order: `setSession` + `signOut` (both tokens; refreshes
first if the access token has already expired), exchanging a refresh token for
an access token when that is all it has, then the admin API. It also invalidates
the verified-token cache immediately, so a signed-out token stops working at
once rather than at the end of its window.

---

## 5. Per-request verification, and the cache

Every authenticated request runs `SupabaseAuthGuard` → `verifyAccessToken`:
one HTTPS call to GoTrue plus `resolveAuthUser`'s ~7 database queries and a
`last_seen_at` write — before the endpoint does any of its own work. A single
dashboard page fires half a dozen of those.

`VerifiedTokenCache` (`apps/api/src/auth/verified-token.cache.ts`) collapses that
burst: a successfully verified token is trusted for **30 seconds**, keyed by
sha256 (never the raw token), bounded at 5,000 entries, and invalidated
immediately on sign-out.

**The trade-off, stated plainly:** a cached entry is an authorisation decision,
so a suspended membership or a lowered security level takes effect up to 30
seconds late. Sign-out is exempt. If a shorter window is ever wanted, change
`VERIFIED_TOKEN_TTL_MS`; the cache is not shared between API instances, so a
second replica simply verifies for itself.

---

## 6. Session-bearing calls are isolated

`AuthService` keeps one shared `anon` client for `getUser(jwt)` **only** — the
one auth-js call that carries no session state.

Everything that *returns* a session (`signInWithPassword`, `refreshSession`)
runs on a throwaway client created for that call. `auth-js` stores the resulting
session on whichever client made the call, even with `persistSession: false`,
and a later `refreshSession` on that client loads the stored session first and
refreshes it when it is close to expiry. On one process-wide client that means a
refresh for user B issues an extra token grant **carrying user A's refresh
token**, and concurrent refreshes queue behind a single shared in-flight promise.

Supabase's parent-token rule means that stray rotation did not actually lock
user A out on a single-instance deployment — this was investigated and the
"random logout" theory was **disproved**. It was still another user's credential
being spent, an extra call against a shared rate limit, and a session-killing
bug the moment the API runs more than one replica. A client per call costs an
object and no network.

---

## 7. Failure modes, before and after

| Scenario | Before | Now |
|---|---|---|
| Dashboard open for over an hour | Every page fails ("Invalid or expired session", empty KPI tiles) while the top bar still shows the user signed in; only a reload fixed it | Token rotates a minute before expiry; nothing visible happens |
| Phone app in use for over an hour | Notification poll gets a 401 → forced logout to `/login`, valid refresh token deleted | Rotates in the background; a 401 is retried once after a refresh |
| Supabase or database blip | Every signed-in user logged out, stored sessions deleted | 503 from the API; sessions kept and retried |
| Cold start with no signal (phone) | Signed out, credentials deleted | Stays stored; retried when the app is next foregrounded |
| Dashboard opened while API is down | Dropped to the login form, no explanation, no retry | Login form, but the session is kept and restored by itself when the API returns |
| Sign out on one device | Signed out **everywhere** | Only that device |
| Sign out with an expired access token | 204, nothing revoked | Refreshed, then revoked |
| Just signed in | A second `/auth/me`; a blip on it signed the user straight back out | Not re-proved |
| Another tab signs in as someone else | First tab kept showing the previous identity | Re-proved against the adopted session |

---

## 8. Verifying a change here

```bash
pnpm --filter @sheer/api test      # auth-session.service.spec.ts, verified-token.cache.spec.ts
pnpm --filter @sheer/web test      # AuthProvider.spec.tsx
```

The specs pin the behaviours that are easy to regress: rotation before expiry,
no re-proving of a fresh session, an outage never costing a session, sign-out
scope, and the cache's window and invalidation.

Manual checks worth doing against a real environment:

1. Sign in, leave a dashboard tab idle for over an hour, then click something —
   it should just work, and the network tab should show one `/auth/refresh`
   about a minute before the hour.
2. Sign in on the dashboard and the phone as the same user; sign out on one —
   the other must stay signed in.
3. Stop the API, reload the dashboard (login form appears), start the API, bring
   the tab forward — the session should restore itself with no typing.
4. Two dashboard tabs, wait for a rotation — exactly one `/auth/refresh`.

---

## 9. Known gaps

Not fixed on 2026-09-06; recorded deliberately.

| # | Gap | Impact | Where |
|---|---|---|---|
| 1 | **Lab holds no refreshable user session.** `signInToSheerLab` writes an `AuthSession` to a module variable that nothing reads back, and `packages/api-client` has no 401 semantics; the Lab's real auth is the device session + PIN session. | A user token used in the Lab cannot be refreshed and is lost on reload | `apps/sheer-lab/src/lib/storage/sessionStorage.ts`, `packages/api-client/src/index.ts` |
| 2 | **PIN unlock is unauthenticated and its lockout does not count wrong PINs.** | Brute-forceable Lab session creation from a known device/location id | `apps/api/src/lab-session/lab-session.service.ts` |
| 3 | **Lab PIN session is a hard 10-minute cap from unlock** with no client heartbeat. | A stylist working longer than 10 minutes silently loses the session mid-formula | `apps/sheer-lab/src/features/sheer-lab/labSession.ts` |
| 4 | **Lab `sessionId` travels in the URL path** and is written to request logs. | Anyone who can read API logs can replay a station's session | `apps/api/src/common/request-response-logging.middleware.ts` |
| 5 | **Lab device token is deleted on any transient resolve error.** | An iPad that restarts offline demands re-registration | `apps/sheer-lab/src/features/sheer-lab/deviceSession.ts` |
| 6 | **`surface` is optional on `/auth/login` and `/auth/refresh`**; omitting it defaults to `'api'`, which skips `assertSurfaceAccess`. The issued token is identical either way, so this gates issuance rather than access — the API's role and permission guards are what actually protect endpoints. | A non-owner can obtain a session the dashboard would accept; the dashboard's own route guards still refuse them | `apps/api/src/auth/dto.ts` |
| 7 | **A transient failure between rotation and response** still strands the caller with a spent refresh token (one retry, then 503). | Rare; recovered by a quick client retry inside the reuse interval | `AuthService.refresh` |
| 8 | **JWTs are verified by calling Supabase**, not locally against JWKS. | The cache removes most of the cost; local verification would remove the rest | `AuthService.verifyAccessToken` |

Items 1–5 are the Lab's own session subsystems — device registration, PIN unlock
and the lab session, described in
[sheer-lab-session-flow.md](sheer-lab-session-flow.md) and
[database-notes-lab-auth.md](database-notes-lab-auth.md). They are separate from
the user session described here and were not in scope for this pass. **Item 2 is
a security issue and should be scheduled on its own merits.**
