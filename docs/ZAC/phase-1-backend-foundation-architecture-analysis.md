# ZAC Phase 1 Backend Foundation Architecture Analysis

> **Nature of this document.** This is a **code-grounded architecture analysis** for the ZAC Phase 1 backend foundation, written by reading the current `develop` tree of the QLOOQO / `sheer-platform` monorepo. It **creates no source code, no migrations, no env changes, and no Supabase data** — it is analysis only. It operationalises the already-accepted Phase 0 plan ([Day 2 Core Architecture](phase-0-day-2-core-architecture.md), [Future Integration Notes](phase-0-future-integration-notes.md), [Phase 1 MVP Roadmap](phase-1-mvp-roadmap.md), [Decision Log](phase-0-decision-log.md)) against verified repository reality, and flags where the code diverges from the Phase 0 assumptions so the build starts on correct foundations.
>
> Date: 2026-07-24 · Scope: `apps/api` (NestJS), `packages/domain`, `supabase/migrations`, `apps/web`, `apps/sheer-app`, `apps/sheer-lab`. Every load-bearing claim is cited to a repo-relative `path:line`. Phase 1 remains **read-only** end-to-end (Decision Log **D4/D11/D43**); no autonomous actions are planned.

---

## Executive Summary

ZAC Phase 1 slots into the existing NestJS backend as **one more feature module at `apps/api/src/zac/`** (confirms Decision Log **D1 / QC1**). The repository is a mature pnpm-workspace + Turborepo monorepo with a single NestJS 10 API, ~38 domain modules following a uniform `module → controller → service → dto.ts` shape, a fixed permission catalogue in `packages/domain`, and a deterministic KPI engine. ZAC can reuse all of this with almost no new plumbing.

Five findings are load-bearing and shape every recommendation below:

1. **There is no JWT-scoped / RLS-enforced data path anywhere in the API.** Every one of ~38–40 services opens its **own `SUPABASE_SERVICE_ROLE_KEY` client** and enforces tenant/location scope *in application TypeScript* (`.eq('business_id', actor.businessId)` + `allowedLocationIds`). RLS policies exist but are **enabled-not-forced** and keyed on `auth.uid()`, which is null under service-role — so the database provides **no tenant backstop**. ZAC's Phase 0 mandate ("acting-user JWT, never a service-role key") must therefore be interpreted precisely: **ZAC never opens its own broad DB client; it composes the existing guarded service methods, passing the resolved `AuthUser`** — inheriting their in-code scoping.

2. **The existing services re-check *role* and *location* but NOT the fine-grained `report.*` / `crm.*` permission key** — that key is enforced *only* at the controller guard. If ZAC calls a service directly, that permission check is bypassed. **Consequence:** every ZAC read tool must **independently re-check the exact permission its equivalent HTTP endpoint requires** (via `userHasAllPermissions` from `@sheer/domain`) before invoking the service. This is the single most important safety rule for the tool layer.

3. **A new `zac.access` permission is safe and additive**, but because owners auto-resolve `[...ALL_PERMISSIONS]` (`auth.service.ts:603-604`), the moment `zac.access` enters the catalogue every owner holds it. **The permission cannot be the dark-launch switch — a feature flag must be.**

4. **The global request/response logging middleware logs full request and response bodies to stdout, redacting only 8 fixed auth key-names** (`common/request-response-logging.middleware.ts:4-13`). A ZAC prompt/answer field is not in that set, so prompts and model responses (which will contain client PII and financials) would be dumped verbatim. This must be fixed **before the first ZAC endpoint ships** (D32).

5. **QLAB/stock is genuinely mixed.** `LabAnalyticsService.summary` (colour margin/waste) and inventory low-stock are stable, applied, and guarded. But the formula record-model chain (`0063/0068/0069`) and split-tender (`0070`) are **not applied on the inspected dev-test branch** (newest applied = `0062`) and are active V1.1 work. Retail is empty; `waste_events` is write-only; there is **no supplier/ordering/expiry/forecast model at all**. QLAB should be a **Week-1 feasibility pass** and expose at most **two read tools** in Week 2/3.

**The recommended Week-1 foundation** is a read-only `ZacModule` guarded by the standard three-guard chain plus `@RequirePermissions('zac.access')`, an acting-user context resolver over `AuthUser`, a role-profile selector, a permission-aware tool registry (registering **zero** write tools), a provider-agnostic model router (first provider: latest Claude), an evidence-grounded response contract, and the measurement + cost logging spine — all behind a feature flag, web-only, with no unrestricted DB access and no disruption to the V1.1 roadmap.

---

## Current Project Architecture

**Monorepo shape (VERIFIED).** pnpm-workspace (`pnpm-workspace.yaml:1-3` → `apps/*`, `packages/*`) + Turborepo (`turbo.json`). Node 20 (`.nvmrc`), pnpm 10.33 (`package.json:10`). Root scripts are thin turbo pass-throughs (`package.json:12-16`).

