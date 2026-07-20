# QLOOQO / ZAC Phase 0 Discovery Report

*Read-only discovery of the local repository and the connected Supabase MCP (scoped to the **dev-test** branch `iqgryrczkvjkcbrgfsdl` — **not** prod "Sheer V1" `cdjtsqcrcgywjdwvbxyf`; parity unverified, see §18). Postgres 17.6. No secret values reproduced. Every major claim carries evidence; unverifiable items are marked "Unknown / needs confirmation."*

> File paths below are repo-root-relative (e.g. `apps/api/src/main.ts:28`). Discovery was performed read-only; nothing was implemented or modified.

## 1. Executive Summary

QLOOQO is a **pnpm + Turborepo monorepo** — a multi-location "salon business OS" — with four apps (NestJS API, Vite/React web dashboard, two React-Native apps) over a well-normalized Supabase Postgres split across ten custom schemas. It is a mature, internally consistent substrate: one canonical role/permission model (`packages/domain/src/index.ts`), one booking engine, one notification pipeline, and a deterministic KPI/commission engine (`apps/api/src/kpi/kpi.calc.ts`).

Two findings dominate ZAC's design:

1. **Tenant isolation is application-layer only, not database-enforced.** Every API service connects with the Supabase **service-role key**, which bypasses RLS. RLS exists on all 66 tables but is *dormant* on the live path (`relrowsecurity=true`, `relforcerowsecurity=false`). The sole runtime tenant boundary is ~700 hand-written `.eq('business_id', actor.businessId)` filters. **→ ZAC must never hold a service-role key; it must ride the existing guarded API.** (§6, §11)
2. **ZAC is 100% greenfield.** Zero references to any agent/LLM/model/conversation/memory infrastructure exist in repo or DB. The platform is a clean base, but every ZAC seam — identity, memory, tool boundary, audit vocabulary, outcome measurement — must be built. (§11, §15)

Product-wise, Phase 0's job is to make the **irreversible** decisions well: ZAC's constitution-to-architecture mapping (§12), the tenant/memory/tool/audit/measurement foundations (§13), and — critically — to **start logging ZAC recommendations and outcome links from Phase 1** so Luke's question *"what value has ZAC created this month?"* is answerable later (§15). A realistic Phase 1 is a **read-only, role-differentiated owner/manager/stylist intelligence & coaching assistant** gated by the existing `report.*` permissions, with all writes, messaging, voice, and autonomy deferred (§16–§17).

## 2. Repository Map

Root: `package.json`, `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json`.

**Apps**

| App | Path | Stack | Purpose | Deploy |
|---|---|---|---|---|
| api | `apps/api/` | NestJS (Express, `rawBody:true`) | Backend monolith, ~40 domain modules | Railway (Docker) |
| web | `apps/web/` | Vite + React + React-Router + Tailwind | Owner/manager dashboard | Vercel |
| sheer-app | `apps/sheer-app/` | Expo RN + expo-router | Stylist **+** client (bookings, performance, commissions) | EAS |
| sheer-lab | `apps/sheer-lab/` | RN CLI | Shared salon tablet — BLE scale, PIN unlock, colour formulas | EAS |

