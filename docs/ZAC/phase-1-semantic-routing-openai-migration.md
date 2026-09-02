# ZAC semantic routing migration — OpenAI structured semantic router (semantic-v2)

**Status:** implemented, offline-verified, **live-benchmarked against OpenAI (2026-09-02)**;
hosted acceptance still PENDING (nothing in this document claims a hosted run).
**Date:** 2026-09-02 · **Router version:** `semantic-v2` · **Prompt version:** `2026-09-02.1`

---

## 1. What changed, and what deliberately did not

The migration adds a **dedicated semantic-routing provider** (OpenAI Responses API, strict
Structured Outputs) behind a routing-mode switch, and extends the routing verdict with
`analysis_intent`, `information_source` and bucketed confidence. It does **not** move
authentication, tenancy, location scope, permissions, privacy boundaries, tool availability, tool
execution, or grounding: every one of those still runs server-side exactly as before, and every
tool dispatch re-checks role and permission regardless of how the mode was decided.

The three-layer hybrid router is retained in every mode:

```
Layer 1  deterministic explicit directives   (classifyExplicit / detectDataInstruction)
Layer 2  semantic meaning                    (mode-dependent: legacy model classifier | OpenAI v2)
Layer 3  safe fallback ladder                (exclusions → scenarios → clarification → floor)
```

Explicit user directives ("don't use my QLOOQO data", "use my actual figures") remain
deterministic, remain Layer 1, and remain a hard veto over any model verdict (brief §9). Classifier
call failures still fail CLOSED to a clarifying question, never open into the data pipeline, and a
routing/provider failure is never reported as "your business data is unavailable" (brief §16, §20).

## 2. Architecture

### Before (semantic-v1, current production)

```
question → classifyExplicit (L1) → AnthropicZacModelProvider.classifyRequestMode (L2, forced tool
call, numeric confidence) → validate against closed enums → confidence policy (0.7/0.45/0.85) →
fallback ladder (L3) → policy → planner → permission-filtered dispatch
```

### After (semantic-v2, `ZAC_ROUTING_MODE=semantic`)

```
question → classifyExplicit (L1, unchanged) → OpenAiSemanticProvider.classify (L2, Responses API,
text.format json_schema strict:true, bucketed confidence, analysis_intent, information_source) →
validate (closed enums + §11 coherence rules + bucket→score projection) → SAME confidence policy →
SAME fallback ladder (L3) → policy → planner → permission-filtered dispatch
```

Key files:

| Concern | File |
| --- | --- |
| Provider seam | `apps/api/src/zac/models/zac-semantic-provider.interface.ts` (`ZAC_SEMANTIC_PROVIDER` token) |
| OpenAI provider | `apps/api/src/zac/models/providers/openai-semantic-provider.ts` |
| v2 prompt + strict schema + versions | `apps/api/src/zac/routing/zac-semantic-router.prompt.ts` |
| Routing modes, shadow, v2 validation | `apps/api/src/zac/routing/zac-semantic-router.service.ts` |
| v2 contract types | `apps/api/src/zac/routing/zac-request-mode.types.ts` |
| Boot-time strict-schema allowlist | `apps/api/src/zac/models/zac-semantic-health.service.ts` (`findStrictSchemaViolations`) |
| Factory wiring | `apps/api/src/zac/zac.module.ts` |
| Telemetry + health surface | `apps/api/src/zac/zac.service.ts` |
| Live harness + benchmark | `apps/api/scripts/zac-routing-eval.ts` |

### The decision contract (v2 wire shape)

All fields required, all enums closed, no numerics anywhere (numeric bounds are the exact keyword
class that made earlier semantic calls 400 silently — confidence is a bucket enum instead):

```
mode                        qlooqo_data | general_advice | hypothetical | memory |
                            permission_capability | privacy_boundary | conversational
analysis_intent             none | specific_metric | business_health | business_priorities |
                            team_priorities | diagnostic | comparison | explanation
information_source          live_qlooqo | general_knowledge | user_hypothesis | zac_memory |
                            capability_context | none
confidence                  high | medium | low
requires_live_business_data boolean
reason_code                 (the ten closed routing reason codes)
resource_category           (the thirteen closed resource categories — descriptive, never a grant)
```

