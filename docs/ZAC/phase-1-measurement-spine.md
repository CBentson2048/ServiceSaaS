# ZAC — Measurement Spine (Phase 1, implemented)

> **Status: implemented.** The Phase 1 telemetry contract now persists to the
> real `zac` tables — outputs, tool calls, cost events, feedback and outcome
> events — not just structured logs. **This is the measurement foundation, not
> the full Value Created / ROI engine**: nothing here claims financial value,
> and nothing infers outcomes from advice.

## 1. Event relationship

```
zac.conversations ──< zac.messages (safe intent summaries, trace_id)
        │
        └──< zac.outputs (one per MEANINGFUL answer; trace_id, request_mode)
                  │            ▲ linked by trace_id / conversation_id
                  ├──< zac.feedback       (one active vote per output+actor)
                  ├──< zac.outcome_events (explicit, conservative)
                  └──< zac.cost_events    (output_id + trace_id)
        zac.tool_calls (per dispatch; trace_id, conversation_id)
```

`trace_id` (returned on every response) correlates the whole turn; the
persisted output's id is returned as `output_id` on the ask response and is
the handle feedback uses.

## 2. What persists — and what deliberately does not

**Persisted**: safe answer text (PII-redacted, capped) with evidence
references, limitations, confidence, response type, request mode; tool names /
status / latency / row counts; model, tokens, cache activity, latency and cost
estimates; feedback votes; explicit outcome events with safe summaries.

**Never persisted**: prompts or hidden instructions, raw tool payloads,
transcripts (messages hold structural intent summaries only, D32), tokens/keys,
client PII beyond what the redactor allows through, conversation text in cost
rows.

## 3. Meaningful outputs (`ZacMeasurementService.isMeaningfulOutput`)

Persisted: **live business answers** (an operational `report.*`/`kpi.*`/
`schedule.*` tool dispatched OK) and **successful advisory answers**
(general advice / hypothetical). Not persisted: acknowledgements,
conversational follow-ups, refusals and unavailable-fallbacks, capability and
permission meta-answers, memory operations (those live in `zac.memory_items`).
Output types are the closed seven response types + request mode — never
model-invented. Stylist answers persist as `visibility_scope 'user_private'`;
owner/manager answers as `business_owner`.

## 4. Feedback

`POST /zac/outputs/:outputId/feedback` `{ rating: 'useful' | 'not_useful', comment? }`
behind the full guard stack (`zac.access` + rollout). Stored as 0077's
`up`/`down`. **One active vote per (output, actor)** — resubmitting updates in
place (unique index `idx_zac_feedback_output_actor`). Access is the output
visibility model, fail-closed 404 with existence hiding: other business, or a
`user_private` output that isn't yours (owner/manager roles never widen into a
stylist's personal answers). **Fail-hard**: a storage failure is an error —
the UI never shows a false "saved". Web (console + widget) and mobile show
minimal Useful / Not useful controls whenever `output_id` is present.

## 5. Outcomes & attribution

`ZacMeasurementService.recordOutcome` is the Phase 1 contract (internal; no
public endpoint yet): explicit events only, against an accessible output, with
a redacted summary and the closed attribution vocabulary — `observed`,
`influenced`, `directly_attributable`, or **null = unattributed (the
default)**; an invalid attribution is a 400, never coerced. **Outcome rows
inherit the source output's `visibility_scope`** and the read policies filter
on it — an outcome recorded against a stylist's private answer is never
owner-readable. Rules enforced by construction: nothing infers outcomes from
responses, feedback never creates an outcome, and no code path upgrades
attribution. Automatic user-reported-outcome extraction is deferred — the
storage/service foundation exists; a future task may add explicit "that
worked" capture with user-reported provenance.

## 6. Cost events

Every real model call persists: narration (`task_type 'qa'`), classification
(`'classification'`), and calls that billed but fell back (truncation,
ungrounded, live-claim, **refusal** — usage rides on the error and persists).
Fields: provider, model, tokens (input/output/reasoning), cache-hit,
**per-call latency** (not turn latency), `conversation_id`, `trace_id`,
`output_id` (null when the turn produced no output). **Pricing honesty**: real
usage with a $0 estimate (ZAC_PRICE_* not configured) persists
`estimated_cost_usd = NULL` plus a `cost_estimate_unavailable` spine event —
never a silent $0; a PARTIALLY configured price set logs a startup warning
(estimates would be understated). Aggregation reads
(`listCostEventsForConversation` / `listCostEventsForBusiness`) exist for
later cost-per-conversation/insight analysis — server-internal, businessId
always from a guard-verified context; no dashboards in Phase 1.

## 7. Failure semantics

The turn flush (output → tool calls → cost events) is **fail-soft** and
per-stage observable (`persistence_failed` spine events with
`measurement_*` operations); the user's answer never breaks because telemetry
storage is down — `output_id` comes back null. Feedback and outcomes are
**fail-hard** explicit writes. No DB transaction is held across an LLM call:
all persistence happens after the answer is fully constructed.

## 8. Security

Server-owned writes only (service role; forced RLS; `authenticated` is
SELECT-only). Every read/write scopes by the guard-verified acting context —
business, actor, current role — and output access re-evaluates per request.
Migration 0090 also fixes the 0077 read policies so `user_private` content is
excluded from owner-wide selects on BOTH `zac.outputs` and
`zac.outcome_events` (actors read their own; owners read business-scope rows).
Known, accepted boundary: `zac.tool_calls` / `zac.cost_events` remain
owner-readable operational **metadata** by 0077 design — an owner can see that
a stylist used ZAC (tool names, timing, token counts, output ids) but never
the content of a private answer, which stays behind the outputs policies.

## 9. Database

Migration **`0090_zac_measurement_spine.sql`** (additive): `outputs` +=
`trace_id`/`request_mode`/`limitations`; `cost_events` += `output_id`,
`estimated_cost_usd` → nullable; `outcome_events` += `summary_redacted`;
feedback unique vote index; lookup indexes (outputs by conversation/trace,
outcomes and costs by output); outputs RLS policy replacement. Apply via the
storage runbook flow (0076 → … → 0089 → 0090, `supabase db push`); the hosted
Exposed-Schemas step from the runbook is unchanged and still required.

## 10. Running the tests

```bash
cd apps/api
npx jest src/zac/zac.service.spec.ts -t "measurement spine"   # the spine suite
npx jest src/zac                                              # everything ZAC
```