**Packages** — `@sheer/domain` (single source of truth: roles, permissions, DTOs), `lab-core` (formula domain + client cost-stripping), `auth` (lab-session helpers; contains a `createAuthGuardPlaceholder` **stub returning `true`**), `api-client` (typed SDK, **lab-only**, partial coverage), `ui-mobile`, `design-tokens`, `utils`, `config`. **⚠️ Dead/legacy:** `booking-core` (declared dependency, **zero imports**); `types` (divergent 9-value `AppointmentStatus` vs domain's 8-value).

**Config/deploy/docs** — `railway.json`, `vercel.json`, `dockerfile`, `eas.json`. Docs: 13 files under `docs/` + `docs/architecture/`. **⚠️** The top-level `database/` dir is placeholder READMEs; the authoritative migrations are `supabase/migrations/` (62 files, `0001`→`0060`). **⚠️** README claims `.github/workflows/ci.yml` but the tree has no workflow files — CI is *Unknown / needs confirmation.*

## 3. Technology Stack

- **Frontend:** React 19 (web: Vite+Tailwind+React-Router); React Native (Expo sheer-app, RN CLI sheer-lab). No React Query — hand-rolled `fetch` per app.
- **Backend:** NestJS/Express, global prefix `/api`, controller→service (no repository layer), Supabase PostgREST query builder (`.schema('core'|'booking'|…)`).
- **Database:** Supabase Postgres 17.6; UUID PKs (`extensions.gen_random_uuid()`); money integer `*_cents` (GBP); quantities numeric `*_grams`.
- **Auth:** Supabase GoTrue (email/password JWT); **three runtime auth models** (§4).
- **Supabase usage:** Postgres + GoTrue + Storage (buckets: `provider-photos`, visit photos). `SUPABASE_ANON_KEY` = GoTrue auth only; `SUPABASE_SERVICE_ROLE_KEY` = **all data access**.
- **Integrations:** Stripe (deposits/refunds, API `2026-04-22.dahlia`), Twilio (WhatsApp Content templates + SMS), Resend (email). All fail-soft/log-only without credentials.
- **Runtime:** API → Railway (`node apps/api/dist/main.js`, healthcheck `/health`); web → Vercel; mobile → EAS. Node 20, pnpm 10.33.

## 4. Backend / API Architecture

**Bootstrap** (`apps/api/src/main.ts:28`): one global `ValidationPipe`, CORS from `CORS_ORIGINS`, `setGlobalPrefix('api')`. **No Swagger, helmet, rate-limiter, CSRF, or global guard/interceptor/exception-filter.** Env validated at boot (`apps/api/src/config/env.validation.ts`).

**Auth/authz (per-controller):**
- `SupabaseAuthGuard` (`apps/api/src/auth/supabase-auth.guard.ts`) → verifies bearer via `AuthService.verifyAccessToken` (re-calls Supabase `getUser`, `auth.service.ts:346`) → attaches `request.auth: AuthUser`.
- `RolesGuard` (`apps/api/src/auth/roles.guard.ts`, `@RequireRoles`, **ANY**-of), `PermissionsGuard` (`apps/api/src/auth/permissions.guard.ts`, `@RequirePermissions`, **ALL**-of; owners hold all), `LocationScopeGuard` (`apps/api/src/auth/location-scope.guard.ts`), `StylistSelfGuard` (`apps/api/src/auth/stylist-self.guard.ts`).
- Identity resolution `auth.service.ts:354` `resolveAuthUser` → `AuthUser{roles[], primaryRole, businessId, businessTier, allowedLocationIds, locationScope, permissions[]}`; **collapses to one primary business** (`auth.service.ts:365`).

**Tenant resolution:** `business_id` comes from the resolved `AuthUser`; **enforced only in application code** (service-role client bypasses RLS). Representative scoping: `crm.service.ts:269` + asserts `crm.service.ts:1266-1285`.

**Second/third auth models:** Lab **PIN session** = a `lab.formula_sessions` UUID passed **in the URL path**, validated by `assertActiveSession` (`lab-session.service.ts:218`, no guard); **device token** `sld_…` (sha256+pepper) vs `core.shared_devices` (`lab-device.service.ts:168`).

**Data access:** service-role admin client per service (~40 sites). **Error handling:** Nest defaults + per-service `HttpException`s; no global filter/standard error envelope. **Logging:** per-class `Logger` + request/response middleware (`apps/api/src/common/request-response-logging.middleware.ts`) (redacts body/query keys, **logs full URL** incl. lab `sessionId`); no APM/tracing.

**Background jobs:** **no `@nestjs/schedule`/`Cron`/`Bull`/queue.** Only `NotificationDispatchService` (`apps/api/src/communications/notification-dispatch.service.ts`) — an in-process `setInterval` poller with an atomic `locked_until` DB-lock claim (`:185`).

**Audit:** `AuditService.record` (`apps/api/src/audit/audit.service.ts:66`) → `audit.activity_log`, **fail-soft** (never throws/blocks), **no interceptor** — 8 explicit `.record()` call sites; `action`/`entity_type` free-text.

## 5. Supabase Data Model

**Schemas (table counts):** `core`(12), `booking`(14), `billing`(8), `inventory`(7), `rota`(6), `crm`(5), `lab`(4), `comms`(3), `audit`(3), `analytics`(**0**), plus managed `auth`/`storage`/`vault`/`realtime`.

**⚠️ No views/materialized views in any custom schema; `analytics` is empty.** All KPIs computed live in TypeScript.

**core:** `businesses` (tenant root; `status`, `tier`={solo,studio,salon,group}) → `locations` → `location_settings`; `user_profiles` (1:1 `auth.users`, the sole FK into auth); `user_memberships` (user↔business↔location↔role join; `security_level_id` 0055); `staff_profiles` (employment/pay/commission), `client_profiles` (nullable `user_profile_id` = walk-ins), `security_levels`, `staff_invitations`, `shared_devices`, `stylist_pin_credentials`, `password_reset_tokens`. (`supabase/migrations/0003_core_foundation.sql`)

**booking:** `appointments` (+`appointment_services`; `occupied_ranges` tstzmultirange no-overlap; `booking_channel` enum incl. **`api`**), `booking_attempts`(+`_services`), `deposits` (`provider_payment_intent_id` FULL unique, `0049`), `visits`, `rebooking_outcomes` (source-visit credited; `rebook_source` text), `services`/`service_categories`/`service_segments`/`staff_service_eligibility` (per-stylist `price_amount`, `0047`)/`service_requirement_rules`+`_options`/`service_upgrade_suggestions`.

**crm:** `client_notes`, `allergy_records`, `patch_tests`, `visit_photos`, `gdpr_requests`. Client identity is `core.client_profiles`; **colour history is in `lab.*`, not crm.**

**comms:** `notification_events` (queue; `attempts`/`locked_until`) → `message_logs` (delivery-status) · `messaging_usage_counters` (per-location caps; enforcement deferred).

**lab:** `formulas` (cost/waste/billable cents), `formula_items` (**no direct `business_id` — scoped via `formula_id`**), `formula_sessions` (PIN/device, 178 rows), `device_pairings` (BLE, **0 rows**).

**inventory:** `products`, `categories`, `location_stock`, `stock_movements` (enum ledger, 89), `low_stock_alerts`, `product_usage`(**0**), `waste_events`(**0** — waste inline on formula items).

**billing:** `billing_rules` (deposit+formula+product config), `service_billing_rules`, `service_billing_settings`, `tax_settings`, `location_fixed_costs`(**0**), `salon_payments`(21), `visit_line_items`(72), `retail_sales`(**0**). **⚠️ No commission ledger table** (§9).

**rota:** `shifts`(174, availability primitive), `shift_breaks`, `absence_events`, `leave_requests`, `book_out_types`(48), `staff_break_defaults`(0).

**audit:** `activity_log` (generic before/after, **3 rows**), `lab_access_events`(502), `rota_audit_events`(215).

**Enums (verified):** `core.membership_role_enum{owner,manager,stylist,client}`, `core.business_tier_enum{solo,studio,salon,group}`, `booking.appointment_status_enum{pending,accepted,rejected,checked_in,awaiting_payment,paid,cancelled,no_show}`, `booking.booking_channel_enum{client_app,staff_app,web_dashboard,phone,walk_in,api}`, `comms.channel_enum{sms,email,push,whatsapp,in_app}`, `comms.notification_status_enum{queued,sent,delivered,failed,cancelled,undelivered,read,skipped,fallback_pending}`.

**Functions/RPCs:** 8 SECURITY DEFINER RLS-predicate helpers in `public.*` (anon-executable boolean oracle) + 8 SECURITY DEFINER mutation RPCs (`service_role`-only, verified). (`supabase/migrations/0007_rls_helpers_and_policies.sql`, `0010_owner_onboarding.sql`)

## 6. Tenant / Location / Role / Permission Model

- **Business separation:** `core.businesses` root; `business_id` NOT NULL + `ON DELETE CASCADE` almost everywhere.
- **Locations:** `business → locations → location_settings`; transactional tables carry NOT NULL `location_id`, config tables omit it.
- **User linkage:** `core.user_memberships(business_id, nullable location_id, user_profile_id, role, status, security_level_id)`. Multi-role in one business is first-class (`AuthUser.roles[]`). **⚠️ Multi-business collapse** — one primary business per session, no switcher.
- **Roles:** `owner|manager|stylist|client` (`domain:5`); gate on `roles[]` via `userHasAnyRole`, never `primaryRole`. **⚠️ `ROLE_PRIORITY` defined 4×** incl. an **inverted** copy in `lab-pin.service.ts:67` — do not casually refactor.
- **Permissions:** fixed `Permission` catalogue (~24 keys) + `PERMISSION_CATALOG` dependency tree + `DEFAULT_ROLE_PERMISSIONS` + `SYSTEM_SECURITY_LEVELS` (owner/group_admin/manager/receptionist/stylist). `core.security_levels` (`0055`) attaches named permission sets to memberships. Owners always get `ALL_PERMISSIONS`.

**Enforcement layers:** Backend guards + service re-asserts (**authoritative**); Supabase RLS (**defined but dormant** — service-role bypass); frontend (**advisory UI only** — 74 checks across 26 web files).

**What ZAC must never bypass:** (1) the per-request `business_id`/`location_id` scoping; (2) `RolesGuard`/`PermissionsGuard`/`LocationScopeGuard`; (3) the client-data cost-stripping firewall for colour formulas; (4) the locked tables (`password_reset_tokens`, `stylist_pin_credentials`).

**Security gaps ZAC must respect (detail §18):** no DB tenant backstop (service-role + `FORCE RLS` off); ~700 manual filter sites with no compile-time guarantee; lab `sessionId` logged in URL; `REVIEW_MODE_ENABLED=true` ships lab Release builds against the **develop** backend (`reviewMode.ts:38`); advisors flag 2 `rls_enabled_no_policy`, 15 mutable `search_path`, leaked-password protection disabled.

## 7. Core Business Workflows Relevant to ZAC

- **Owner onboarding** — public `POST /api/owner/onboarding/register` → auth user + atomic `core.bootstrap_owner_business` RPC (business `status='trial'`, first location, owner membership, billing rules). (`owner-onboarding.service.ts:150`)
- **Staff management** — invitations (sha256 token) → `core.accept_staff_invitation`; `updateStaffMember` reconciles memberships, syncs `staff_profiles`, sets `staff_service_eligibility` (+per-stylist price). Tier caps. (`staff.service.ts:561`)
- **Location management** — read (`locations`, manager-scoped) + write (`owner/locations`, tier-capped).
- **Booking flow** — one engine `PublicBookingService` (`apps/api/src/public-booking/public-booking.service.ts`); availability from occupied sub-windows; client bookings land `pending` (need owner/manager ACCEPT), staff bookings `accepted`; deposit path via Stripe webhook finalize.
- **CRM** — staff-only client hub (`CrmService`, `apps/api/src/crm/crm.service.ts`): profile+visits+formulas+notes+allergies+patch-tests+messages+photos+GDPR. Role/location/visit-scoped.
- **QLab / formulas** — `LabFormulaService` (`apps/api/src/lab-formula/lab-formula.service.ts`); save via `lab.save_formula_with_reconciliation`; **raw cost stripped before clients** (`lab-core:103`).
- **Inventory** — products/stock/`adjust_location_stock`/movement ledger/low-stock alerts.
- **Reports/KPIs** — §8; deterministic `apps/api/src/kpi/kpi.calc.ts`.
- **Notifications** — owner-configured confirmation + reminders → WhatsApp→Email→SMS (fixed order; preference picks start), lazy fallbacks, idempotent.
- **Payments/deposits** — `StripeService` (`apps/api/src/stripe/stripe.service.ts`) card+link intents, refund on reject, HMAC webhooks.
- **WhatsApp/Twilio** — env Content SIDs; missing SID → freeform (24h reject).
- **Customer-facing** — public web booking + client-app booking + `public/salons` discovery; self-service cancel/rebook.
- **Salon Suite** — the operational suite (lab/inventory/billing/rota/commission) *is* the "Salon Suite"; commission is a live compute (§9), not a persisted feature.

## 8. Reporting and KPI Data

All computed **live** (no analytics layer). Endpoint inventory + gates — **ZAC's Phase-1 fuel:**

| Endpoint | Permission | Data |
|---|---|---|
| `GET /api/dashboard/kpis` | `report.dashboard.view` | revenue, appt counts, new-vs-returning |
| `GET /api/dashboard/top-services` | `report.dashboard.view` | ranked services |
| `GET /api/dashboard/stylist-performance` | `report.performance.view` | per-stylist |
| `GET /api/dashboard/inventory-alerts` | `report.dashboard.view` | low stock |
| `GET /api/kpi/stylists` | `report.commission.view` | commission per stylist |
| `GET /api/kpi/performance` | `report.performance.view` | performance |
| `GET /api/kpi/me` | owner/manager/**stylist** (own) | self KPIs |
| `GET /api/lab/analytics/summary` | `report.lab_analytics.view` | colour cost/waste |
| `GET /api/mobile-dashboard/{client,stylist,manager,owner}` | per-role | dashboards |
| `GET /api/retail-sales` | `report.financials.view` | retail list |
| `GET /api/audit/events` | `audit.read` | audit (keyset) |

Underlying tables: `billing.salon_payments`+`visit_line_items` (revenue), `booking.appointments.status` (no-show/cancel), `booking.rebooking_outcomes` (retention), `inventory.stock_movements` (stock), `lab.formulas` (colour cost/waste), `rota.shifts` (utilisation).

**⚠️ Data-readiness:** `location_fixed_costs`, `retail_sales`, `product_usage`, `waste_events` = **0 rows** → P&L/margin/retail reports are blank until captured. KPIs are **live, un-snapshotted** — no history store for trend/"1% better" measurement (§15).

## 9. QLab / Formula / Inventory Data

- **Colour history:** `lab.formulas`+`formula_items`, indexed `(client_profile_id, saved_at desc)` — the moat. Sensitive salon-side data; client view is cost-stripped (`crm.client_notes` comment, `0018`).
- `lab.formula_items` has **no tenant column** — always join `lab.formulas`.
- **Waste:** captured inline on `lab.formula_items.waste_grams`/`formulas.waste_cost_cents` (the `inventory.waste_events` table is empty).
- **Formula billing config:** `billing.billing_rules` (`cost_plus_markup_percent`/`cost_only`/`fixed_uplift`); baseline 18¢/g, 200% markup.
- **Commission (reconciled):** **no ledger table**, but a **live engine** — `apps/api/src/kpi/kpi.calc.ts:290` `computeCommission` (tiers below_3x/3x=10%/3.5x=15%/3.5x-unlocked=30% gated on all-KPIs-met), fed by `core.staff_profiles` commission fields (`0054`/`0056`) + `retail_sales` attribution. Treat as an existing, queryable report — but note the retail base is empty.

## 10. Existing Integrations

- **Stripe** — deposits/refunds; webhook HMAC. Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- **Twilio** — WhatsApp Content templates + SMS; status/inbound HMAC. Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SMS_FROM`, per-event `TWILIO_WHATSAPP_*_CONTENT_SID` (+ legacy `TWILIO_TEMPLATE_BOOKING_*_SID`).
- **Resend** — email; Svix webhook. Env: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`.
- **Supabase** — Postgres/GoTrue/Storage. Env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Dispatcher/peppers/URLs** — `COMMS_DISPATCH_*`, `SHEER_LAB_PIN_PEPPER`, `SHEER_LAB_DEVICE_TOKEN_PEPPER`, `CORS_ORIGINS`, `PASSWORD_RESET_BASE_URL`, `STAFF_INVITE_BASE_URL`, `VITE_API_URL`/`EXPO_PUBLIC_API_URL`/`SHEER_LAB_API_URL`.
- **`push` channel enum exists but no push provider is wired.** **No AI/LLM provider anywhere.**

## 11. ZAC Integration Readiness

- **What ZAC should be:** a **new NestJS module inside apps/api** (`apps/api/src/zac/`), *not* a separate service and *not* client-side. This inherits the guards, the `AuthUser` oracle, and the audit service, and keeps ZAC inside the one place tenant scoping is centralized. Optionally extract shared contracts (tool schemas, DTOs) into a small `@sheer/zac-core` package.
- **AI service layer location:** server-side in that module: a **context assembler** (identity+scope+goals) → **model router** → **tool layer** (thin wrappers over guarded HTTP controllers) → **audit/measurement writer**.
- **Existing APIs ZAC can use:** the report/KPI/CRM/audit/account read endpoints in §8, plus availability reads.
- **Missing APIs/tools to create:** a frozen **typed tool contract** (no Swagger exists); a longitudinal **KPI snapshot** source; ZAC's own conversation/memory/recommendation endpoints; (deferred) approval-gated write tools.
- **Authenticated user context:** ZAC authenticates as the **acting user's JWT** and resolves via `AuthService.resolveAuthUser` (`auth.service.ts:354`). **Never** a service-role key.
- **Business/location/role/permission context:** carried by the resolved `AuthUser` (`businessId`, `businessTier`, `allowedLocationIds`, `locationScope`, `roles[]`, `permissions[]`) — injected into every model call and every tool.
- **Safe data access (no unsafe direct DB):** ZAC calls the **guarded controllers** so `RolesGuard`/`PermissionsGuard`/`LocationScopeGuard` + per-service `business_id` filters run on every action. Given RLS is dormant, direct DB access is the unsafe path and must be avoided.
- **Audit logs:** reuse `AuditService.record` (`audit.service.ts:66`) → `audit.activity_log` (free-text `action` e.g. `zac.answer.delivered`); decide human-vs-`agent` attribution now (§13). Consider a dedicated `zac.events` table for high-volume interaction telemetry to avoid polluting the tamper-evident audit log.
- **Memory:** new **`zac` schema**, `zac.memory` (per-business, and decide per-user vs shared), tenant-scoped with RLS **ENABLED AND FORCED** (stronger than the rest of the platform).
- **Conversation topics:** `zac.conversations` (title/topic/intent) + `zac.messages` (role, content, `tool_calls`, `sources`, token usage).
- **Knowledge base:** `zac.knowledge_documents` (business-scoped) and/or a Storage bucket + metadata table; rule-based/keyword retrieval first, `vector` extension deferred.
- **Role-based AI answers enforcement:** structurally — ZAC's tool set and system prompt are derived from `AuthUser.permissions[]`; a stylist's ZAC cannot call `report.financials.view` tools, so it *cannot* surface owner-only financials even if asked.

## 12. ZAC Constitution → Architecture Mapping

The philosophy is enforced **structurally**, not by prompt alone — anything left to the prompt is a flexible detail (§14); anything that must always hold is wired into the substrate (§13).

### A. Truth — *evidence-based, sourced, uncertainty-aware*
- **No un-retrieved numbers.** ZAC never computes a KPI itself; it calls the deterministic engine (`kpi.calc.ts`) / report endpoints and quotes the result. The LLM narrates, it does not do arithmetic.
- **Source tracking.** Every answer stores the tools/endpoints called, the entity IDs, and an **as-of timestamp** in `zac.messages.sources` (KPIs are live/un-cached, so staleness must be cited).
- **Uncertainty & empty data.** When an input table is empty (`retail_sales`, `location_fixed_costs` = 0 rows), ZAC must say *"no data captured yet"* rather than infer. Confidence is a first-class field on recommendations.
- **Enforcement point:** tool-result grounding + a "citations required" contract on every factual claim; answers with no source are blocked/flagged.

### B. Loyalty — *the salon's goals before generic AI behavior*
- **Single-tenant loyalty = single-tenant scoping.** Loyalty is guaranteed by the same mechanism as privacy: ZAC only ever sees and optimizes for the caller's `businessId`.
- **Business-specific benchmarks.** Recommendations reference the salon's own targets (`kpi.calc` service target = `hourlyRate×3×hours`, retail 10%, rebooking ≥50%) and its own catalogue (`inventory.products`, `booking.services`), never generic industry defaults or third-party/affiliate products.
- **Persisted goals.** Owner-stated priorities live in `zac.memory` so advice stays aligned across sessions.
- **Enforcement point:** context assembler always injects business goals/targets; no external product catalog is ever a recommendation source.

### C. Integrity — *influence not manipulation; approval before sensitive actions*
- **Phase 1 read-only** — zero autonomous mutations (structurally: no write tools registered).
- **Human-in-the-loop for writes (later).** Any future action is a *proposed action* object that a human confirms; the write then flows through the guarded controllers. Never silent.
- **Everything logged.** `zac.recommendation.created` / `zac.action.proposed` / `zac.action.approved|dismissed` → auditable trail; ties recommendations to human decisions.
- **No dark patterns.** Nudges are dismissible and measured by *acceptance*, not pressure; ZAC records dismissals honestly (feeds §15).
- **Enforcement point:** the tool boundary (read-only in P1) + an approval object + audit logging; ⚠️ audit is fail-soft, so add alerting so integrity events can't silently drop.

### D. Privacy — *tenant isolation, role boundaries, memory boundaries, user control*
- **The hardest requirement given RLS-dormancy.** ZAC must (1) never hold a service-role key; (2) read only via guarded API; (3) store its own data in a `zac` schema with **`FORCE RLS`** (so even a privileged connection can't cross-read ZAC memory).
- **Role-scoped answers & memory.** Memory and answers are gated by `permissions[]`; a stylist's memory/answers can't contain owner financials.
- **Memory boundaries.** Decide per-business vs per-user vs shared (owner memory ≠ stylist memory) — a §13 decision.
- **User control & retention.** Owners can view/delete ZAC memory (model it on the existing `crm.gdpr_requests` pattern); define conversation TTL.
- **No cross-salon leakage in the model layer.** Prompt-cache and context must be **per-business** — never cache one tenant's data into another tenant's call. Redact client PII from the request/response logger before ZAC increases sensitive log volume.
- **Enforcement point:** dedicated FORCE-RLS `zac` schema + permission-derived context + per-tenant cache keys + log redaction.

### E. Humanity — *supports people, coaching-oriented, role-differentiated*
- **Role-differentiated system prompts & tool sets** keyed on `AuthUser.roles[]`: owner → business intelligence; manager → team/location ops; stylist → personal performance & coaching (`/api/kpi/me`); client → booking help. The platform already has matching surfaces (web owner/manager, sheer-app stylist+client, lab stylist).
- **Coaching = compare to the person's own trajectory.** The "1% better" promise requires a longitudinal KPI store (§15) — without it, ZAC can only describe today, not improvement.
- **Positive, specific nudges** tied to one measurable next step; never fabricated criticism (bounded by Truth).
- **Enforcement point:** surface/role-aware prompt selection + longitudinal metrics + honesty guardrails.

## 13. Hard-to-Change Decisions After Phase 0

| Decision | Why it's hard/expensive to change later |
|---|---|
| **ZAC identity & constitution** | Becomes the user-trust contract and brand; it also dictates *what you log and how memory behaves*. Reversing it breaks trust and invalidates accumulated data semantics. |
| **Tenant/user/location/role/permission model ZAC adopts** | ZAC's access decision (JWT-through-guards vs service-role vs dedicated DB role) is baked into every tool and every stored assumption; the one-business collapse is assumed platform-wide. Migrating later means rewriting every tool and re-verifying every permission path. |
| **Memory ownership & separation model** | Per-business vs per-user vs shared, and whether it's FORCE-RLS'd. Once memory accumulates under one partition, re-partitioning is a data migration with privacy risk. |
| **Tool/action architecture (the LLM↔platform boundary)** | Read-only-via-guarded-API vs direct-DB/RPC, and read-only vs mutation-capable, define the entire approval/audit/security surface. Changing the boundary rewrites every tool. |
| **Auditability model** | What is logged, actor identity (human vs `agent` — `audit.activity_log.actor_role` has **no agent value** today), and the event vocabulary. If you don't log from day 1 you cannot retroactively prove integrity or measure value. |
| **Business-outcome measurement model** | The schema linking *recommendation → outcome*. If Phase 1 doesn't capture recommendations + acceptance + outcome links, "what value did ZAC create?" is **permanently unanswerable for that period**. This is the single most important thing to get right early (§15). |
| **AI service boundary (where ZAC lives)** | In-`apps/api`-module vs separate service. Moving later is a deployment + auth + network re-architecture. |
| **Data access pattern** | Guarded-API vs direct-DB. Because RLS is dormant, the wrong early choice is a *silent cross-tenant leak* and is very expensive to unwind safely. |

## 14. Flexible Decisions That Can Evolve Later

| Decision | Why it's safe to evolve (if the foundation above holds) |
|---|---|
| **AI model provider** | Abstracted behind a router interface; swap without touching tools/auth/audit. (Default to the latest Claude models.) |
| **Model routing rules** | Per-task tier selection is pure config above the tool layer. |
| **Number of specialist agents** | Orchestration detail; add/remove agents without schema or auth change. |
| **Exact prompts** | Versioned strings; iterate freely while keeping constitution invariants structural (§12). |
| **Tone wording** | Copy; A/B-testable per surface/role. |
| **Channels (in-app, website, voice, WhatsApp, phone)** | If the core is a server-side context+tool layer, each channel is a thin transport adapter — provided auth/surface handling is reused. |
| **Phase 1 use-case priority** | Sequencing over the same read-tool substrate. |
| **UI placement** | Front-end concern; the API contract is unchanged. |
| **Cost-optimisation policies** | Caching/routing/budget caps are operational config. |

**Principle:** everything here sits *above* the hard foundation. If truth, privacy, auditability, and measurement are enforced structurally, the surface can change weekly without violating the constitution.

## 15. Business Outcome Measurement Architecture

Luke's target question — *"What value has ZAC created for my business this month?"* — is **not answerable from today's data** because (a) there is no ZAC event/recommendation store, (b) there is no recommendation→outcome attribution, and (c) KPIs are computed live with **no historical snapshot**. The following makes it answerable **if capture starts in Phase 1**.

### Outcome-by-outcome: what exists / what's missing

| Outcome | Exists today | Missing | Attribution hook |
|---|---|---|---|
| **Revenue influenced** | `billing.salon_payments`, `visit_line_items`, `appointments.status='paid'`, `booking_channel_enum='api'` | link from a ZAC recommendation → resulting appointment/visit/sale | tag ZAC-driven bookings with `booking_channel='api'` + `zac.recommendation_outcomes` |
| **Missed appointments recovered** | `appointment_status_enum{no_show,cancelled}` | no "recovery" concept | log ZAC flag → link recovered booking |
| **Rebooking improvement** | `booking.rebooking_outcomes` (**`rebook_source` text**) | pre/post baseline store | set `rebook_source='zac'` / `zac.recommendation_outcomes` |
| **Retail/product recommendations** | `billing.retail_sales` (**0 rows — retail not live**) | populated retail + rec link | blocked until retail adoption |
| **Colour/product waste reduction** | `lab.formulas.waste_cost_cents`, `formula_items.waste_grams` (populated) | per-suggestion waste-delta attribution | `zac.recommendation` (type=waste) → formula waste trend |
| **Time saved** | none | modeled metric | `zac.task.completed` with estimate + interaction counts |
| **Staff performance improvement** | `kpi.calc` per-stylist (live) | longitudinal snapshots | `zac.kpi_snapshots` |
| **Client retention impact** | `client_profiles`, `visits`, `rebooking_outcomes` | cohort/repeat-rate store | snapshots + retention-nudge attribution |
| **Booking utilization** | `rota.shifts` (capacity) + `appointments` (booked) | historical utilization store | `zac.kpi_snapshots` |
| **Stock/order optimization** | `location_stock`, `stock_movements`, `low_stock_alerts` | no PO model (ordering is email-not-API per roadmap) | `zac.recommendation` (type=reorder) → stockout-avoided tracking |
| **Training/coaching impact** | none | coaching store + KPI linkage | `zac.coaching_interactions` → snapshot delta |

### Events ZAC should log **from Phase 1** (even read-only)
`zac.conversation.started` · `zac.question.asked` (with classified topic/intent) · `zac.answer.delivered` (with `sources`) · `zac.recommendation.created` (typed: `rebooking`/`retail`/`waste`/`reorder`/`pricing`/`coaching`/`utilization`) · `zac.recommendation.shown` · `zac.recommendation.accepted` | `dismissed` · `zac.report.viewed`. **Capturing recommendations + acceptance from day 1 is what makes value attribution possible later** — this is a §13 hard-to-change decision.

### Data structures (new `zac` schema, all `business_id NOT NULL`, FORCE-RLS)
- `zac.conversations` (business, user, role, topic, started_at, ttl)
- `zac.messages` (conversation_id, role, content, tool_calls, **sources jsonb**, tokens)
- `zac.recommendations` (business, location, user, **type**, target_entity_type/id, expected_outcome, **confidence**, measurement_window, status)
- `zac.recommendation_outcomes` (recommendation_id → **attribution join** to `appointment_id`/`visit_id`/`retail_sale_id`/`formula_id`, observed_value, matched_at)
- `zac.memory` (business, optional user, key/value, source)
- `zac.knowledge_documents` (business, title, content/uri, tags)
- `zac.kpi_snapshots` (business, location, staff, period, metric, value) — **the "1% better" longitudinal spine**; alternatively realize as `analytics.*` materialized views (the empty `analytics` schema is clearly reserved for this).

### Connecting recommendations to outcomes
Store each recommendation with a **target entity + expected outcome + measurement window**; a later reconciler (once a durable scheduler exists) matches the outcome (e.g., "client rebooked within N days of a ZAC rebooking nudge?"). The existing `booking.rebooking_outcomes.rebook_source` and `booking.appointments.booking_channel='api'` are natural attribution hooks **already in the schema** — use them.

### Track from Phase 1 even if advanced analytics come later
Minimum viable capture: **recommendation + acceptance events**, **conversation topics**, and **periodic KPI snapshots**. These three are cheap now and impossible to reconstruct retroactively.

**Honesty caveats:** revenue/margin/retail/waste-event measurement is partially blocked by empty tables (`retail_sales`, `location_fixed_costs`, `product_usage`, `waste_events`); "time saved" and "coaching impact" are inherently modeled/soft; all figures depend on prod-parity confirmation (§18).

## 16. Recommended Phase 1 MVP Scope

**A read-only, role-differentiated intelligence & coaching assistant.**
- ZAC runs server-side in `apps/api/src/zac/`, authenticates as a **per-user JWT** (owner/manager/stylist), resolves `AuthUser`, and answers by calling the **existing guarded report/KPI/CRM read endpoints** (§8).
- Gated by **existing `report.*` + `crm.view` + `audit.read`** permissions — **no new permission model required** for read-only.
- **Role-differentiated support (Humanity, §12E):** owner → business intelligence & value summary; manager → team/location ops; stylist → personal performance + coaching from `/api/kpi/me`; client → booking help.
- **Truth-grounded answers** with sources/as-of timestamps; explicit "no data yet" for empty inputs.
- **Capture the measurement spine from day 1** (§15): conversations, recommendations, acceptance, and periodic KPI snapshots — even though ZAC takes no actions.
- **Memory + KB** in a new FORCE-RLS `zac` schema; per-business scoping; owner-controllable.

Deliverable answers: revenue/appointment/no-show/rebooking trends, top services, stylist performance & commission readiness, low-stock alerts, colour cost/waste, per-client history (staff-only), and an early "value created" summary built from captured recommendation/acceptance events.

## 17. Deferred Capabilities

- **Voice** (transport + latency + new auth surface).
- **WhatsApp / phone reception** (the WA→Email→SMS pipeline already owns client messaging; ZAC injecting risks double-messaging; inbound WA is log-only today).
- **Autonomous actions / write-tools** (need approval workflow + agent audit identity + backfilled audit coverage + sign-off).
- **Advanced business coaching** (needs longitudinal KPI snapshots to exist first).
- **Complex reporting automation / scheduled digests** (no durable scheduler; needs `@nestjs/schedule` or a queue).
- **Ordering / stock actions** (no PO model; ordering is email-not-API).
- **Cross-business intelligence** (blocked by one-primary-business collapse).
- **Financials/P&L/retail/margin answers** (input tables empty).
- **Semantic/vector KB retrieval** (start rule-based).

## 18. Risks / Gaps / Unknowns

**Security:** (1) no DB tenant backstop — service-role + `FORCE RLS` off; service-role to ZAC = guaranteed leak. (2) ~700 unenforced manual filter sites, no request-scoped context. (3) **Prod parity unverified** (findings from dev-test branch). (4) No rate-limiting/helmet/CSRF/global exception filter; full request/response + lab `sessionId` logged. (5) `REVIEW_MODE_ENABLED=true` → develop backend on lab Release. (6) Advisors: 2 `rls_enabled_no_policy`, 15 mutable `search_path`, 15 anon-executable SECURITY DEFINER, leaked-password protection off; perf: 592 multiple-permissive-policies, 122 unindexed FKs.

**Technical:** no agent/LLM/conversation/memory infra (greenfield); no durable scheduler; no Swagger (tool contract must be hand-extracted); `@sheer/api-client` partial; dist-vs-source staleness; `ROLE_PRIORITY` ×4 incl. inverted copy; dead/divergent packages (`booking-core`, `types`); CI discrepancy.

**Data/reporting:** empty `analytics` (no views/matviews); KPIs live/un-snapshotted (blocks trend & "1% better"); empty `retail_sales`/`location_fixed_costs`/`product_usage`/`waste_events`; commission compute-only (no ledger); `audit.activity_log` thin (3 rows) + partial coverage + no `agent` actor; `core.client_profiles` contact/consent columns un-inventoried.

**Product/ownership:** ZAC scope (read-only vs action-taking) undefined — forks auth/permission/audit/scheduler; memory ownership (per-user vs shared) undecided; measurement/attribution model undecided; one-business-per-user permanence undecided.

## 19. Required Inputs From Luke

1. **ZAC in one sentence** + its Phase-1 scope: read-only intelligence/coaching, or must it take actions in v1?
2. **Constitution priorities** — if Truth/Loyalty/Integrity/Privacy/Humanity ever conflict, what's the precedence?
3. **Personality & tone** — relationship expectation (coach? colleague? advisor?), and any must-not-do behaviors.
4. **Priority users** — owner-first, or manager/stylist too from day 1? (sets role-differentiation depth)
5. **First Phase-1 use cases** ranked (e.g., daily performance coaching vs revenue summary vs rebooking).
6. **Business outcomes to measure first** — which of §15's metrics define "value created" for the launch narrative?
7. **Coaching model** — what does "1% better" mean concretely per role, and against what baseline?
8. **Client-facing messaging** — may ZAC ever message clients directly, or only draft for staff?
9. **Memory expectations** — should owners see/edit/delete what ZAC remembers; per-user or salon-shared memory?
10. **Later phases** — voice / website / WhatsApp / phone reception expectations and rough sequencing.
11. **Autonomy boundary** — which (if any) actions may ZAC ever take without human approval?

## 20. Required Inputs From Cosan

1. **Data-access decision (defining):** ZAC as per-user JWT through guarded API (recommended), service-role, or a dedicated FORCE-RLS DB role?
2. **Where ZAC lives:** confirm `apps/api/src/zac/` module; consume/extend `@sheer/api-client` or per-app fetch?
3. **Report contract:** confirm the definitive report/KPI/CRM endpoint list + response shapes (no Swagger).
4. **Permissions:** existing `report.*`/`crm.view`/`audit.read` sufficient for read-only, or a dedicated ZAC permission/security-level?
5. **Surface:** new `AppSurface` value + `assertSurfaceAccess` entry, or ride `web_dashboard`/`api`?
6. **New `zac` schema:** approve conversations/messages/recommendations/recommendation_outcomes/memory/knowledge_documents/kpi_snapshots, FORCE-RLS; Storage vs table for KB; `vector` later?
7. **Measurement plumbing:** where do KPI snapshots live — `zac.kpi_snapshots` vs `analytics.*` materialized views? Who owns the reconciler?
8. **Audit:** add `agent` to `core.membership_role_enum` (or `metadata.agent`); backfill audit coverage before any writes?
9. **Scheduler:** introduce `@nestjs/schedule`/queue for proactive/reconciler work, or single-instance `setInterval`+DB-lock?
10. **Prod parity:** who confirms prod "Sheer V1" schema/RLS/data parity and re-checks the empty-table findings before go-live?
11. **Planned V1.1 changes** that touch schema/permissions/reporting (so ZAC's tool contract targets the right shapes).
12. **`core.client_profiles`** — enumerate contact/`communication_preference`/consent fields ZAC needs for retention reporting.
13. **Observability/PII:** redact ZAC prompt/response payloads (and lab `sessionId`) from the request logger?
14. **Hygiene:** OK to remove/reconcile `booking-core`/`types`, centralize `ROLE_PRIORITY`, unify dist-vs-source?

## 21. Evidence Index

**Method:** 11 parallel read-only subsystem agents (repo via Read/Grep; DB via Supabase MCP `list_tables`/`execute_sql`/`get_advisors`) + a security/RLS verifier + a completeness critic; cross-verified. Env/deploy/CI reconstructed by direct reads.

- **Topology:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `railway.json`, `vercel.json`, `dockerfile`, `README.md`.
- **API core/auth:** `apps/api/src/main.ts:28`, `apps/api/src/app.module.ts:85`, `apps/api/src/config/env.validation.ts`; guards `apps/api/src/auth/supabase-auth.guard.ts`, `roles.guard.ts:28`, `permissions.guard.ts:36`, `location-scope.guard.ts:33`; `apps/api/src/auth/auth.service.ts:354` (resolveAuthUser), `:365` (business collapse), `:459` (owner=ALL).
- **Service-role isolation:** `apps/api/src/crm/crm.service.ts:244`/`:269`, `public-booking.service.ts:282`, `staff.service.ts:161`.
- **Role/permission model:** `packages/domain/src/index.ts` — UserRole:5, AuthUser:118, ROLE_PRIORITY:163, Permission/PERMISSION_CATALOG:212/263, DEFAULT_ROLE_PERMISSIONS:357, SYSTEM_SECURITY_LEVELS:398, AppointmentStatus:2091; inverted dup `apps/api/src/lab-pin/lab-pin.service.ts:67`.
- **DB migrations:** core `0003_core_foundation.sql`; security levels `0055_security_levels.sql`; booking `0004_booking_foundation.sql`/`0017_booking_attempts_and_stripe_deposits.sql`; deposits unique `0049_booking_deposits_full_unique_provider_payment_intent.sql`; staff pricing `0047_staff_service_pricing.sql`; crm `0018_crm_foundation.sql`; comms `0006_billing_and_comms_foundation.sql`/`0059_messaging_notification_foundation.sql`; lab/inventory/billing `0021_lab_billing_inventory.sql`; onboarding RPC `0010_owner_onboarding.sql`; audit `0058_audit_activity_log.sql`. Enums/RLS/row-counts verified via `pg_enum`/`pg_class`/`pg_policies`/`pg_stat_user_tables`/`get_advisors`.
- **RLS helpers:** `supabase/migrations/0007_rls_helpers_and_policies.sql`; `current_user_id()` `0001_extensions_and_helpers.sql:12`.
- **Reporting/jobs/audit:** `apps/api/src/kpi/kpi.calc.ts:290` (computeCommission), `apps/api/src/dashboard/dashboard.service.ts`, `apps/api/src/lab-analytics/lab-analytics.service.ts`, `apps/api/src/audit/audit.service.ts:66`, `apps/api/src/communications/notification-dispatch.service.ts:120`.
- **Frontend auth:** web `apps/web/src/auth/AuthProvider.tsx`/`ProtectedRoute.tsx`; lab `apps/sheer-lab/src/features/sheer-lab/labSession.ts`, `apps/sheer-lab/src/config/reviewMode.ts:38`.

*Findings marked "0 rows"/"empty"/"dev-test" are observations from the MCP-connected dev-test dataset and must be re-confirmed against prod "Sheer V1" before go-live.*

---

*This is discovery and architecture planning only — nothing implemented. The two most consequential Phase-0 takeaways: (1) route ZAC through the guarded API (never service-role) because DB-level tenant isolation is dormant; (2) stand up ZAC event/recommendation/snapshot capture in Phase 1 even while read-only, or the "value created" question stays permanently unanswerable for that window.*
