# ZAC — Semantic Multi-Tool Orchestration (Phase 1, implemented)

> **Status: implemented, full API suite green, hosted validation OUTSTANDING.**
> This closes the third hosted acceptance failure: *"Use everything you have
> access to and tell me the 3 most important things I should focus on"* was
> answered *"I don't yet have access to your live business data"* — while five
> permitted tools were executable and *"How is my business doing?"* worked in
> the same conversation.

## 1. Root cause

Not connectivity. **Orchestration.**

`ZacService.resolveIntent` mapped a question to **exactly one** tool by keyword.
`"How is my business doing?"` matched `how('s| is| are)\s+(my|the|our)\s+(business|salon)`
and dispatched `report.business_health` — which is why direct questions worked.

The broad question matched nothing. `resolveIntent` has a phrase for
`what should (i|we) focus`, but Luke's sentence reads *"the 3 most important
things I **should focus on**"*, which that anchor does not match. With no
intent, the pipeline fell to its universal fallback:

```ts
const intentTool = resolvedIntent ?? 'context.capabilities';
```

`context.capabilities` describes ZAC, and its copy ends:

> "I'm still in foundation mode: beyond the sources above, **I don't yet have
> access to your live business data**…"

So the failure chain was: *no keyword → no tool → the capability summary → a
sentence that is false whenever any live tool is connected.* Three separate
things — tool selection, capability description, and data availability — were
collapsed into one branch.

**Which layer failed:** tool selection and planning. Request-mode classification
was correct (`qlooqo_data`). The provider was never asked. And the answer that
resulted was not merely unhelpful, it was **untrue**.

**Was one tool per question assumed?** Yes, structurally: `resolveIntent`
returns `ZacToolName | null`, and one dispatch followed it.

## 2. The pipeline now

```
request mode  (qlooqo_data?)
   → fixed privacy / read-only policy      ← unchanged, still evaluated first
   → analysis intent                       ← NEW: what KIND of analysis?
   → permitted + enabled tool catalogue    ← the security boundary the planner sees
   → tool plan (model-proposed or deterministic)
   → server validation + cap
   → bounded parallel execution            ← per-tool timeout, per-tool permission re-check
   → evidence normalisation                ← comparable, source-attributed signals
   → deterministic ranking
   → LLM synthesis                         ← grounded across all sources
   → answer + honest limitations
```

Only `business_priorities`, `team_priorities` and `diagnostic` orchestrate.
Everything else keeps the existing single-tool route — **breadth is earned by
the question**, and `business_health` deliberately stays a single narrated
snapshot because that answer already worked and is already accepted.

## 3. Analysis intent

`specific_metric · business_health · business_priorities · team_priorities ·
diagnostic · comparison · explanation`

Decided in three layers: deterministic rules for the unambiguous shapes (a
named metric, an explicit overview, a why-question); the semantic planner for
everything that turns on meaning; a heuristic floor so a build with no provider
still behaves. **The floor is not the mechanism** — §61's point — and its
unrecognised-question default is `business_health`, never the capability
summary.

## 4. The planner

**Input:** the question, the role lens, and a catalogue of *permitted, enabled*
tools (name, purpose, domains). Nothing else — no identity, no business or
location ids, no permissions, no data, and memory only as KINDS (`business_goal`),
never as remembered text.

**Output (strict schema):** intent, reason code, confidence, synthesis strategy,
and up to five `{tool_name, purpose}` pairs.

**Validation:** every name must exist in *this actor's* catalogue; duplicates
dropped; cap enforced at `MAX_MULTI_TOOL_CALLS = 5`; malformed entries discarded
without taking the plan down. A model plan that survives with nothing in it is
replaced by the deterministic plan — **the turn still reads live data**.

Why the planner cannot widen access, in order: it is only shown permitted+enabled
tools → every returned name is re-validated against that same catalogue → the
registry re-checks role and permissions on every dispatch → and fixed privacy
and read-only policy already ran *before* any of this.

## 5. "Use everything" — the actual semantics

> Consider all **relevant currently permitted and connected** Phase 1 evidence
> sources needed to answer the question.

It does **not** mean call every registered tool, call disabled tools, call
another person's private data, or bypass permission. The planner is instructed
to prefer the smallest sufficient set: more sources cost latency and dilute the
answer without adding a priority anyone would act on.

## 6. Evidence and provenance

Raw payloads are not comparable — one reports pennies, another a percentage
against a configured threshold, another a per-stylist list. Handing all of that
to a model and asking it to prioritise invites invented arithmetic. Instead each
adapter extracts what its tool actually measured, and the server ranks:

```
priorityScore = severityWeight × confidence × materiality × direction
```

Only two derivations exist, both subtractions between values that are already
present: a cancellation share (`cancelled ÷ total`, both reported) and a gap to
a target. **Provenance never blurs:** `targetSource` distinguishes a threshold
from configuration (`tool_threshold`) from a goal the user stated
(`user_memory_goal`), and the synthesis prompt is told which is which. 52% live
against a 60% remembered goal is *one measurement, one stated goal and one
derived gap* — never "your target is 60%" presented as QLOOQO data.

## 6b. Priority consolidation (added after hosted testing)

Hosted testing found the orchestration gathering the right evidence and then
presenting it badly. For *"tell me 2 most importnat things i should focus on"*:

