# ZAC — Conversation & Context Memory (Phase 1, implemented)

> **Status: implemented** — this document describes code on `develop`
> (`apps/api/src/zac/`), not a plan. Where any Phase 0 document disagrees,
> the code is the source of truth.

ZAC is now stateful across questions. Conversations and a deliberate, scoped
context memory persist in the `zac` schema; every ask resolves them under the
acting user's **current** permissions. The read-only boundary over operational
QLOOQO data is unchanged: ZAC writes exclusively to ZAC-owned tables
(`zac.conversations`, `zac.messages`, `zac.memory_items`) and still cannot
mutate appointments, clients, stock, prices, staff, payments or reports.

---

## 1. Conversation lifecycle

- `POST /zac/ask` accepts an optional `conversationId` (UUID). Absent → a new
  `zac.conversations` row is created for the acting user and returned as
  `conversation_id` on the response. Present → the id must belong to the
  authenticated actor, in their business, with `status='active'` —
  **anything else is the same 404**, so an attacker probing ids learns nothing
  (`ZacConversationStore.requireOwnActive`).
- Ownership always comes from the guard-verified `AuthUser`; the request body
  can never choose an actor, business or location.
- Reuse/creation telemetry: `conversation_created` / `conversation_reused`
  spine events (ids only, never content).
- **Fail-soft creation**: if ZAC storage is down, the turn runs stateless —
  the answer still serves, `conversation_id` is `null`, and a
  `persistence_failed` spine event fires loudly. Fail-closed reuse is NOT
  softened: a foreign id is always a 404.

### Messages (data minimisation, D32)

Each turn appends two `zac.messages` rows (user + assistant) carrying
**structural safe summaries only** — e.g. `Asked a question routed to
report.business_health.` / `Insight via report.business_health (narrated)` —
plus `trace_id`, `response_type`, model and output-token count. The user's
words and the assistant's prose are **never** stored. Continuity that needs
content (goals, preferences) lives in memory items instead, which store
redacted summaries by design.

## 2. Ask API contract

Request (`ZacAskRequestDto`):

```jsonc
{ "question": "…", "conversationId": "uuid?", "requestSource": "web_dashboard|mobile_app?", "locationId": "uuid?" }
```

Response additions (`ZacResponse`):

- `conversation_id: string | null` — send back as `conversationId` to continue.
- `memory_updates: [{ scope, kind, summary }]` — populated on capture turns.

Web (`ZacPage`, `ZacChatWidget`) and mobile (`app/zac.tsx`) both thread the id
in component memory only (no localStorage/secure-store), reset it on
Clear/New-conversation and on account switch.

## 3. Memory model

Storage: `zac.memory_items` (+ migration `0089_zac_memory_lifecycle.sql`:
`status` active|superseded|archived, `superseded_by_id`, `topic`, active-lookup
index).

**Kinds** (closed vocabulary, `zac-memory.types.ts`): `business_goal`,
`user_preference`, `business_priority`, `recurring_problem`, `prior_decision`,
`coaching_focus`, `manager_team_theme`.

**Visibility scopes** (0077 vocabulary) and who may retrieve:

| Scope | Retrievable by |
|---|---|
| `user_private` | the owning actor only |
| `stylist_private` | the owning actor only — **owner/manager roles never widen into it** |
| `business_owner` | owners and managers of the business (current role checked every request) |
| `manager_team_theme` | owners; managers whose current location scope covers the item's location |

Scope is resolved **server-side from role + kind**
(`ZacMemoryService.resolveScope`) — never by extraction output or user text.
Stylists cannot create business- or team-visible memory; their coaching focus
is `stylist_private` (the hard Phase 1 privacy rule); preferences are always
`user_private`.

## 4. Capture (extraction)

Deterministic only — no model call (`ZacMemoryExtractionService`). Explicit
triggers Phase 1 promises: *remember that/this*, *keep in mind*, *from now on*,
*my/our … goal|target|priority|focus is*, *I prefer*, update phrasing
(*update/change/make … goal to X*), plus one narrow stylist aspiration form
(*"I want to get more confident …"*). Content is preamble-stripped, PII-redacted
(`zac-redaction.ts`) and capped before storage.