Notes against the brief's §2–4 contract: the platform's closed mode set includes
`privacy_boundary` (retained — it backs a pinned refusal behaviour), and the verdict keeps
`requires_live_business_data` and `resource_category` (both existing, load-bearing: the first
drives the veto/corroboration policy, the second makes refusals more specific). The brief allows
"keep or adapt"; this is the adaptation, and the router still cannot invent values outside the
schema. The router input carries no user id, business id, location id, permissions, SQL or tool
names — `ZacSemanticRouterInput` is the question, the role LENS, and up to three redacted turn
summaries.

### §11 server-side validation (never trust the schema alone)

- Out-of-enum mode / reason code / (v2) intent / (v2) source → verdict discarded whole.
- `qlooqo_data` must claim `live_qlooqo` + a non-`none` intent; every other mode must claim its
  fixed source (`ZAC_MODE_INFORMATION_SOURCE`) and intent `none`. Violations void
  self-consistency, which caps confidence below the accept threshold — the verdict cannot reach
  tool execution on its own say-so.
- Hard invariant, enforced at validation AND at the router's exit (`finalize()`): a
  non-`qlooqo_data` classification NEVER carries an analysis intent.
- Buckets project onto the existing measured thresholds (high→0.9, medium→0.6, low→0.3 against
  accept 0.7 / review 0.45 / override 0.85). These are projections, not new thresholds;
  recalibration comes from the live harness's per-bucket correctness table (brief §21).

### Router ≠ planner (brief §13–14)

The router's `analysis_intent` is a HINT and a telemetry fact. The tool planner keeps deciding
which tools run, from a server-filtered catalogue, re-validated at the registry and re-checked at
dispatch. The hint's only behavioural effect: it can WIDEN the analysis gate for an unplaced
live-data question (`zac.service.ts`, the `hasAnalysisSignal || router intent` condition), which
is what lets keyword-free broad questions ("anything jumping out?") reach the multi-tool analysis
pipeline instead of the capability summary. It can never narrow anything, name a tool, or touch
permissions.

## 3. Configuration

```
ZAC_ROUTING_MODE=legacy|shadow|semantic     (default legacy)
ZAC_SEMANTIC_PROVIDER=openai                (default openai; the only implementation today)
OPENAI_API_KEY=...                          (the switch: absent ⇒ no dedicated router, loudly)
ZAC_SEMANTIC_MODEL=gpt-5.6-luna             (benchmark winner; see §6)
ZAC_SEMANTIC_REASONING_EFFORT=none          (unset = lowest each family accepts; self-corrects on rejection)
ZAC_SEMANTIC_PRICE_INPUT_USD_PER_MTOK=      (cost spine; no fallback to Anthropic rates)
ZAC_SEMANTIC_PRICE_OUTPUT_USD_PER_MTOK=
ZAC_SEMANTIC_PRICE_CACHE_READ_USD_PER_MTOK=
```

The OpenAI call: `client.responses.create` with `instructions` = the byte-stable v2 prompt,
`text.format = {type:'json_schema', name:'zac_semantic_route', schema, strict:true}`,
`store:false` (the question must not persist server-side), `prompt_cache_key` pinned to the prompt
version, timeout 15s, no retries (measured on the winner, serial calls: p50 2.1s, p95 3.9s, max 8.5s — the cap
sits above the observed maximum; brief §17).

## 4. Failure taxonomy, health, degraded mode

Unchanged taxonomy, now exercised by a second vendor: routing failures are
`classification_timeout | classification_refused | classification_invalid |
classification_low_confidence | provider_unavailable | router_disabled`; observability kinds are
`auth | credit | schema | rate_limit | timeout | refusal | invalid_output | transport` (OpenAI's
429 `insufficient_quota` maps to `credit`, not `rate_limit`). `/zac/health` now also reports
`routing_mode`, `semantic_provider`, `semantic_model`, `router_version`, `prompt_version`;
`uat_ready` remains EVIDENCE-based (a real classification must have succeeded, nothing hard-failed
since, schemas boot-valid) and in semantic mode that evidence is the OpenAI pipeline's. Shadow
health is tracked under a separate `shadow_router` capability so shadow failures can never degrade
the authoritative pipeline's readiness. Health never makes a model call.