```
here are the 3 things I would focus on:
1. Rebooking rate — Rebooking is 0%, against your stated goal of 60%…
2. Rebooking rate — Rebooking is 0%, against your stated goal of 60%…
3. Stylists below their rebooking target — 6 of 6 stylists are below…
```

Three defects, one cause: **raw signals were ranked straight into user-facing
priorities.** `DEFAULT_PRIORITY_COUNT` was hard-coded, two tools each produced a
rebooking reading with no identity to compare, and the team's view of that same
problem was a third signal. Nothing between normalisation and narration knew
those were one issue.

The pipeline now runs:

```
signals → exact-duplicate removal → group by ISSUE → candidates
        → score the issue once → rank → take N → synthesis
```

* **Requested count** is parsed from the question (`requestedCount`), bounded
  1–5, defaulting to 3, and carried to planning, ranking, synthesis and the
  response. It parses the *number* and the *noun*, never the adjective between
  them — which is why "2 most importnat things" works without a typo dictionary.
* **Identity** is `issue | metric | scope | period | current | target`. Two tools
  reporting the same reading merge; the second one's evidence is kept.
* **Issue grouping** uses `issueKey`, set by the adapter that knows what it
  measured. "6 of 6 stylists below the rebooking target" carries
  `issueKey: 'rebooking'` — supporting evidence for the rebooking issue, not a
  slot of its own. A remembered goal joins the same candidate as an attributed
  target, never a second priority.
* **Scoring** is per issue: `severity × confidence × materiality × relevance ×
  capped corroboration`. Materiality is *proportional* — a two-point miss and a
  forty-point miss are not the same thing — and the corroboration bonus is
  capped so the most heavily instrumented metric cannot buy the top slot.
* **Synthesis is structured**: the model picks `candidate_id`s the server built.
  An invented id, a repeated id or too many priorities are validation failures,
  not something the user reads. Failure falls back to deterministic candidate
  rendering, which is also deduplicated and capped.
* **Fewer is allowed.** If only one issue is materially supported, one is
  returned, with a sentence explaining why rather than a padded third.

### 0% versus no data

`DashboardService` computes `completedBookings > 0 ? round(...) : 0`, so an
empty period arrives as a flat **0% rebooking** — indistinguishable from a
collapse, and far more alarming. The adapters now refuse to build a rebooking
signal when the denominator is zero: nothing was measured, so nothing is
claimed. A genuine 0% over real completed bookings still reports.

### Result for the reported case

| | Before | After |
|---|---|---|
| Requested | 2 | 2 |
| Returned | 3 | 2 |
| Raw signals | — | 8 |
| Exact duplicates removed | 0 | 1 |
| Signals merged into an issue | 0 | 1 |
| Candidates | — | 6 |
| Final domains | rebooking, rebooking, rebooking | **rebooking, utilisation** |


## 7. Failure modes, kept apart

| What happened | Reported as |
|---|---|
| Planner returned nothing usable | deterministic plan runs — user never learns |
| Plan empty AND no executable tools | `unsupported_capability` |
| Plan empty BUT tools executable | `data_unavailable` — *"I could not work out which report answers that"* |
| Some sources failed | a real answer, plus a limitation naming what could not be assessed |
| Every source failed | `data_unavailable` (or `permission_denied` if all denied) |
| Synthesis failed or was ungrounded | the deterministic ranked answer — plainer, fully verified |

**None of these say "I don't have live data".** `executable_tool_count` rides on
every analysis turn so any shortfall claim can be checked against reality.

## 8. Measurement

Existing spine, no new tables: one `source_used` event per tool (carrying
`analysis_intent`), the plan and its outcome in `technical_details`, a
`classification`-typed cost event for the planning call, and the existing `qa`
cost event for synthesis.

## 9. Evaluation

`orchestration-eval-dataset.json` — 135 cases written to share as few words as
possible with the rules (typos, three-word questions, rambling paragraphs,
role-swap framings). Deterministic floor, no model:

| Metric | Result |
|---|---|
| Analysis-intent accuracy | 85.2% |
| Business-priority recall | 79.0% (n=62) |
| Unnecessary multi-tool (narrow inflated) | 15.1% |
| Live data used on advice questions | 14.8% |
| Average tools per broad query | 3.45 |

These are floor numbers and the gates sit at the floor. The semantic planner is
the mechanism in production and is measured in hosted UAT.

## 10. Cost and latency

Orchestration overhead is **~38µs of CPU per turn** (plan + normalise + rank,
measured over 2,000 iterations). Wall clock is `max(slowest source)`, not the
sum, because independent read-only tools run concurrently with an 8s per-tool
timeout. Model spend is at most **one planning call** (low effort, cached system
prompt, router-tier model) plus **one synthesis call** — the same count as a
narrated single-tool turn plus one.

## 11. Outstanding

**Hosted validation has not been performed.** Run:

```
ZAC_BASE_URL=… ZAC_OWNER_TOKEN=… pnpm --filter @sheer/api zac-hosted-acceptance
```

Scenarios A–N now include Luke's exact question (K), a keyword-free paraphrase
(L), a narrow control (M) and an advice control (N), asserting mode, analysis
intent, multi-tool, live tools executed and the absence of false no-data
language. Phase 1 is not complete until that is green against the build Luke
tests.