Refused outright (`memory_declined`, nothing stored): credentials, tokens,
payment details, card-shaped digit runs, client contact details. Storage
failure produces an honest "I couldn't save that" — ZAC never claims to have
remembered something it did not persist.

### Updates / supersession

One active memory per (kind, topic, owner-scope). A new statement supersedes
its predecessor (`status='superseded'`, `superseded_by_id` linked) — "my
rebooking goal is 55%" followed by "update that goal to 60%" leaves exactly one
active goal at 60%. Bare-value updates inherit the predecessor's topic and get
a synthesised summary (`Business goal (rebooking): 60%.`).

## 5. Retrieval

Deterministic, bounded (max 5), always under current role/location scope:

- **Memory questions** ("what do you remember about me / my business / the
  team", "what are my current goals", "what preference have I given you")
  answer **from persisted memory** — no report tool, no model call, honest
  "nothing saved yet" when empty. This route runs before all other intent
  routing (so "…about the team" never falls into the staff-list intent).
- **Normal questions**: topic-matched memories (question topic == memory
  topic), goals/coaching for improvement-shaped questions, plus
  communication-style preferences (they shape every answer). Unrelated
  memories are never stuffed into the prompt. Retrieval failure fails soft to
  none.

## 6. Memory vs evidence (grounding)

Memory enters the model prompt as a clearly-labelled **user-stated context**
block, separate from the verified-figures evidence block (and fenced as data,
not instructions). The grounding check is structural on both sides: narration
numbers must come from evidence, **or** from the memory block *and* sit in an
attribution-shaped sentence ("your stated goal of 60%") — a memory figure
presented as a live measurement falls back to the deterministic answer exactly
like a hallucinated one (`model_fallback: ungrounded`). `evidence[]` on the
wire remains tool-only; memory appears in `memory_updates`/answers, never as
evidence.

## 7. Introduction behaviour

`firstAssistantTurn` (derived from the persisted assistant-message count)
suppresses the greeting/self-introduction on every deterministic path and adds
a "do not reintroduce yourself" instruction to live narration. "Who are you?"
still answers with identity at any point (`introduceIdentity` tool input).

## 8. Database & configuration

- Migrations: `0076`, `0077`, `0080` (file `0080_zac_storage_corrections.sql`,
  internally titled 0079), `0081`, and now **`0089_zac_memory_lifecycle.sql`**.
  All additive; apply via the runbook
  ([phase-1-storage-apply-and-verification-runbook.md](phase-1-storage-apply-and-verification-runbook.md)).
- **External Supabase step (required per hosted project)**: add `zac` to
  **Exposed Schemas** (and Extra search path) — Dashboard → Project Settings →
  API. Without it every ZAC read/write fails with `PGRST106`; conversations
  degrade to stateless turns and memory saves fail honestly. This does NOT
  open the tables to browsers: RLS is forced, `authenticated` holds narrow
  SELECT-only policies, and the API service role is the only writer (0080).
  `supabase/config.toml` mirrors this for local dev (`schemas` +
  `extra_search_path` include `zac`).
- Persistence is server-owned: the stores (`zac/persistence/`) use the API
  service-role client exactly like every other QLOOQO service; no client app
  touches `zac.*` directly.

## 9. What Phase 1 memory intentionally does NOT do

No embeddings/vector RAG (deterministic retrieval only) · no automatic
"remember everything" (explicit commands only) · no raw transcript storage ·
no cross-business or cross-tenant memory · no memory-driven autonomous
actions · no model-assisted extraction (deliberately deferred; the
deterministic path covers the promised cases) · no memory UI management
surface yet (create/supersede via conversation only).

## 10. Running the acceptance tests

```bash
cd apps/api
npx jest src/zac                                  # everything ZAC
npx jest src/zac/zac.service.spec.ts              # incl. Luke scenarios + privacy suites
npx jest src/zac/memory src/zac/conversation      # memory/conversation units
```

Key suites: `memory: Luke acceptance scenario 1 (rebooking goal)`,
`introduction behaviour (Luke scenario 2)`, `memory privacy through the full
ask pipeline`, `conversation continuity (persisted)`.