## 5. Shadow mode and disagreement review (brief §24–25)

`ZAC_ROUTING_MODE=shadow`: legacy decides every turn; the OpenAI router classifies the same turn
concurrently (including Layer-1 short-circuited turns), and when it settles a
`zac.spine.shadow_classification` event records: legacy mode/source/reason, shadow
mode/reason/bucket/intent/source, `mode_agreement`, `live_data_agreement`, typed failure + kind,
latency, tokens, estimated cost, router/prompt versions. Tool execution is never duplicated — only
the classification is shadowed, and the shadow verdict cannot steer the turn (enforced by test).
Disagreement review = filter the spine for `mode_agreement:false`, categorise per §25.

## 6. Offline evaluation and live benchmark

- Dataset: `routing-eval-dataset.json` — grown past 300 cases, every `qlooqo_data` case labelled
  with `expectedIntent`, the client-required §27 prompts included verbatim (mandated), plus long
  rambling prompts, injection cases, and every closed mode floor-guarded at ≥20 (including
  `privacy_boundary`, previously uncovered by the floor check).
- Offline (no network, jest): deterministic floor, v1 oracle plumbing, and the new **configuration
  3** — a v2 oracle through `semantic` mode proving the v2 verdict survives validation, the veto,
  the confidence policy and the ladder, that intents pass through only on live-data turns, and
  that the mandated set stays at 100%.
- Live (network, one command): `scripts/zac-routing-eval.ts` runs the OpenAI pipeline
  (`ZAC_ROUTING_MODE=semantic`), reports every §29 metric the labelled set supports, and benchmarks
  several models in one run.

### Live benchmark — 2026-09-02, 350 cases, 193 semantic calls per model (157 Layer-1 short-circuits)

| model (effort) | accuracy alt / strict | live-data FP | live-data FN | hypo→data | intent acc | BP recall | `high` correct | p50 / p95 (conc. 2) | $/routed req | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **gpt-5.6-luna (none)** | **99.1% / 94.3%** | 1/188 (0.5%) | 1/99 | 0 | **87.1%** | 10/10 | 99.0% | 4.2 s / 5.8 s | **$0.000185** | **passes — chosen** |
| gpt-4.1-mini (n/a) | 99.1% / 94.0% | 1/188 (0.5%) | 1/99 | 0 | 76.7% | 10/10 | 97.4% | 4.1 s / 5.3 s | $0.000612 | passes, 3.3× cost |
| gpt-5-mini (minimal) | 97.9% / 92.2% | 4/188 (2.1%) | 0/99 | **1** | 72.1% | 10/10 | 95.8% | 4.6 s / 6.8 s | $0.000280 | fails hypothetical gate |
| gpt-5-nano (minimal) | 88.3% / 83.1% | 2/188 | **16/99 (16%)** | 0 | 57.5% | 1/1 | 86.3% | 3.9 s / 5.4 s | $0.000061 | fails |

Serial (concurrency 1) latency on the winner: **p50 2.1 s, p95 3.9 s, max 8.5 s**, 0 timeouts. A first
run at concurrency 6 produced p50 12–14 s and 9–25 timeouts per model; a raw `curl` showed 5–10 s TLS
handshakes to `api.openai.com` from the build machine, so those figures were the network path, not the
models, and were discarded. Explicit no-live-data cases are Layer-1 short-circuits in every run (0 by
construction). Prompt caching was active throughout (~4.3k cached tokens per call).

Remaining misroutes on the winner, 3 of 332: "Is that a lot?" (conversational → qlooqo_data, a bare
follow-up), "quiet feb again?" (qlooqo_data → conversational), and "why cant you show me chloe's
coaching notes" (Layer-1 privacy-probe precedence, never reaches the model). None is client-mandated.
Intent misses (8 of 62) are almost all comparison↔diagnostic and specific_metric→comparison — label
boundaries a human would also argue over; business_priorities, the flagship multi-tool intent, is
10/10 on every passing model.

Confidence buckets: the gpt-5.x and 4.1 tiers answer `high` on essentially every turn (192–193 of 193),
so the medium/low review bands rarely engage and the veto + coherence rules do the safety work. Only
gpt-5-nano spreads across buckets (and is calibrated: 86% / 64% / 33%). The bucket→score projection is
therefore retained unchanged; there is no evidence yet to move a threshold.