| Layer | Location | Framework |
|---|---|---|
| **Main backend (ZAC's home)** | `apps/api` | NestJS 10 (`apps/api/package.json:22-27`), Express platform |
| Main web frontend | `apps/web` | Vite 5 + React 19 + react-router 6 |
| Mobile — clients + stylists | `apps/sheer-app` | Expo 55 + expo-router |
| Mobile — colour lab | `apps/sheer-lab` | bare React Native 0.83 + BLE (PIN lab-session auth) |
| Shared domain contracts | `packages/domain` | pure TS, dual CJS/ESM, ships from `dist/` |

**Shared packages (VERIFIED).** `@sheer/domain` is the single source of truth for `AuthUser`, the `Permission` union, `PERMISSION_CATALOG`, `DEFAULT_ROLE_PERMISSIONS`, and all role/permission helpers — consumed by every app. Others: `@sheer/auth` (session helpers; mostly a stub for the API path — the real guards live in `apps/api/src/auth`), `@sheer/api-client`, `@sheer/booking-core`, `@sheer/lab-core`, `@sheer/types`, `@sheer/utils`, `@sheer/ui-mobile`, `@sheer/design-tokens`, `@sheer/config` (dev-only). **Apps consume the built `dist/`, not source** — editing `@sheer/domain` requires a rebuild for web/mobile to see it (memory: `domain-package-dist-vs-source`). The API additionally path-maps `@sheer/domain` → source for local typecheck (`apps/api/tsconfig.json:24-30`).

**Backend module architecture (VERIFIED).** `apps/api/src` holds ~38 feature modules plus `common/` (cross-cutting helpers incl. the logging middleware) and `config/` (env validation). Every feature module is `<name>.module.ts` + `<name>.controller.ts` + `<name>.service.ts` + `dto.ts` (+ optional `*.spec.ts` / calc helpers). Modules are registered as a plain array in `app.module.ts:41-82`; **registering ZAC = adding one `ZacModule` line.** `nest-cli.json:4` sets `sourceRoot: src` with `deleteOutDir`, so any new `src/zac/` folder is auto-compiled by `nest build` with no build-config change.

**Database & migrations (VERIFIED).** Supabase Postgres 17, twelve schemas exposed on the search path (`supabase/config.toml:16-18`): `public, core, booking, crm, rota, lab, inventory, billing, analytics, comms, audit` (+ graphql). Migrations are sequential files `supabase/migrations/NNNN_snake_case.sql` — latest committed is `0070_salon_payments_split_tender.sql`. ⚠️ **The in-flight payroll work has already added untracked `0071_payroll_foundation` … `0074_payroll_permissions` on disk, so ZAC's next free migration number is `0075+`** (take the actual next-free at authoring time). The top-level `database/` folder is stale reference-only scaffolding (`database/README.md` designates `supabase/migrations/` as source of truth) — **do not put ZAC DDL there.** Migrations are applied via CLI/SQL files, **never** via the Supabase MCP DDL path (memory: `migrations-via-files-not-mcp`). A new `zac` schema must also be added to each hosted project's Exposed Schemas or PostgREST returns `PGRST106` (memory: `owner-onboarding-exposed-schemas`).

**Env / config (VERIFIED).** `ConfigModule.forRoot({ isGlobal, cache, validate })` (`app.module.ts:42-47`); a single `EnvConfig` class validates all env at boot (`apps/api/src/config/env.validation.ts`), where `SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY` are required and everything else `@IsOptional`. **There is no LLM/Anthropic dependency or env var anywhere today** — ZAC introduces the first outbound-LLM surface.

**Deploy targets:** API → Railway (`railway.json`, healthcheck `/health`) or Docker (`dockerfile`); web → Vercel; mobile → EAS/RN CLI (out of turbo `build`).

---

## Backend Framework and Module Pattern

**Framework:** NestJS 10 on Express (`apps/api/package.json:22-27`). Bootstrap (`main.ts`, read fully) registers **only** a global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` (`main.ts:21-27`), a global `api` route prefix excluding health (`main.ts:28`), CORS, and a logger restricted to `error|warn|log` (`main.ts:9`). **There is no global guard, no global exception filter, and no global interceptor** — cross-cutting behaviour is opt-in per controller. The one global middleware is `RequestResponseLoggingMiddleware`, applied to all routes (`app.module.ts:84-87`).

**The canonical pattern ZAC must copy (VERIFIED via `kpi`, `dashboard`, `crm`):**

```ts
// kpi/kpi.module.ts:6-12
@Module({ imports: [AuthModule], controllers: [KpiController], providers: [KpiService], exports: [KpiService] })

// kpi/kpi.controller.ts:10-21 — the load-bearing security pattern
@Controller('kpi')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
export class KpiController {
  @Get('stylists')
  @RequireRoles('owner', 'manager')
  @RequirePermissions('report.commission.view')
  stylists(@CurrentUser() actor: AuthUser, @Query() query: KpiQueryDto) { return this.kpi.stylistList(actor, query); }
}
```

Conventions verified across all exemplars:

- **Guard order is always `SupabaseAuthGuard, RolesGuard, PermissionsGuard`** (auth first, so `request.auth` exists before role/permission guards read it).
- Two guard-placement styles: **per-route** roles/permissions (KPI) and **class-level defaults with per-method overrides** (CRM/Dashboard, using `reflector.getAllAndOverride` so a method decorator *replaces*, not adds to, the class value — `permissions.guard.ts:24`). ZAC should adopt class-level `@RequirePermissions('zac.access')` plus per-tool re-checks in code.
- Controllers are **thin** one-liners returning `this.service.method(actor, dto)`. The acting user is read via the custom `@CurrentUser()` param decorator typed `AuthUser` (`auth/current-user.decorator.ts:6-11`), conventionally named `actor`.
- **DTOs** live in a single `dto.ts` per module (not a `dto/` folder), using `class-validator` decorators + `@Type()` coercion; the global pipe enforces them (`crm/dto.ts`, `kpi/dto.ts:9-25`). Custom validators exist (`@IsPhoneField()`), so a custom ZAC input validator is idiomatic.
- **DI:** every service is `@Injectable()`, takes `ConfigService` (+ sibling services) via constructor. **There is no shared `SupabaseModule`, no injected client token, no `@Inject`, no `forwardRef`.** Cross-service composition = import the other module and inject its **exported** service (e.g. `CrmService` injects `LabFormulaService`). `KpiService` and `CrmService` are already exported; `DashboardService` is **not** (`dashboard.module.ts` — a one-line `exports:` add if ZAC injects it).
- **Errors:** standard Nest `HttpException` subclasses only; **no custom exception classes, no `@Catch` filters, no global filter.** Convention: `NotFound` when a row is absent/out-of-business, `Forbidden` when it exists but is out of location/role scope, `BadRequest` for invalid inputs. DB failures are swallowed and rethrown as a generic 500 via a private `fail()` helper that logs and never leaks the raw Postgres message (`kpi.service.ts:531-534`).
- **Logging:** per-class `private readonly logger = new Logger(<Class>.name)` is universal; zero `console.*` in source. Request/response logging is global (see below).

**Where a new ZAC module should live — CONFIRMED: `apps/api/src/zac/`** (matches D1/QC1 and the 38-module convention; needs no workspace, `nest-cli`, or tsconfig change). **Files ZAC should imitate by name:** controller → `kpi/kpi.controller.ts`; service → `crm/crm.service.ts` (service-injects-service composition, load-then-authorize scoping) + `kpi/kpi.service.ts` (`fail()`/logger idiom) **minus the service-role `createClient` constructor**; DTO → `crm/dto.ts` + `kpi/dto.ts`; module → `kpi/kpi.module.ts`; auth wiring → import `AuthModule` (exports every guard + `AuthService`).

---

## Auth and Acting User Context

**The JWT boundary (VERIFIED).** `SupabaseAuthGuard` (`auth/supabase-auth.guard.ts`) reads `Authorization: Bearer <jwt>` (header only — no cookie/query), calls `AuthService.verifyAccessToken(token)`, and attaches the result to **`request.auth`** (not `request.user`). `verifyAccessToken` (`auth.service.ts:439-446`) validates the token via the **anon** Supabase client `this.anon.auth.getUser(token)` (signature + expiry checked by Supabase GoTrue), then discards everything except the user id and calls `resolveAuthUser(userId)`. **The user's JWT never reaches a data query** — it only proves identity; the DB is the source of truth for roles/permissions.

**`resolveAuthUser` (`auth.service.ts:448-551`) — the identity oracle** builds the full `AuthUser`: active memberships → **single-business collapse** (only the highest-privilege membership's business is considered — one business per session, a known platform limitation), `roles[]` (highest-first), `allowedLocationIds` (owner ⇒ all active locations; else the union of membership `location_id`s), `locationScope` (`{kind: 'all'|'locations'|'self'}`), `staffProfileId`/`clientProfileId`, and **effective `permissions[]`** (owner ⇒ `[...ALL_PERMISSIONS]`; else the union of security-level permissions or `DEFAULT_ROLE_PERMISSIONS`, fail-closed, closed over prerequisites via `expandPermissions`). It also writes `user_profiles.last_seen_at` on every resolve (a benign side effect ZAC inherits via the guard).

**The `AuthUser` shape (VERIFIED — `packages/domain/src/index.ts:154-199`).** The Phase 0 claim of `{ roles[], businessId, businessTier, allowedLocationIds, locationScope, permissions[] }` is correct, with **two corrections and a bonus**:

- **Correction 1:** the user-id field is **`id`, not `userId`.** Map ZAC's `actor_user_id ← AuthUser.id`.
- **Correction 2:** the object is much richer — it also carries `primaryRole`, `businessName/Slug`, `locations[]`, `profile{email,fullName,…}`, `staffProfileId`, `clientProfileId`, `clientCode`, `timezone`. ZAC has more grounding than Phase 0 assumed (esp. `staffProfileId`, `timezone`, `locations[]`).
- `businessTier?` (`'spark'|'pulse'|'infinity'`) is typed optional but always populated on the JWT path.

**What ZAC receives per request** (after `SupabaseAuthGuard` runs, via `@CurrentUser() actor: AuthUser`):

| ZAC needs | From `AuthUser` | Notes |
|---|---|---|
| `actor_user_id` | `actor.id` | accountable actor id |
| `business_id` | `actor.businessId` | `''` ⇒ salon-less customer — **reject** |
| `role`(s) | `actor.roles` / `actor.primaryRole` | multi-role; gate on `roles[]`, never a single role |
| `permissions` | `actor.permissions` | effective, expanded |
| accessible locations | `actor.allowedLocationIds` + `actor.locationScope` + `actor.locations` | **a set, not a single active location** |
| staff identity | `actor.staffProfileId` | for stylist self-scoping |

**Risks / missing pieces:**

- **No single "active location."** ZAC must default to `actor.allowedLocationIds` and **state which locations it aggregated** — a natural-language question carries no `locationId`.
- **Single-business collapse:** "my businesses" (plural) is unanswerable in Phase 1.
- **Salon-less customer** (`businessId === ''`, empty permissions) — never issue a `.eq('business_id', '')` query; short-circuit these (`userHasJoinedSalon`).
- **Per-request cost:** every guarded call = one GoTrue round-trip + ~5 DB reads + a `last_seen_at` write. **Resolve the actor once at the controller boundary and thread the in-memory `AuthUser` through the whole agent turn** — do not re-verify per tool call.
- **The lab-session path is a separate auth model** (PIN + shared-device `sessionId`, no bearer token; `assertActiveSession` → a *degraded* synthetic `AuthUser`: single role, single location, no email, tier-less). **Phase 1 is JWT-only; do NOT wire the lab path.**

ZAC must **never re-derive** roles/permissions/locations itself — it reuses the `AuthUser` the guard produced. `packages/auth/src` is a stub (`createAuthGuardPlaceholder` returns `true`) — ignore it; the real auth lives in `apps/api/src/auth`.

---

## Permission and Role Model

**Roles (VERIFIED).** `UserRole = 'owner' | 'manager' | 'stylist' | 'client'` (`packages/domain/src/index.ts:5`; DB enum `core.membership_role_enum`, `0003:10-15`). `AuthUser.roles[]` is the authoritative multi-role source (`ROLE_PRIORITY = {owner:0,manager:1,stylist:2,client:3}`; helpers `userHasRole`/`userHasAnyRole`). Note: `lab-pin.service.ts` holds an **inverted** `ROLE_PRIORITY` copy for PIN selection — ZAC must use the domain `sortRolesByPriority`, never the lab-pin ordering (memory: `user-role-model`).

**Permission catalogue (VERIFIED — `packages/domain/src/index.ts`).** A closed `Permission` union (`:266-295`) + `PERMISSION_CATALOG` array (`:317-343`; `{key,label,description,kind,group,requires?}`) + `ALL_PERMISSIONS` (`:345`). The doc comment is explicit: *"add new keys here … never invent ad-hoc strings."* Report/financial keys ZAC cares about (all `kind:'report'`): `report.dashboard.view`, `report.performance.view`, `report.commission.view`, `report.financials.view`, `report.lab_analytics.view`, plus `crm.view`/`crm.manage`, `inventory.manage`, `staff.pay.manage`, `audit.read`.

**`DEFAULT_ROLE_PERMISSIONS` (`:411-437`):** owner = all; manager = all 5 reports + operations/settings + `staff.view` + `audit.read` (but **not** `staff.pay.manage`); stylist = `['bookings.manage','crm.view','retail.record','services.view','rota.view']` (no `report.*`); client = `[]`. Used only when a membership has no security level.

**How permissions are checked (VERIFIED).** `PermissionsGuard` requires the user to hold **ALL** listed keys via `userHasAllPermissions` (`permissions.guard.ts:36`); `RolesGuard` passes if **ANY** required role is held. Owners short-circuit to `[...ALL_PERMISSIONS]` at resolve time (`auth.service.ts:603-604`), so they can never be locked out. **Security levels** (migrations `0055`/`0057`) are an owner-configurable permission layer stored as `core.security_levels.permissions` jsonb, layered on top of the base role; unknown keys are silently filtered against `ALL_PERMISSIONS` on read (`auth.service.ts:645`).

**⚠ The critical gap (VERIFIED — the single most important tool-safety finding).** The fine-grained `report.*` / `crm.*` permission is enforced **only at the controller guard.** The service methods re-check **role and location scope but not the permission key**:

- `dashboard.service.ts:274-282` — `userHasAnyRole(['owner','manager'])` + location; **no** `report.dashboard.view` check.
- `kpi.service.ts:143-145, 291-295` — role + location only.
- `crm.service.ts:708-716` — owner/location/stylist-self only; `crm.view` never re-checked.

**Consequence:** if a ZAC tool calls a service directly, the permission check is skipped. A manager whose custom security level had `report.commission.view` removed still holds role `manager`, passes the service role-check, and would receive commission data they were explicitly denied. **Therefore every ZAC tool must independently assert the exact permission its equivalent endpoint requires**, before invoking the service:

| ZAC tool | Must re-check (mirrors the endpoint `@RequirePermissions`) |
|---|---|
| Dashboard KPIs / top services / low-stock | `report.dashboard.view` |
| Team / stylist performance | `report.performance.view` |
| Commission | `report.commission.view` |
| Revenue / retail ledger | `report.financials.view` |
| Colour-lab analytics | `report.lab_analytics.view` |
| Client / CRM lookups | `crm.view` |
| Audit trail | `audit.read` |

Owners pass all of these automatically, so this adds zero owner friction; it only correctly denies managers/stylists whatever a security level took away.

**Can `zac.access` be added safely? — YES (additive, no existing guard affected).** Guards only evaluate the keys named in their own decorator and pass when no metadata is present, so a brand-new catalogue key touches no existing route. To add it correctly and consistently (mirroring how the catalogue is wired):

1. Add `'zac.access'` to the `Permission` union (`:266-295`) **and** a `PERMISSION_CATALOG` row (`:317-343`; `kind:'feature'`, e.g. `group:'Intelligence'`, no `requires`).
2. Add it to the relevant `DEFAULT_ROLE_PERMISSIONS` entries (`:411-437`) — recommend **owner** (automatic anyway) and **manager**; **not stylist** in Phase 1.
3. Add it to the relevant `SYSTEM_SECURITY_LEVELS` entries (`:452-495`) so newly-seeded businesses get it.
4. Add migration **`0075_zac_access_permission.sql`** (next free number — `0071`–`0074` are the in-flight payroll migrations) appending `'zac.access'` to existing DB `core.security_levels.permissions` rows for the chosen system levels — **modelled exactly on `0057_security_level_read_permissions.sql` / `0058:74-79`** (`update … set permissions = permissions || '["zac.access"]'::jsonb where is_system and key in (...) and not permissions @> …`). Without this, members *assigned* a system level won't get it even though NULL-level members would (the existing `audit.read` drift, §6.4 of the permissions dossier).
5. **Rebuild `@sheer/domain` dist** so web/mobile permission UIs render the new toggle.

**Where ZAC checks `zac.access`:** at the controller boundary (`@RequirePermissions('zac.access')`) **and** re-asserted inside the tool dispatcher (so any internal path that reaches tools without the HTTP guard still fails closed).

**Why `zac.access` must NOT override underlying permissions:** because the underlying services don't re-check the permission key (the critical gap above), treating `zac.access` as a data grant would make it a back-door around every report/CRM restriction the security-levels feature exists to enforce. Effective visibility must be **`zac.access` AND the user's own per-report permission** — never `zac.access` alone.

**Recommended per-role approach:** **Owner** — grant by default; already holds every report/CRM permission → full "QLOOQO 10" report surface. **Manager** — grant by default; holds all 5 reports + CRM in defaults → same reports the dashboard shows, auto-scoped to `allowedLocationIds`; owners can revoke per security level. **Stylist** — do **not** grant in Phase 1 (their defaults have no `report.*`, so ZAC would be an empty shell; the per-tool re-checks make it safe to enable later for own-data-only coaching). **Client** — never; exclude `'client'` from `@RequireRoles`.

---

## Database and Supabase Access Pattern

**Client creation (VERIFIED).** There is **no central Supabase provider/module**. Each service builds its own client in its constructor from `ConfigService`, using the **service-role key** (`kpi.service.ts:133-139` and ~38 more services). The anon key is used **only** for JWT verification (`auth.service.ts:146`), never for data. The service-role key has Postgres `BYPASSRLS`, so **no backend query is constrained by RLS**.

**RLS is defined-but-dormant (VERIFIED).** `enable row level security` appears 42× and `CREATE POLICY` 91× across migrations, but **`force row level security` appears zero times.** Every policy predicate is keyed on `public.current_user_id()` → `auth.uid()` (`0001:12-18`), which is **null under a service-role connection**. Two independent reasons the policies never constrain the API: service-role bypasses RLS, and even if forced, `auth.uid()` is null. **Tenant isolation for all API traffic is 100% application-layer.** The migration header says it outright: *"Week 1 RLS is intentionally conservative. Most writes should flow through the API service role"* (`0007:1-2`). A query that forgets `.eq('business_id', …)` leaks across tenants with no DB backstop.

**Data-access pattern (VERIFIED).** No ORM, no repository layer — services call the PostgREST builder inline (`.schema('booking').from('appointments')…`, 526 occurrences), with row shapes hand-declared as interfaces, and `business_id`/`location_id` filters derived from the `AuthUser` and applied as fixed `.eq()/.in()` clauses the caller cannot override. Cross-schema data is stitched in application code (PostgREST can't embed across schemas — memory: `postgrest-no-cross-schema-embeds`). Scoping columns are near-ubiquitous: `business_id` in ~85 table defs, `location_id` in ~71.

**How ZAC avoids unrestricted DB access.** ZAC must **not** copy the `createClient(url, SERVICE_ROLE_KEY)` constructor for its *reasoning* tools — that would hand the LLM layer a `BYPASSRLS` connection to all 12 schemas across every tenant. Instead:

- **Reads:** ZAC tools call the **existing guarded service methods** (`KpiService`, `CrmService`, `DashboardService`, `LabAnalyticsService`, `InventoryService`, `RotaService`, …), passing the resolved `actor: AuthUser`. Each method already enforces role + location scope and pins `business_id`. ZAC adds the missing **permission-key re-check** on top (per the critical gap above). The LLM never sees a schema/table/`business_id` it can manipulate.
- **ZAC's own tables** (conversations, telemetry, memory) may use a **narrowly-scoped service-role writer confined to the `zac.*` schema**, exactly as `AuditService` is confined to `audit.activity_log` — every write/read still carrying `.eq('business_id', actor.businessId)` derived from the JWT-resolved actor, never from model output. This is consistent with house style and is *not* an arbitrary DB handle.

**Separate schema vs prefixed tables — recommend a dedicated `zac` schema** (consistent with the platform's 12-schema partitioning; keeps ZAC telemetry isolated from operational data; grantable to `service_role` only). **Enable AND FORCE RLS on the `zac` schema** — deliberately stronger than the rest of the platform, because ZAC stores conversation content, tool traces, cost telemetry, and private coaching memory (higher sensitivity), and it is new, so it can adopt the stricter posture without the "protect V1" constraint. Policies keyed on the existing `public.current_user_id()` / `public.is_business_owner(business_id)` helpers; `FORCE` ensures a future non-service-role path (or accidental owner-role connection) cannot cross-read ZAC history.

**Recommended required fields (all ZAC tables).** snake_case; `id uuid default gen_random_uuid()`; `created_at timestamptz not null default now()` (+ `updated_at` with the shared `public.set_updated_at()` trigger where mutable); **`business_id uuid not null`** on every table; `location_id uuid null` only where the row is genuinely location-scoped; `actor_user_id uuid` (= `AuthUser.id`); `role_context text` (snapshot of `actor.primaryRole`); `visibility_scope text` (mirrors `AuthUser.locationScope.kind`: `all|locations|self`). Snapshot `role_context`/`visibility_scope` at creation so a later permission change can't retroactively widen who a stored record "belongs to." (Full table list under *Proposed ZAC Data Model*.)

**Raw prompts/responses — avoid storing by default (D32, VERIFIED-adjacent).** ZAC context will contain client PII (names, phones, allergy/patch-test data) and financials read on the user's behalf; the platform already models `crm.gdpr_requests`. Default to **redacted content or content references** (pointers to the source report window / row ids), following the existing `comms.message_logs.content_preview` precedent (`0006:135` — a preview, never the full body). If verbatim capture is ever needed for evaluation, gate it behind an explicit per-business opt-in in a separate FORCE-RLS table with a short `expires_at`; never in `cost_events`/`tool_calls` (metadata only).

---

## Stable Reporting/KPI Services

These are ZAC Phase 1's primary read-only fuel. All arithmetic is done in **deterministic TypeScript**, not the DB and not an LLM — `kpi/kpi.calc.ts` is explicitly *"pure functions, no I/O … deterministic and side-effect free"* with a full unit-test spec. **ZAC must narrate these pre-computed numbers and never recompute a KPI itself** (D5, Truth principle).

| Endpoint | Roles | Permission | Service method | Metrics | Stable? |
|---|---|---|---|---|---|
| `GET /dashboard/kpis` | owner, manager | `report.dashboard.view` | `DashboardService.kpis` | revenue (paid), bookings mix, completed/cancelled/no-show, new vs repeat clients, rebooking rate + splits, avg booking value, low-stock count | **STABLE** |
| `GET /dashboard/top-services` | owner, manager | `report.dashboard.view` | `DashboardService.topServices` | top-5 services by count/revenue | **STABLE** |
| `GET /dashboard/stylist-performance` | owner, manager | `report.performance.view` (method override) | `DashboardService.stylistPerformance` | per-stylist bookings/completed/cancelled/no-show/rebooking/revenue/avg bill | **STABLE** |
| `GET /dashboard/inventory-alerts` | owner, manager | `report.dashboard.view` | `DashboardService.inventoryAlerts` | low-stock: on-hand vs threshold grams | **STABLE** |
| `GET /kpi/stylists` | owner, manager | `report.commission.view` | `KpiService.stylistList` | per-stylist hours/targets/rebooking/retail/avg-bill + **commission** | **STABLE (crown jewel)** |
| `GET /kpi/performance` | owner, manager | `report.performance.view` | `KpiService.stylistList` (same payload) | ⚠ also includes commission | **STABLE (leak — see below)** |
| `GET /kpi/me` | owner, manager, **stylist** | none | `KpiService.myKpi` | own KPI (self-scoped by `staffProfileId`) | **STABLE** |
| `GET /lab/analytics/summary` | owner, manager | `report.lab_analytics.view` | `LabAnalyticsService.summary` | colour revenue/cost/margin %, waste cost/%, per-location/stylist/service breakdowns, most-used products, low-stock | **STABLE (when lab used)** |
| `GET /retail-sales` | owner, manager | `report.financials.view` | `RetailSalesService.list` | retail ledger rows | STABLE schema, **empty data** |
| `GET /mobile-dashboard/{client,stylist,manager}` | per-role | mixed | `MobileDashboardService` | today's operational counts | STABLE (client/stylist/manager) |
| `GET /mobile-dashboard/owner` | owner | `report.dashboard.view` | — | **static stub, no metrics** | **avoid** |

**Two behaviours ZAC must internalise:**

1. **Method-level `@RequirePermissions` *overrides*, not adds to, the class-level one** (`getAllAndOverride`). `stylist-performance` needs only `report.performance.view`; `kpi/me` needs none. Encode the *effective* permission per endpoint.
2. **`/kpi/performance` leaks commission under the weaker `report.performance.view` gate** (it returns the same `StylistKpiResult` which always carries the `commission` block). Harmless for default roles (manager holds both), but a custom security level granting `report.performance.view` without `report.commission.view` would receive commission. **ZAC's team-performance tool must strip commission fields unless `report.commission.view` is also held.** Similarly, strip raw pay/rate/target fields unless `staff.pay.manage` (mirrors `staff.service.ts:1488-1500`).

**Available vs missing metrics.** Available now: revenue (paid), bookings mix, rebooking rate (+ stylist/client split), per-stylist performance, commission (full tiered engine), colour margin/waste %, product usage, low-stock, avg bill. **Missing / not-a-wrapper:**

- **Utilisation is NOT a server endpoint.** `computeDailyUtilisation` is a pure function in `@sheer/domain` consumed **only by the web calendar in the browser**. A "Utilisation Summary" tool needs **new backend wiring** (feed rota shifts − breaks − reducing book-outs vs booked appointment time), not a wrapper — flag as build-work (the engine + tests already exist).
- **Business health / P&L / profit does not exist as an endpoint.** `billing.location_fixed_costs` exists but its consumer is Week 7-8 ("Week 7 P&L reads…", `0053:140-141`) and unbuilt. "Business Health" today = **revenue/activity/margin assembled from dashboard KPIs + lab margins**, with **no cost/profit line** — label it honestly.
- **Retention/churn** — only "new vs repeat clients in range" exists; the `analytics` schema is empty. A genuine gap.
- **Rebooking has no report endpoint** — `apps/api/src/rebooking` is a write-linker with no controller. A "Rebooking Summary" tool wraps dashboard/KPI, not `rebooking`.

**Core Phase 1 tool mapping (read-only, permission-re-checked):** Business Health Summary → `DashboardService.kpis` (+ `LabAnalyticsService.summary` if `report.lab_analytics.view`), labelled "revenue & activity health" not P&L; KPI/Reporting Summary → `KpiService.stylistList` (variant by held permission, commission redacted otherwise); Rebooking Summary → dashboard/KPI reducers over `rebook_source`; Utilisation Summary → **deferred/build-work**; Stylist Performance Summary → `DashboardService.stylistPerformance`; Personal Stylist Coaching Summary → `KpiService.myKpi` (own-data only, never accept a `staffProfileId` argument). Also surface `StylistKpiResult.notes` data-quality flags (`no_hours_worked`, `retail_attribution_approximate`, …) so ZAC never presents a degenerate 0 as truth.

---

## Booking/Rebooking/Client Data

**Appointments (VERIFIED).** `booking.appointments` (`0004:78-103`) carries `business_id`, `location_id`, `client_profile_id`, `assigned/requested_staff_profile_id`, `status`, `booking_channel`, timestamps, notes. The **8-value status enum** (post-`0045`): `pending, accepted, rejected, checked_in, awaiting_payment, paid, cancelled, no_show`. Visits (`booking.visits`) are the settlement/attendance object and the KPI/rebooking source of truth.

**Rebooking (VERIFIED).** `booking.rebooking_outcomes` (`0027`) — one row per source visit, unique on `source_visit_id`, with the **`rebook_source` attribution hook** (`CHECK IN ('stylist','client')`). `RebookingService` is a pure in-process linker (no controller); the *rate* is read back by dashboard/KPI. Overdue-client signal: the inverse of `clientAlreadyRebooked` (`notification-dispatch.service.ts:254-277` — a client whose latest completed visit was > interval days ago with no future active appointment), combined with the per-service nudge interval (`services.rebooking_nudge_interval_days`, `0062`). **Reuse these primitives — don't invent parallel ones.**

**CRM (VERIFIED).** `core.client_profiles` (one per business/user), immutable business-unique `client_code` (the stable, PII-free handle ZAC should reference), `crm.client_notes/allergy_records/patch_tests/visit_photos/gdpr_requests`. `CrmService.getClientDetail`/`listClients` are the reference for **app-layer scoping**: role gate (`assertStaffRole` blocks client-only users), business gate (`.eq('business_id', actor.businessId)`), location gate (`resolveReadableLocationIds` → `.in('primary_location_id', allowedLocationIds)`), and row gate + stylist widening (`fetchClientForActor` returns a client only if owner, or the client is in an allowed location, or the stylist has a past appointment/visit with them). `is_customer` lives on `core.user_profiles`, not `client_profiles` (`0067`).

**Cancellation/no-show/refund (VERIFIED).** Lifecycle actions live in `lab-appointments` (which also hosts the customer-facing `mobile/appointments` controller — a naming trap). Cancellation window = `location_settings.cancellation_notice_hours`; client self-cancel: outside window → refund, inside → deposit forfeited. **`no_show` is never written by any code path** — it appears only in reads — so no-show analytics are structurally ~0 and ZAC must flag them as not-yet-captured.

**What's safe for ZAC + data-quality limits.** Safe read data: appointment status/history, rebooking outcomes, client profiles/history/alerts, cancellation timestamps — **all via the guarded `CrmService`/`LabAppointmentsService`/dashboard/KPI methods**, which scope PII by `business_id` + `location ∈ allowedLocationIds` + role and hard-block client-role users. **Do NOT read raw tables via the acting user's JWT + RLS** — RLS here is a conservative backstop that doesn't model stylist CRM/desk access at all, so a JWT read would give a stylist *less and inconsistently* than the product actually grants them. **Limitations to bake into ZAC's grounding rules:** `no_show` ≈ always 0; `rebooking_outcomes` is a lower bound (single row per visit, only two flows populate it); `segments` are usually empty (`'[]'`); billing totals are now multi-row per visit (`0070` split-tender — must be summed); duplicate client profiles per business are possible (key on `client_code`, don't assume one profile = one person). **Attribution hooks are read-only in Phase 1:** `rebook_source` cannot legally be `'zac'` (CHECK constraint) and `booking_channel='api'` is already used by the public deposit flow — for Phase 1 ZAC records nothing and simply reads these fields.

---

## Staff/Stylist Performance Data

**Staff model (VERIFIED).** `core.staff_profiles` — one per business/user, single `primary_location_id` (a stylist is single-location; scoping = "their one primary location"), `is_bookable` (the load-bearing bookable/residual flag), `hourly_rate`, `contracted_hours`, `average_bill_benchmark`, `q_code` (immutable 8-char provider id), and pay/target columns from `0054/0056/0060`. **⚠ Those target/commission columns (`performance_target_amount`, `performance_target_mode`, `commission_structure`, `commission_flat_rate_percent`) are stored but the live KPI engine ignores them** — it computes the target as `hourlyRate × 3 × hoursWorked` (`kpi.calc.ts:210-213`). They await a not-yet-built "Week 3 pay engine." **ZAC must present the *computed* target, not these columns.** Staff↔auth mapping: `staff_profiles.user_profile_id` → `AuthUser.staffProfileId`. Performance is measured on visits (`visits.primary_staff_profile_id`).

**KPI engine metrics (VERIFIED — per-stylist, per-window):** net worked hours (interval-set algebra over shifts − leave − absence − unpaid breaks), service/retail/avg-bill targets, rebooking KPI (≥50%, stylist vs client split), commission (tiered 10/15/30%), `allKpisMet`, and data-quality `notes`. Retail degrades to 0 if `retail_sales` is unavailable; avg-bill counts only `paid` visits while rebooking counts `awaiting_payment|paid|completed` — **different visit populations; ZAC narratives must not conflate them.**

**Rota/utilisation.** `rota.shifts/shift_breaks/leave_requests/absence_events` are the availability source of truth; `book_out_types` (`0061`) carry `blocks_appointments`/`reduces_available_hours`/`counts_as_paid_time` flags. **No server-side utilisation endpoint exists** (see Reporting section).

**Visibility matrix (VERIFIED) — what ZAC may surface per role:**

| Data | OWNER | MANAGER | STYLIST (self) |
|---|---|---|---|
| Team KPI (hours/targets/rebooking/retail/avg-bill) | business-wide, all locations | only `allowedLocationIds` | own only via `/kpi/me` |
| Commission | yes | yes if `report.commission.view` (manager default has it) | own only |
| Pay/rate/target on staff record | yes (`staff.pay.manage`) | only if `staff.pay.manage` — **NOT in manager default** | not exposed to self here |
| Rota | business-wide | own locations | own week only |
| Audit trail | business-wide | own location | none |

**Key asymmetry to encode:** managers are location-scoped and do **not** hold `staff.pay.manage` by default — they can see performance/commission for their location's stylists but not raw pay rates.

**Protecting private stylist coaching memory — the first "owner cannot read this" boundary.** The whole area is business/location-scoped for owners/managers; any table an owner/manager query can reach is readable by them. Private coaching memory therefore needs a **new isolation boundary**:

1. A dedicated `zac.stylist_coaching_notes (id, business_id, staff_profile_id, author='zac', body_redacted, created_at)` with RLS granting SELECT **only to the owning stylist's own user** (`staff_profile → user_profile_id = current_user_id()`), **no owner/manager SELECT policy at all**, and service-role-only writes (mirrors the `rota`/`audit` write model).
2. Because ZAC's own writer is service-role (bypasses RLS), the note-**body** read path must be a **distinct service method reachable only from the stylist-self tool**, keyed strictly on `actor.staffProfileId`, and **structurally impossible to call from the team/manager/owner tool.**
3. Owners/managers get **aggregate/themes only** (D26/D42) via a separate function that returns no attributable note text — a hard rule mirroring `assertSensitiveStaffFields`.

**Tool contracts:** *Team Performance Summary* (owner/manager; `report.performance.view` + `zac.access`; commission only if `report.commission.view`; pay only if `staff.pay.manage`; owner → all locations, manager → `allowedLocationIds` with out-of-scope rejection; never note bodies). *Personal Stylist Coaching Summary* (stylist; require `actor.staffProfileId`; `zac.access` only, no `report.*`; hard-key every query on `actor.staffProfileId`, never accept a `staffProfileId` argument; own KPI + own rota + own private coaching notes).

---

## QLAB/Stock/Inventory Feasibility

**Applied-state (VERIFIED against dev-test branch `iqgryrczkvjkcbrgfsdl`).** The newest applied migration is **`0062`** — therefore `0063_formula_record_model`, `0068_formula_notes_persist`, `0069_formula_draft_save`, and `0070_salon_payments_split_tender` are **NOT applied** and are actively-developed V1.1 work (corroborated by memory: `formula-draft-save-model`, `split-tender-checkout`). Anything reading `lab.formulas.notes/version/service_name_snapshot/status='draft'` is reading a schema that doesn't exist in the target environment. **Production parity must be re-verified before freezing tool contracts (QC8).**

**What exists and is stable:**

- **`lab-analytics` — the single cleanest intelligence surface (STABLE).** `GET /lab/analytics/summary` → `LabAnalyticsService.summary`, guarded owner/manager + `report.lab_analytics.view`, location-scoped. Computes in-process from `lab.formulas`/`formula_items`: colour revenue, formula cost, **gross margin %**, **waste cost + waste % of revenue**, worst-margin location, per-location/stylist/service-type breakdowns, most-used products by weight/cost, open low-stock alerts. It filters `status='saved'`, so it is **immune to the un-applied draft-save work.** Correctness depends only on applied migrations; *meaningfulness* depends on whether the salon actually mixes formulas in the Lab (likely sparse early).
- **Inventory low-stock + catalogue (STABLE).** `inventory.products/location_stock/stock_movements/low_stock_alerts/categories` (applied `0021/0024/0036-0038`). Low-stock is computed two ways: **live** from `location_stock` (`dashboard.inventoryAlerts` / `inventory.isLowStock` — prefer this) and **materialised** `low_stock_alerts` rows (can lag). Reads: `inventory.listStock/listLowStock/listProducts/listCategories` (owner/manager + `inventory.manage`).

**What is incomplete / empty / absent:**

- **Formula record-model / notes / drafts / history-record features** — un-applied `0063/0068/0069`; the existing `historyForClient` read even *assumes* the `0063` `notes` column exists (`SAVED_FORMULA_COLUMNS`). **Do not build on these in Phase 1.**
- **Retail sales (`billing.retail_sales`)** — schema stable but **effectively empty with no UI writer**; the KPI engine itself defends against the table being absent. **Do not surface retail insights.**
- **`inventory.waste_events`** — **write-only**, no read layer, churned on every formula re-save. **Get waste from `lab-analytics` `wasteCostCents` instead**, never from `waste_events`.
- **Suppliers / purchase orders / reorder points / lead times / expiry / forecasting** — **do not exist anywhere** (confirmed by grep). No data model to read.

**Feasibility verdict.** **FEASIBLE now (read-only, backed by applied schema + existing guarded services):** colour economics (revenue/cost/margin/waste %/breakdowns/most-used products) via `LabAnalyticsService.summary`; low-stock "what's low right now" and current stock levels/catalogue via inventory reads; descriptive fast/slow-moving ranking over a window (from most-used products + `stock_movements`, **not** a trend/prediction). **DEFER (no data model and/or predictive):** ordering forecasts, over-ordering detection, stock-holding optimisation, automated ordering, expiry/shelf-life, retail performance, formula version/draft analytics, burn-rate/days-of-cover prediction.

**Week-1 vs Week-2/3 recommendation.** Treat QLAB/stock as **Week-1 feasibility-only** — a read pass with a **data-population probe** ("does this business have saved formulas / initialised stock + thresholds in the window?"). Then in **Week 2/3 expose exactly two read tools**: (1) colour/lab-analytics summary (gate on the population check to avoid confidently reporting zeros), and (2) inventory low-stock + stock levels. Everything else defers. This keeps ZAC clear of the in-flight V1.1 lab work it must not disrupt.

---

## Audit/Event/Logging Pattern

**`audit.activity_log` (VERIFIED — `0058`).** Columns: `business_id (not null)`, `location_id`, `actor_user_profile_id`, `actor_role (core.membership_role_enum, nullable)`, **`action` (free text)**, **`entity_type` (free text)**, `entity_id`, `before/after/metadata jsonb`, `created_at`. `action`/`entity_type` are deliberately free text ("new actions never require a migration; validated by the API"), so `'zac.report.accessed'` is accepted today with no schema change. **There is no generic `actor_type` and no non-human 'agent' actor** — `actor_role` is limited to `owner/manager/stylist/client` and `actor_user_profile_id` FKs to a real profile. The table is **append-only / tamper-evident** (RLS allows only owner/manager SELECT; only service-role inserts).

**`AuditService.record` (VERIFIED).** Signature `record(actor: Pick<AuthUser,'id'|'businessId'|'primaryRole'>, params)`. Writes via a **service-role** client, mapping `actor.id → actor_user_profile_id`, `actor.primaryRole → actor_role`. **Fail-soft:** the insert is wrapped in try/catch that only `logger.error`s — *"never throws … failures are logged and swallowed."* Coverage today is **sparse and mutation-only** (8 actions across 6 services); **no read is ever audited.** Read endpoint: `GET /api/audit/events` (owner/manager + `audit.read`), service-role read scoped by `.eq('business_id', actor.businessId)`, also fail-soft.

**Application logging (VERIFIED).** Nest `Logger` only (`error|warn|log`; `debug/verbose` disabled), stdout destination, **no Sentry/Datadog/OTel**. **The global `RequestResponseLoggingMiddleware` logs full request `originalUrl` + redacted query/body on request and the redacted response body on finish — but redaction is key-name-based over only 8 fixed auth keys** (`authorization, cookie, password, token, access_token, refresh_token, apikey, api_key`). **It does not redact PII, and a ZAC prompt/answer field is not in that set** — so prompts and model responses would be dumped verbatim to stdout. This is the single biggest logging risk for ZAC. Comms tables (`comms.notification_events`, `comms.message_logs` with `content_preview`, `comms.messaging_usage_counters`) are a structural precedent (service-role writer + RLS + `business_id` + preview-not-body) but are the wrong domain to reuse.

**Recommended Phase 1 logging approach:**

1. **Log ZAC telemetry to SEPARATE `zac.*` tables, NOT `audit.activity_log`** (D27). ZAC produces high-volume operational telemetry (tokens, tool calls, latency, cost) with a different lifecycle, retention, and query pattern; mixing would pollute the owner compliance view and bloat the tamper-evident indexes. Use `zac.interaction_events` + `zac.cost_events` in their own schema with independent, prunable retention.
2. **Mirror only a thin slice into `audit.activity_log`, attributed to the human.** Phase 1 is read-only, so almost nothing belongs in the compliance trail; the one candidate is **permission-sensitive reads** (surfacing financials/commission/audit on the user's behalf → one coarse row `action:'zac.report.accessed'`, `entity_type:'zac'`). **Preferred, zero-migration:** reuse `AuditService.record` unchanged and flag machine origin in `metadata: { via:'zac', model, requestId }`, keeping an accountable human on the record. Only if a distinct non-human actor is ever *mandated* would a schema change be needed (add `'agent'` to the enum / an `actor_type` column) — **do not do this in Phase 1.** Any future ZAC *write* (Phase 2) mirrors like every human mutation.
3. **Add alerting — do not rely on fail-soft alone.** Audit writes are swallowed to a stdout `logger.error`; a silently-failing ZAC cost writer would let spend run unbounded and invisibly. Emit a distinct high-severity signal on write failure and on cost-threshold breach.
4. **Keep raw prompts/responses out of logs by default** (D32) — exclude ZAC routes from the global middleware (adjust `forRoutes`/`exclude` in `app.module.ts:86`) or add the prompt/response field names to `SENSITIVE_KEYS`, **before the first ZAC endpoint ships**; persist token counts/tool names/metadata, not verbatim content.

---

## Feature Flag and UI Entry Considerations

**There is no general feature-flag system (VERIFIED).** The only real flag file is `apps/sheer-lab/src/config/featureFlags.ts` (build-time boolean consts, consumed at 7 hand-maintained nav sites — the "hide the nav entry, keep the route/module" pattern). **Web has no flag layer at all** (`apps/web/src/config/` holds only `mobileApp.ts`, `timezones.ts`). Mobile client/stylist app (`sheer-app`) is **role-only and never reads `user.permissions`.** There is **no per-tenant/per-user feature/entitlement store** in the DB (the only per-tenant dimension is `businessTier`; the only per-user dimension is security levels).

**Web navigation (VERIFIED).** react-router 6. Two gates: **route tree** — every dashboard route wrapped in `<ProtectedRoute allowedRoles requiredPermissions>` (`App.tsx:107-179`; `ProtectedRoute` checks role then `userHasAllPermissions`); **sidebar** — a declarative `NAV` array filtered by `filterNav` on role AND permission AND `hideForTiers` (`Sidebar.tsx:37-78`). **Appending one `NAV` entry cannot reorder or hide any existing V1.1 item** — a clean, additive insertion point. **No admin/internal-only surface exists** — the highest privilege is `owner`; ZAC must be a first-class, per-business, permission-gated feature.

**Two dynamics that force "gate on BOTH permission and flag":**

1. **Owners auto-hold `zac.access`** the instant it enters the catalogue (`auth.service.ts:603-604`) — so **the permission cannot keep ZAC dark; a feature flag is the real kill-switch.**
2. **Unknown permission keys are dropped** from stored security levels — so per-user granting to non-owners *requires* the catalogue add (which in turn auto-grants owners).

**Safest Phase 1 UI entry (web-only recommended):**

- **Backend kill-switch:** add `ZAC_ENABLED?: string` to `EnvConfig`, mirroring the existing `COMMS_DISPATCH_ENABLED` pattern (`env.validation.ts:222-225`); when `"false"`, ZAC routes short-circuit/404 platform-wide with no client rebuild.
- **Web flag:** add `VITE_ZAC_ENABLED` read via `import.meta.env` (add to `turbo.json:globalEnv`), on in dev/staging, off in prod until launch.
- **Web entry:** one `NAV` entry (`{ to:'/zac', allowedRoles:['owner','manager'], permission:'zac.access' }`) wrapped in the flag check, plus one route inside the existing owner/manager `DashboardLayout` block wrapped in `<ProtectedRoute allowedRoles={['owner','manager']} requiredPermissions={['zac.access']} />` and guarded by the same flag (falls through to the catch-all when dark). Additive, no reorder, no disruption to V1.1 nav.
- **Defer the stylist mobile surface** (sheer-app is role-only; a permission-gated entry would be the first `userHasPermission` consumer there — a new pattern). **Do not target the lab app** (PIN lab-session, not JWT; `assertSurfaceAccess` restricts it to staff). Ship **web-only** in Phase 1; add the stylist mobile tab later behind `EXPO_PUBLIC_ZAC_ENABLED` + `userHasPermission`.
- **Per-tenant enablement is out of Phase 1 scope** (no DB mechanism; adding one is migration churn against the roadmap). Phase-1 targeting = **global env/build flag × per-user `zac.access`**.

---

## Recommended ZAC Backend Architecture

ZAC is a **server-side, permission-aware, evidence-grounded intelligence module inside the QLOOQO API** (D1). The request pipeline (A1) is:

```
Authenticated QLOOQO user (Bearer JWT)
  → ZacController  (@UseGuards SupabaseAuthGuard, RolesGuard, PermissionsGuard; @RequirePermissions 'zac.access')
  → @CurrentUser() actor: AuthUser            // acting-user context, resolved once
  → ZacContextService (context assembler)     // minimum relevant context only (A2)
  → RoleProfileService (role profile selector) // owner/manager/stylist behaviour + terminology
  → ZacToolRegistry (permission-aware)         // tools derived from actor.permissions BEFORE model runs (D3)
  → ModelRouter (provider-agnostic)            // fast tier default; latest Claude first provider (A3)
  → ResponseBuilder                            // evidence-grounded contract (A4/D5/D6)
  → Memory + Measurement + Cost logging (zac.* tables)  // spine from day one (D7/D44)
```

**Load-bearing principles (all grounded in verified code):**

- **Acting-user JWT, never a broad service-role handle (D2).** ZAC reuses `SupabaseAuthGuard` → `AuthService.resolveAuthUser`; the resolved `AuthUser` is the single object every tool and model call is keyed on. ZAC opens **no** Supabase client for reasoning reads.
- **Compose guarded services, then re-check the permission key.** Because the platform has no JWT/RLS data path and the services skip the permission-key check, ZAC's tools **inject and call the existing `*Service` methods** (inheriting their role + location + `business_id` scoping) **and independently re-assert the endpoint's permission** with `userHasAllPermissions(actor, [...])`. This resolves the open question QC2 to: *call injected services (not loopback HTTP), and replicate the controller's permission gate inside each tool.* Belt-and-braces: permission-key check in ZAC + role/location check in the service.
- **Structural read-only (D4).** The tool registry registers **zero write tools**; ZAC has no mechanism to mutate business data even if asked. Writes to ZAC's *own* `zac.*` telemetry/memory tables are not business writes and are expected (measurement spine, feedback).
- **The model does no arithmetic (D5).** ZAC narrates numbers from the deterministic KPI engine and report endpoints and attaches evidence; it never recomputes a KPI from memory.
- **Provider-agnostic model router (A3).** Providers sit behind `model-provider.interface.ts`; the first provider targets the **latest Claude models** (`claude-opus-4-8` / `claude-sonnet-5` / `claude-haiku-4-5` per current model IDs); fast tier by default, reasoning escalation only on complexity signals, every call logged to `zac.cost_events`.
- **FORCE-RLS on ZAC's own schema** — the one place the platform's dormant-RLS posture is worth strengthening.

---

## Proposed Module/File Structure

At `apps/api/src/zac/` (auto-compiled; register `ZacModule` in `app.module.ts` imports). Follows the house single-file-service convention plus focused sub-folders for the new concerns (aligned to Day 2 §6):

```
apps/api/src/zac/
  zac.module.ts            // imports: [AuthModule, KpiModule, DashboardModule*, CrmModule,
                           //           LabAnalyticsModule, InventoryModule, RotaModule]
                           // controllers: [ZacController]; providers: [ZacService, ...]
  zac.controller.ts        // @Controller('zac') + 3-guard chain + @RequirePermissions('zac.access')
  zac.service.ts           // orchestrator; NO createClient(service_role) for reads
  dto.ts                   // class-validator DTOs (AskZacDto, ZacFeedbackDto, ...)

  context/
    zac-context.service.ts     // Context Assembler — minimum relevant context from AuthUser
    role-profile.service.ts    // Role Profile Selector — owner/manager/stylist prompts + terminology
    scope-resolver.service.ts  // derive business/location scope from AuthUser; reject out-of-scope

  tools/
    zac-tool-registry.ts       // permission-aware registry; filters tools by actor.permissions
    tool-contract.ts           // the 14-field typed tool contract (read_or_write='read')
    report.tools.ts            // Business Health, KPI/Reporting, Stylist Performance, Rebooking
    kpi.tools.ts               // Personal Coaching (own-data), commission (redacted by permission)
    qlab.tools.ts              // (Week 2/3) colour analytics summary — gated on population probe
    inventory.tools.ts         // (Week 2/3) low-stock + stock levels

  models/
    model-router.service.ts
    model-provider.interface.ts
    anthropic-provider.ts      // first provider — latest Claude
    model-pricing.config.ts    // configurable pricing constants (D33) — no hardcoded vendor prices

  response/
    response-builder.service.ts   // evidence-grounded answer + recommendation contracts
    response-contracts.ts         // typed JSON shapes (Day 2 §9)

  memory/
    zac-memory.service.ts         // Context Memory (scopes) + private stylist coaching read path
  measurement/
    zac-events.service.ts         // the minimum measurement spine
    cost-telemetry.service.ts     // per-call cost events
    kpi-snapshot.service.ts       // (design; runs when a scheduler exists) zac.kpi_snapshots
    outcome-attribution.service.ts// (design) Observed/Influenced/Directly Attributable

  qlab/
    qlab-feasibility.service.ts   // Week-1 read pass + data-population probe (go/no-go)

  prompts/
    constitution-policy.ts        // truth/loyalty/integrity/privacy/humanity + hard boundaries (D40)
    role-prompts.ts

  zac.service.spec.ts             // jest, mirroring kpi.calc.spec / permissions.guard.spec
```
`*` `DashboardModule` needs a one-line `exports: [DashboardService]` add if injected.

Naming conventions (house style): kebab-case files; `PascalCase` classes suffixed `Module`/`Controller`/`Service`/`Dto`; route prefix without `api/`; `@CurrentUser() actor: AuthUser`; per-class `Logger(ZacService.name)`; standard `HttpException` subclasses; `NotFound`-before-`Forbidden`. Shared ZAC types (chat message shapes, tool result envelopes, the `zac.access` key) belong in `@sheer/domain` so a future web UI shares one contract.

---

## Proposed API Endpoints

Minimal, read-only surface (served under the global `api` prefix). Writes are only to ZAC's own telemetry/feedback tables, not business data.

| Method + path | Roles | Permission | Purpose |
|---|---|---|---|
| `POST /api/zac/ask` | owner, manager | `zac.access` | Main Q&A. Body `{ question, conversationId? }`. Runs the pipeline; returns the evidence-grounded answer contract. Creates `zac.conversations`/`zac.messages`, logs spine + cost events. |
| `GET /api/zac/capabilities` | owner, manager | `zac.access` | Returns the role-profile + the tools the actor can actually use (derived from `actor.permissions`) — lets the UI render correctly and prove permission-awareness. |
| `POST /api/zac/feedback` | owner, manager | `zac.access` | "Did this help?" (D24) → writes `zac.feedback`. A learning signal, not a business mutation. |
| `GET /api/zac/conversations` / `/:id` | owner, manager | `zac.access` | (Optional Phase 1) retrieve the actor's own conversation history, business+actor scoped. |
| `GET /api/zac/health` | (excluded from prefix, or `zac.access`) | — | Liveness of the ZAC subsystem (provider reachable, flag state). |

All endpoints: guard chain `SupabaseAuthGuard, RolesGuard, PermissionsGuard`; class-level `@RequireRoles('owner','manager')` + `@RequirePermissions('zac.access')`; `@CurrentUser() actor: AuthUser`; DTOs validated by the global pipe (bounded `@MaxLength` on `question` to constrain input). Gate the whole controller behind the `ZAC_ENABLED` env kill-switch. **Stylist endpoints are deferred** (web-only Phase 1); when added, the personal-coaching route uses `@RequireRoles('stylist')` with self-scoping and no `report.*` requirement.

---

## Proposed Tool Registry Design

Tools are **controlled contracts, permission-gated before the model runs** (D3/D31). Each tool declares the Day 3 §6 fourteen-field contract as a TypeScript type, with `read_or_write` fixed to `'read'` and `phase_allowed` to `1`:

```ts
interface ZacToolContract {
  tool_id: string;                 // e.g. 'report.business_health'
  domain: 'report' | 'kpi' | 'crm' | 'booking' | 'qlab' | 'inventory';
  purpose: string;
  required_permissions: Permission[];   // re-checked against actor BEFORE dispatch
  allowed_roles: UserRole[];            // 'client' never present
  input_schema: ZodOrClassValidator;    // bounded; no raw business/location id trusted from the model
  output_schema: unknown;               // the existing service response type
  evidence_schema: unknown;             // source_type, source_ref, as_of, entities_used (no raw PII)
  pii_level: 'none' | 'low' | 'high';
  cache_policy: { ttl_s: number; per_tenant: true };   // per-tenant cache keys ONLY (D17)
  rate_limit: { per_min: number };
  source_of_truth: string;              // e.g. 'KpiService.stylistList / kpi.calc.ts'
  read_or_write: 'read';                // Phase 1 invariant
  phase_allowed: 1;
}
```

**Registry rules:**

1. **Availability is derived from `actor.permissions[]`, never decided by the model.** `buildRegistryFor(actor)` returns only tools whose `required_permissions` the actor holds (`userHasAllPermissions`) and whose `allowed_roles` include one of `actor.roles`.
2. **Every tool re-checks `required_permissions` at dispatch** (defence-in-depth against the service-layer permission gap) and re-asserts `zac.access`.
3. **No write tools are registered** — the deferred write set (`create_booking_tool`, `cancel_booking_tool`, `send_whatsapp_tool`, `update_stock_tool`, `edit_client_profile_tool`, `change_service_price_tool`, `approve_refund_tool`, `create_campaign_tool`, …) is enforced *by absence*.
4. **Tools call injected `*Service` methods with the acting `AuthUser`** and return the existing typed response as evidence — never issue their own SQL, never accept a model-supplied `business_id`/`locationId` without validating it against `actor.allowedLocationIds`.

**Phase 1 registered tools (all read):**

| tool_id | required_permissions | wraps | notes |
|---|---|---|---|
| `report.business_health` | `report.dashboard.view` (+ `report.lab_analytics.view` optional) | `DashboardService.kpis` (+ `LabAnalyticsService.summary`) | "revenue & activity health", not P&L |
| `report.kpi_summary` | `report.commission.view` **or** `report.performance.view` | `KpiService.stylistList` | commission stripped unless `report.commission.view` |
| `report.stylist_performance` | `report.performance.view` | `DashboardService.stylistPerformance` | booking/revenue-centric |
| `report.rebooking_summary` | `report.dashboard.view` | dashboard/KPI reducers over `rebook_source` | no-show ≈ 0 (never written) |
| `kpi.personal_coaching` | (none) `zac.access` + `roles∋stylist` | `KpiService.myKpi` | own-data only; deferred to a later stylist surface |
| `crm.client_lookup` | `crm.view` | `CrmService.getClientDetail`/`listClients` | PII scoped by the service; key on `client_code` |
| `qlab.colour_analytics` *(Wk2/3)* | `report.lab_analytics.view` | `LabAnalyticsService.summary` | gate on population probe |
| `inventory.stock_status` *(Wk2/3)* | `inventory.manage` (or `report.dashboard.view` for live alerts) | `InventoryService.listLowStock/listStock` | prefer live low-stock |
| `report.audit_read` *(optional)* | `audit.read` | `AuditService.list` | |

*Utilisation is intentionally absent — it has no server endpoint and needs new backend wiring (build-work, not a wrapper).*

---

## Proposed ZAC Data Model

**Recommendation: a dedicated `zac` schema with RLS ENABLED and FORCED**, added as migration `0076_zac_foundation.sql` (next free number after the in-flight payroll `0071`–`0074`; file-based; also add `zac` to `config.toml` and each hosted project's Exposed Schemas). This reconciles the task's `zac_*` table list with the Phase 0 `zac.*` schema proposal (D16/D30) — the `zac_*` names map to `zac.*` tables. Every table: `business_id uuid not null`; `location_id uuid null` where genuinely location-scoped; `actor_user_id uuid` (= `AuthUser.id`); `role_context text`; `visibility_scope text` (`all|locations|self`); `created_at` (+ `updated_at` where mutable); metadata/telemetry, **not raw prompts/responses by default**.

| Task name | Recommended table | Key columns (beyond the common set) |
|---|---|---|
| `zac_conversations` | `zac.conversations` | `title?`, `topic?`, `status`, `started_at`, `ttl_expires_at?` |
| `zac_messages` | `zac.messages` | `conversation_id`, `role` (`user\|assistant\|system\|tool`), `content_ref`/`content_redacted`, `token_count`, `model` |
| `zac_message_events` | `zac.message_events` *(optional split)* | `message_id`, `event_type`, `payload_meta jsonb` (metadata only) |
| `zac_tool_calls` | `zac.tool_calls` | `conversation_id`, `message_id`, `tool_id`, `args_meta jsonb` (param summary, no dumps), `result_status`, `result_row_count`, `latency_ms`, `error_code?` |
| `zac_memory_items` | `zac.memory` | `scope` (`private_user\|role_scoped\|business_shared\|location_scoped\|system`), `kind`, `content_redacted`/`content_ref`, `source_conversation_id?`, `created_by`, `source`, `expires_at?` |
| — (private coaching) | `zac.stylist_coaching_notes` | `staff_profile_id`, `author='zac'`, `body_redacted` — **RLS: owning stylist's own user only; NO owner/manager SELECT** |
| `zac_outputs` / `zac_insights` | `zac.recommendations` (internal term for Insight/Coaching Point/Opportunity/Risk/Watch Point) | `type`, `title`, `recommendation`, `why`, `evidence jsonb`, `expected_outcome`, `metric_to_measure`, `target_entity_type`, `target_entity_id?`, `confidence`, `status`, `measurement_window_days` |
| — | `zac.recommendation_events` | `recommendation_id`, `event_type` (`created\|shown\|accepted\|dismissed\|ignored\|expired`) |
| `zac_feedback` | `zac.feedback` | `message_id`/`recommendation_id`, `rating`, `comment_redacted?` |
| `zac_outcome_events` | `zac.observed_outcomes` + `zac.recommendation_outcomes` | `outcome_type`, `target_entity_type/id?`, `observed_value`, `estimated_financial_value_cents`, `confidence`, `attribution_type`, `evidence jsonb`, `observed_at`; `recommendation_id` **nullable** (outcomes tracked even when unlinked) |
| `zac_cost_events` | `zac.cost_events` | `conversation_id?`, `task_type`, `model_provider`, `model_name`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `estimated_cost`, `latency_ms`, `tool_calls_used`, `cache_hit`, `recommendation_generated`, `unit_type`, `period` (no prompt/response text) |
| — | `zac.kpi_snapshots` | `location_id?`, `staff_profile_id?`, `period`, `metric`, `value` — periodic captures of the deterministic engine (D30; the longitudinal "1% better" spine) |
| — | `zac.knowledge_documents` | `title`, `document_type`, `content`/`source_uri?`, `tags`, `visibility_scope`, `role_scope`, `effective_from`, `expires_at?`, `confidence_level`, `status` — rule-based/metadata retrieval first; vectors deferred (D29) |

**Attribution reuses existing hooks, does not invent new ones:** `booking.rebooking_outcomes.rebook_source` (read-only in Phase 1 — CHECK excludes `'zac'`) and `booking.appointments.booking_channel` (`'api'` already taken). Directly-Attributable value joins on these when present; otherwise Observed/Influenced per the Day 4 decision tree.

---

## Proposed Memory/Outcome/Cost Logging Design

**Measurement spine from day one (D7/D44 — the non-negotiable core).** Even though Phase 1 is read-only, ZAC records from the first interaction (unrecoverable if not captured): `conversation_started`, `question_asked`, `answer_delivered`, `source_used`, `recommendation_created/shown/accepted/dismissed/ignored`, `kpi_snapshot_created`, `observed_outcome_recorded`, `cost_recorded`. Implemented by `ZacEventsService` (fail-soft writer confined to `zac.*`, `business_id`-scoped, **with alerting** — because the audit precedent silently swallows failures).

**Context Memory vs Outcome Memory (D13 — kept separate).** *Context Memory* ("what ZAC knows about this person/business") uses the five scopes: `private_user_memory`, `role_scoped_memory`, `business_shared_memory`, `location_scoped_memory`, `system_memory`. Rules (enforced by query filters + the memory-scope column, **not** solely by prompt): stylist private coaching memory is **never** visible to owners/managers by default (D25/D41 — the dedicated `zac.stylist_coaching_notes` table with no owner/manager SELECT policy); location-scoped memory must not leak across locations; memory always includes `business_id`, `created_by`, `source`, and is deletable/reviewable per privacy policy. *Outcome Memory* ("what actually happened, did it create value") is a distinct store with honest attribution.

**Attribution & confidence (D15/D21/D22).** Implement the Day 4 §4.4 decision tree as a typed post-processor: *item shown for this entity in the window?* → No ⇒ **Observed**; Yes + strong single-cause link ⇒ **Directly Attributable**; Yes + contributory ⇒ **Influenced** (apply a discount factor). Confidence (High/Medium/Low) is **derived** from data completeness, attribution strength, sample size, window fit, prior outcomes — presented *alongside* value, never hidden inside it. The **seven-part evidence rule** (source · metric changed · evidence · attribution · confidence · method · limitations) is enforced as a contract: a claim missing any part is flagged or withheld.

**Cost telemetry (D33).** Every model call → `zac.cost_events` (fields above), driven by `CostTelemetryService` behind the model router. **No hardcoded vendor prices** — pricing constants live in `model-pricing.config.ts`, refreshed from official pricing pages before commercial sign-off. Enforce cost controls from launch: fast-tier default with reasoning escalation only on complexity signals (log `zac.model.escalated`), **per-tenant** prompt/tool caching only (D17 — never cache one tenant's data into another's call), summary memory over transcripts, per-tenant budgets, and the Day 4 §21 optimisation triggers (report generated-not-opened, input-tokens-per-call trending up, token growth outpacing active users). Value-Created output is scoped to the **nine "Ready" categories** (Revenue Influenced, Rebooking, Bookings Recovered, Utilisation, Client Retention proxy, Staff Development, Time Saved, Management Hours Saved, Subscription ROI); Blocked/Partial categories render *"no data captured yet"* (Retail is Blocked — table empty).

**Value-Created report & KPI snapshots are design items, not day-one runtime.** There is **no durable scheduler** (only a `setInterval`+DB-lock poller), so the attribution reconciler and periodic `zac.kpi_snapshots` need a job-infra decision (QC/Day 4 §26 Q3) before they run automatically. The Sunday-report integration is explicitly deferred (Day 4 §11).

---

## QLAB/Stock Read-Only Foundation Plan

**Week 1 = feasibility-only, no tools.** A `QlabFeasibilityService` runs a read pass over the applied surfaces and a **data-population probe** per business/location:

1. Confirm applied schema in the *target* environment (dev-test newest = `0062`; `0063/0068/0069/0070` unapplied) and **re-verify prod parity (QC8)** before any tool ships.
2. Probe population: does the business have `lab.formulas` with `status='saved'` in the window? Initialised `inventory.location_stock` with thresholds? Any `billing.retail_sales` rows (expected: none)?
3. Produce a go/no-go per signal.

**Week 2/3 = expose exactly two read tools, both delegating to existing guarded services with the acting `AuthUser`:**

- `qlab.colour_analytics` → `LabAnalyticsService.summary` (owner/manager + `report.lab_analytics.view`) — colour revenue/cost/margin %, waste cost/% (from `formulas.waste_cost_cents`, **not** `waste_events`), per-location/stylist/service breakdowns, most-used products. Gate on the Week-1 population probe so ZAC never confidently reports zeros for a salon that doesn't use the Lab. Reads `status='saved'` → immune to the un-applied draft work.
- `inventory.stock_status` → `InventoryService.listLowStock` + `listStock` (owner/manager + `inventory.manage`), or `DashboardService.inventoryAlerts` for the **live** low-stock view (`report.dashboard.view`).

**Deferred (no data model / predictive):** ordering forecasts, over-ordering detection, stock-holding optimisation, automated ordering, expiry/shelf-life, retail insights, formula version/draft/reapply analytics, burn-rate/days-of-cover. **Avoid entirely:** `inventory.waste_events` (write-only, no read layer), the stubbed `lab-formula` methods (`addItem`/`captureWeight`/`recalculate` return hard-coded scaffolds), the lab-session-token analytics variant (Phase 1 is JWT-only), and anything on the `0063/0068/0069/0070` chain (active V1.1 work ZAC must not disrupt).

---

## Week 1 Backend Foundation Implementation Plan

**Goal:** a read-only ZAC skeleton that authenticates as the acting user, resolves context, selects a role profile, exposes a permission-aware (empty-then-minimal) tool registry behind a provider abstraction, returns the evidence-grounded contract, and logs the measurement/cost spine — all behind a flag, with **no write tools and no unrestricted DB access.**

**Tasks & files likely to CREATE (no migration applied this week; DDL designed only):**

- `apps/api/src/zac/zac.module.ts`, `zac.controller.ts` (`POST /zac/ask`, `GET /zac/capabilities`), `zac.service.ts`, `dto.ts`.
- `context/zac-context.service.ts`, `role-profile.service.ts`, `scope-resolver.service.ts`.
- `tools/zac-tool-registry.ts`, `tool-contract.ts`, `report.tools.ts` (wire 1–2 tools: Business Health + KPI Summary).
- `models/model-provider.interface.ts`, `anthropic-provider.ts`, `model-router.service.ts`, `model-pricing.config.ts`.
- `response/response-builder.service.ts`, `response-contracts.ts`.
- `measurement/zac-events.service.ts`, `cost-telemetry.service.ts`; `memory/zac-memory.service.ts` (interface + no-op/log stub if tables not yet applied).
- `qlab/qlab-feasibility.service.ts` (feasibility pass).
- `zac.service.spec.ts`.
- **Design (not applied) drafts:** `packages/domain` `zac.access` addition; `supabase/migrations/0075_zac_access_permission.sql` and `0076_zac_foundation.sql` (next free numbers; `0071`–`0074` = in-flight payroll) **authored for review only, not applied**; `EnvConfig` additions (`ANTHROPIC_API_KEY`, `ZAC_ENABLED`).

**Files likely to INSPECT/reuse (no change):** `auth/{supabase-auth.guard,roles.guard,permissions.guard,current-user.decorator,auth.service}.ts`, `auth/auth.module.ts` (exports all guards); `kpi/{kpi.controller,kpi.service,kpi.calc,dto}.ts`; `dashboard/*`; `crm/*`; `lab-analytics/*`; `inventory/*`; `packages/domain/src/index.ts` (permission catalogue, helpers, `AuthUser`); `common/request-response-logging.middleware.ts`; `config/env.validation.ts`; `app.module.ts`.

**Acceptance criteria (Week 1):**

1. `POST /api/zac/ask` behind `SupabaseAuthGuard + RolesGuard + PermissionsGuard` + `@RequirePermissions('zac.access')`; a user without `zac.access` gets 403; a `client`-role user is denied.
2. The acting-user `AuthUser` is resolved once and threaded through the turn (no per-tool re-auth).
3. The role profile selector returns owner/manager/stylist behaviour + terminology (Insight/Coaching Point/Opportunity/Risk/Watch Point — D19).
4. The tool registry filters tools by `actor.permissions` **and** each wired tool re-checks its endpoint permission; commission is stripped without `report.commission.view`; **zero write tools registered.**
5. The model router calls a Claude provider behind `model-provider.interface.ts`; every call logs a `zac.cost_events`-shaped record (to a table or a structured log until DDL is applied).
6. Responses conform to the evidence-grounded contract (answer, evidence[+as_of], confidence, limitations); the model performs no arithmetic (numbers come from the KPI engine/services).
7. The measurement spine events are emitted from the first interaction.
8. ZAC routes are **excluded from / redacted in** the global request/response logging middleware (no raw prompt/response to stdout).
9. The whole controller is dark behind `ZAC_ENABLED`; `zac.access` alone does not expose it (flag is the kill-switch).
10. QLAB feasibility pass produces a documented go/no-go with a data-population probe; **no QLAB tool exposed yet.**

**Dependencies / prerequisites:** the Cosan technical decisions (below) — especially QC2 (services-vs-controllers, recommended: services + re-check), QC4 (`zac.access` shape), QC5 (snapshot home), QC6 (audit actor), QC7 (PII redaction), QC8 (prod parity); an `ANTHROPIC_API_KEY` set in Railway; agreement that migrations `0075/0076` (next free after the in-flight payroll `0071`–`0074`) are authored-for-review Week 1 and applied in Week 2 after review.

**Responsibilities.** *Cosan (technical lead):* confirm QC1–QC8; own the auth/permission/guard integration and the `zac.access` catalogue + migration design; review the `zac` schema DDL + FORCE-RLS; verify prod parity; sign off the "services + permission re-check" tool pattern; own tenant-isolation review. *Oleksandr:* scaffold the `ZacModule`/controller/service/DTOs; build the context resolver, role-profile selector, tool registry skeleton, model-provider abstraction + first Claude provider, response builder, and the measurement/cost logging stubs; run the QLAB/stock feasibility pass; wire the feature flag; write specs; keep the docs consistent with the Phase 0 decision log.

**What must NOT be implemented yet:** any write tool; any autonomous action; the lab-session/PIN path; the stylist mobile surface; per-tenant enablement store; the durable scheduler / periodic KPI snapshot job / attribution reconciler runtime; Sunday-report integration; vector/semantic retrieval; QLAB/stock read tools (feasibility only); applying migrations `0075/0076` (design + review first). Do not touch `packages/domain` without rebuilding its dist; do not add any `APP_GUARD`/`APP_FILTER`/`APP_INTERCEPTOR`; do not open a service-role client for reads.

---

## Risks, Unknowns and Required Decisions

**Implementation & isolation risks (VERIFIED):**

- **Application-only tenant isolation (dominant risk, R-SEC-1).** RLS is dormant; service-role bypasses it; ~700 hand-written `.eq('business_id',…)` sites are the only backstop. A ZAC service-role read handle = guaranteed cross-tenant leak. **Mitigation:** ZAC opens no reasoning-read client; it composes guarded services with the acting `AuthUser`; ZAC's own `zac.*` tables are ENABLE+FORCE RLS.
- **Service-layer permission-key gap.** Services re-check role+location but not the permission key. **Mitigation:** every tool re-checks the endpoint permission (`userHasAllPermissions`).
- **PII in prompt/response logs.** The global middleware dumps full bodies (only 8 auth keys redacted). **Mitigation:** exclude/redact ZAC routes before the first endpoint; store metadata not verbatim content (D32).
- **`zac.access` auto-grants every owner** — the flag, not the permission, must hold the dark launch.
- **Domain dist staleness** — adding `zac.access` requires rebuilding `@sheer/domain` for web/mobile.

**Missing data / services:** no server-side **utilisation** endpoint (build-work, not a wrapper); no **P&L/profit** (fixed-cost consumer is Week 7-8); no **retention/churn** metric (`analytics` empty); **`no_show` never written**; **`retail_sales` empty**; `waste_events` write-only; **no supplier/ordering/expiry/forecast model**; **no LLM SDK/env** today (ZAC adds the first); **no durable scheduler** for snapshots/reconcilers.

**V1.1 disruption risks:** the `lab-formula`/`lab-appointments`/`crm`/`mobile-dashboard`/`owner-onboarding` modules and migrations `0063/0068/0069/0070` are in active flux — ZAC must treat lab/formula/split-tender surfaces as moving targets and stay read-only over stable endpoints; the web nav insertion must be strictly additive (no reorder).

**Estimate risks:** greenfield LLM integration (no prior art in-repo); prod-vs-dev-test schema drift (Day 1 anchors already drifted — migration count 62→70, `resolveAuthUser` line moved); cost-per-intelligence unknown until real usage; QLAB tool value depends on unknown Lab adoption.

**Decisions needed before/at build start:**

- **Cosan (technical, blocking):** **QC1** module location (recommend confirm `apps/api/src/zac/`); **QC2** tools call injected services + re-check permission vs loopback controllers (recommend **services + re-check**); **QC4** `zac.access` catalogue + default grants (recommend owner+manager, not stylist); **QC5** `zac.kpi_snapshots` vs `analytics` (recommend `zac`); **QC6** audit-event naming + agent-actor (recommend human-attributed `metadata.via='zac'`, no enum change); **QC7** PII redaction rules for prompts/logs; **QC8** prod parity re-verification; plus job-infra for future snapshots/reconcilers and per-tenant cost caps.
- **Luke (product, non-blocking for scaffolding):** **QL1** first role coaching examples; **QL3** assertiveness on underperformance; **QL4** Value-Created dashboard vs report-only; **QL5** first-priority outcome metric; terminology per surface; feedback wording; coaching cadence.

The only decisions that **block starting** the backend foundation are the Cosan technical set; the Luke items resolve in parallel.

---

## Final Recommendation

**Proceed with the Phase 1 backend foundation as a read-only `apps/api/src/zac/` NestJS module**, built to imitate the verified house patterns and honouring the Phase 0 locked decisions (D1–D8, D11, D13, D17, D19, D25–D33, D40, D43–D44). The architecture is low-risk because ZAC reuses the platform's existing trust boundary rather than inventing one:

1. **Authenticate as the acting user's JWT** via the existing `SupabaseAuthGuard` → `AuthService.resolveAuthUser`; thread one resolved `AuthUser` through the turn (D2).
2. **Never open a broad service-role client for reads.** ZAC's tools **inject and call the existing guarded services** (`Kpi`/`Dashboard`/`Crm`/`LabAnalytics`/`Inventory`/`Rota`), inheriting their role + location + `business_id` scoping, **and independently re-check the endpoint permission** to close the service-layer permission-key gap (D3/D31). This resolves QC2.
3. **Gate on `zac.access` AND a feature flag** — the permission opens the door; the flag (backend `ZAC_ENABLED` + web `VITE_ZAC_ENABLED`) is the true dark-launch switch, because owners auto-hold the permission. Add `zac.access` as a first-class catalogue key with the data migration (next free number, `0075+`); grant owner+manager, not stylist, in Phase 1.
4. **Register zero write tools** — read-only is structural, not prompt-based (D4).
5. **The model narrates, never computes** — numbers come from the deterministic KPI engine and report endpoints, wrapped in the seven-part evidence contract (D5/D6).
6. **Capture the measurement + cost spine from the first interaction** into a FORCE-RLS `zac` schema (D7/D44) — with private stylist coaching memory as the platform's first "owner cannot read this" boundary (D25/D41).
7. **Protect PII in logs before shipping** — exclude/redact ZAC routes from the global logging middleware; store metadata, not verbatim prompts/responses (D32).
8. **QLAB/stock is Week-1 feasibility-only**, then at most two read tools (colour analytics + inventory low-stock) in Week 2/3, gated on a data-population probe; defer all forecasting/ordering/expiry (no data model) and everything on the in-flight `0063/0068/0069/0070` chain — protecting the V1.1 roadmap.
9. **Ship web-only in Phase 1** (additive owner/manager nav entry + route); defer the stylist mobile surface and never target the lab app.
10. **Re-verify production schema parity (QC8)** and confirm the Cosan technical decisions before freezing tool contracts.

This foundation is cost-conscious (fast-tier default, per-tenant caching, budgets, telemetry from day one), evidence-backed, role- and permission-aware, memory- and outcome-ready, and demonstrably incapable of autonomous action or unrestricted DB access — exactly the controlled read-only MVP Phase 1 approves, with no disruption to the V1.1 roadmap.

---

*Analysis only. This document created no application source code, migrations, environment files, package manifests, or Supabase data. See [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md), [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md), and [`phase-0-decision-log.md`](phase-0-decision-log.md) for the Phase 0 decisions this analysis operationalises.*