## 7. Cutover plan and legacy retirement (brief §36)

1. **legacy** (now): ship dark. Nothing changes at runtime; the OpenAI provider is not constructed.
2. **shadow** (hosted, ≥1 week of real traffic): set `ZAC_ROUTING_MODE=shadow` + key + prices.
   Review `shadow_classification` disagreements; run the live benchmark; pick the model; calibrate
   bucket thresholds if the calibration table says the projections are wrong.
3. **semantic**: set `ZAC_ROUTING_MODE=semantic` once shadow agreement holds (the §30 gates already
   hold on the offline set, §6).
   Rollback is one env change back to `legacy` (or `ZAC_SEMANTIC_ROUTER_ENABLED=false` for the
   pre-semantic floor in an incident).
4. **Retirement**: after semantic has held in hosted for an agreed soak (suggested: 2 weeks
   without a gate breach), delete the legacy Layer-2 path (`classifyRequestMode` on the model
   provider + the v1 prompt/schema) and demote `classifyHeuristic`'s shape rules to what they
   already are — Layer 3 fallback only. Layer 1 explicit-directive parsing is NOT legacy and is
   never retired. Duplicate routing logic must not outlive the cutover.

## 8. Hosted deployment steps

1. Merge; deploy the API (no DB migration is required by this change).
2. In the hosted environment set: `ZAC_ROUTING_MODE=shadow`, `OPENAI_API_KEY`,
   `ZAC_SEMANTIC_MODEL=<benchmark winner>`, `ZAC_SEMANTIC_PRICE_*` from OpenAI's current price
   sheet.
3. Confirm boot logs show NO strict-schema violations and no "runs without a dedicated semantic
   provider" warning.
4. `GET /api/zac/health` → expect `routing_mode:"shadow"`, `semantic_provider:"openai"`,
   `semantic_model` as configured, `schema_valid:true`.
5. Soak, review, then flip to `semantic` per §7.

## 9. Hosted acceptance procedure (brief §37)

With `ZAC_ROUTING_MODE=semantic`, as the pilot owner account, ask and verify:

| Prompt | Expect |
| --- | --- |
| "What is a stylist?" | general_advice, no operational tool in `tools_selected`/`source_used` |
| "What is my rebooking?" | qlooqo_data, live rebooking figures, `router_analysis_intent:"specific_metric"` |
| "If a stylist is at 40% against 50%, what should they do?" | hypothetical, no live tools |
| "Don't use QLOOQO data. What should someone at 40% do?" | advisory, no live tools, `explicit_data_instruction:"ignore"` |
| "tell me 2 most importnat things i should focus on" | qlooqo_data / business_priorities / `multi_tool:true` |
| "anything jumping out in my business?" | qlooqo_data / business_priorities |
| "What did I tell you my goal was?" | memory |
| "What can I access?" | permission_capability |

Then prove the classification actually came from OpenAI: each turn's `request_classified` spine
event must show `classification_source:"semantic_model"` (or `contextual_followup`),
`semantic_provider:"openai"`, `router_version:"semantic-v2"`, and `/zac/health` must show
`semantic_operational:true` with a fresh `semantic_last_success_at`. A run whose events show
`classification_source:"fallback"` or a deterministic source on the semantic prompts is NOT an
acceptance pass. Do not claim client sign-off from this procedure; it is an engineering gate.

## 10. Known limits / follow-ups

- Hosted validation has NOT run. The live benchmark has (§6); the default model, timeout and
  effort default now cite it. The bucket projections stand until shadow traffic shows a reason to
  move them.
- Multi-turn routing context remains the redacted turn summaries (the existing conversation
  state). Structured previous-mode state would need a `zac.messages` column — deliberately out of
  scope; the summaries already carry the mode shape and the eval's multi-turn cases pass on them.
- Shadow-call spend is recorded on the log-plane cost spine (`zac.cost_event`), not the per-turn
  DB buffer (the buffer flushes before a shadow call settles).
- The stale six-mode/262-case numbers in `phase-1-semantic-router.md` §7 and
  `phase-1-request-modes.md` §1 predate this work; this document supersedes them for routing.
