# ZAC — Provider-Independent AI Architecture (implemented)

> **Status: implemented.** ZAC runs end to end on OpenAI, on Anthropic, or on a
> hybrid of the two, selected by one environment variable. **No live benchmark
> has been run**: this change makes the comparison possible and ships the
> harness for it; the numbers require API keys and have not been produced.

> **Nothing about product behaviour changed.** Permissions, privacy, evidence,
> memory, the Workstream 1 signal framework, priority logic and tool execution
> are untouched. The default profile is the shipped production design, so a
> deployment that sets nothing behaves exactly as before.

---

## 1. The rule

**ZAC business and orchestration code must not depend on OpenAI or Anthropic SDK
types.** Provider SDK imports live inside provider adapters; ZAC owns the
contracts on both sides of them.

This is asserted, not documented: `zac-provider-boundary.spec.ts` walks the ZAC
tree and fails if any file outside a three-entry adapter allowlist imports
`openai` or `@anthropic-ai/*`, if the Workstream 1 intelligence layer mentions a
vendor at all, or if orchestration branches on a provider id.

---

## 2. What was already right

The audit's most useful finding was how little was actually wrong. SDK imports
were **already** confined to two adapter files, and the ZAC-owned contracts —
`ZacModelRequest`, `ZacModelCompletion`, `ZacSemanticRouterInput/Outcome`,
`ZacAnalysisPlanInput/Outcome`, `ZacPrioritySynthesisInput/Outcome` — carried no
vendor type anywhere. The evidence, memory and conversation packs were already
provider-neutral.

Two consequences shaped the whole approach:

- **This is a re-wiring, not a rewrite.** The contracts were right; they were
  just all welded to one implementation.
- **Several abstractions the brief anticipates were not needed.** ZAC does no
  model-driven tool *calling*: the planner returns tool NAMES through a
  structured output and the server dispatches. So a `ZacToolCall` normaliser and
  a provider tool-definition translator would have been abstractions over
  something that does not happen. `ZacToolDefinition` already exists as
  `ZacReadOnlyTool`, and the permission-filtered catalogue is produced
  server-side and re-checked at dispatch. Inventing the missing layers would
  have added contracts nothing implements.

---

## 3. Provider coupling that was real

| Coupling | Consequence |
|---|---|
| `ZacModelProvider` bundled all four capabilities in one interface bound to one DI token | Routing could not run on one vendor while synthesis ran on another, except through the one bespoke seam (`ZAC_SEMANTIC_PROVIDER`) that had been cut for the router migration |
| Provider construction lived in `zac.module.ts` `useFactory` blocks keyed on API keys | The key WAS the profile: an absent key silently changed which vendor ran |
| No `AnthropicSemanticProvider`; Anthropic routed through `ZacModelProvider.classifyRequestMode` | An all-Anthropic profile had no dedicated router seam |
| **No OpenAI reasoning or synthesis implementation at all** | `ZAC_AI_PROVIDER=openai` was impossible, and so was the benchmark |
| The ZAC constitution and narration prompts were private functions inside the Anthropic adapter | Any second vendor would have needed its own copy — and a provider comparison across two constitutions measures nothing |

---

## 4. Architecture after

```
ZAC orchestration  (zac.service, orchestrator, router — unchanged)
        │  depends only on ZAC-owned ports
        ▼
ZacAiProviderResolver ......... the ONE place that answers "which vendor, which capability"
        │
        ├── ZacSemanticProvider   semantic_routing        (reused, unchanged)
        ├── ZacReasoningProvider  tool_planning + structured_reasoning
        └── ZacSynthesisProvider  answer_synthesis
                │
                ├── OpenAiSemanticProvider     (existing)
                ├── OpenAiZacProvider          (NEW: reasoning + synthesis)
                └── Anthropic capability adapters over AnthropicZacModelProvider

ZacCompositeModelProvider implements the legacy `ZacModelProvider` from the
resolved ports, so zac.service.ts and zac-orchestrator.service.ts need no change.
```

`ZacCompositeModelProvider` is the reason this landed without touching a
2,300-line orchestration file. `ZacModelProvider` was a good ZAC-owned contract;
its only flaw was that one object had to answer for every capability. The
composite keeps the shape and removes the weld.

---

## 5. Profiles

```
ZAC_AI_PROVIDER=openai      semantic + reasoning + synthesis → OpenAI
ZAC_AI_PROVIDER=anthropic   semantic + reasoning + synthesis → Anthropic
ZAC_AI_PROVIDER=hybrid      per-capability (the DEFAULT)
                              ZAC_SEMANTIC_PROVIDER   (default openai)
                              ZAC_REASONING_PROVIDER  (default anthropic)
                              ZAC_SYNTHESIS_PROVIDER  (default anthropic)
```

**Unset = `hybrid` with the shipped production assignment.** Any other default
would have made this refactor a behaviour change for every existing deployment.

**It fails fast.** An unsupported profile or capability provider throws at boot
with the supported values. A silent fallback is the worst outcome available
here: `ZAC_AI_PROVIDER=openal` would quietly benchmark Anthropic and report it
as OpenAI, and every conclusion drawn from that run would be wrong in a way
nothing surfaces.

**A single-vendor profile ignores — and reports — stray per-capability
overrides**, so an operator whose benchmark is not measuring what they think is
told rather than left to find it in the numbers.

**A missing key degrades; it never re-providers.** If `ZAC_AI_PROVIDER=openai`
and `OPENAI_API_KEY` is absent, the capability is left unbound and reported in
`ai_degradations` — it does not quietly move to Anthropic, because a benchmark
that silently measures the other vendor is worse than one that does not run.

---

## 6. Model selection, independent of provider selection

| Canonical | Compatibility alias (still honoured) | Default |
|---|---|---|
| `ZAC_ANTHROPIC_SYNTHESIS_MODEL` | `ZAC_MODEL_ID` | `claude-opus-5` |
| `ZAC_ANTHROPIC_SEMANTIC_MODEL` | `ZAC_ROUTER_MODEL_ID` | `claude-sonnet-5` |
| `ZAC_OPENAI_SEMANTIC_MODEL` | `ZAC_SEMANTIC_MODEL` | `gpt-5.6-luna` |
| `ZAC_OPENAI_REASONING_MODEL` | — | `gpt-5.6-luna` |
| `ZAC_OPENAI_SYNTHESIS_MODEL` | — | `gpt-5.6-luna` |

Aliases take effect when the canonical name is unset. They are kept and
documented; a deprecation would be a separate, announced change with a release
note, not a side effect of a refactor. Every default is configuration to be
settled by the benchmark, not a commitment.

---

## 7. Prompt versioning — task semantics vs provider formatting

Provider independence does not require byte-identical prompts. It requires that
the **semantic contract** never diverges.

- `models/zac-synthesis.prompt.ts` (NEW) holds the ZAC constitution, the
  evidence-only rule, the untrusted-question framing, the memory-is-not-
  measurement separation, the requested-count instruction and the advisory-mode
  rules. Extracted **verbatim** from the Anthropic adapter, so shipped narration
  behaviour is unchanged and the existing narration tests still bind. Both
  vendors build their prompts from it.
- The planner and priority-synthesis prompts were already shared modules; each
  now carries a second, strict-mode schema beside its tool schema
  (`ZAC_ANALYSIS_PLANNER_OPENAI_SCHEMA`, `ZAC_PRIORITY_SYNTHESIS_OPENAI_SCHEMA`),
  following the precedent `ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA` set.

**Two schemas rather than one converter.** The strict Structured Outputs subset
is narrow — allowlisted keywords, every object closed, every property required,
**no numeric types at all** — so a generic converter would have to make lossy
choices silently. Written out, both schemas are validated by the same boot-time
allowlist (`findStrictSchemaViolations`) that exists because a rejected keyword
once 400ed every semantic call for weeks.

The one genuine divergence it forces: the planner's `confidence` is a **bucket**
on the OpenAI wire and a number on the Anthropic one. The adapter maps it back
through `confidenceBucketScore`, exactly as the semantic router already does, so
the server's confidence policy is identical either way.

---

## 8. Normalisation

| Concern | ZAC contract | Notes |
|---|---|---|
| Capabilities | `ZacAiCapability` | `semantic_routing`, `tool_planning`, `structured_reasoning`, `answer_synthesis`. No embeddings/RAG — out of scope. |
| Failures | `ZacAiFailureKind` | 10 values. `ZacSemanticFailureKind` is **not** replaced — it drives shipped health snapshots and `/zac/health.semantic_last_failure_kind` — but is mapped onto the wider taxonomy by `toZacAiFailureKind`. |
| Usage | `ZacAiUsage` / `ZacModelCompletion` | `cachedInputTokens` is optional because "not reported" and "nothing cached" are different facts. The OpenAI adapter subtracts cached reads from `input_tokens`, which is a TOTAL — reporting it whole would bill cache reads at the full rate. |
| Finish reasons | `ZacAiFinishReason` | Vendor stop reasons stay inside adapters. |
| Conversation | `ZacModelRequest` + packs | Already provider-neutral; persisted conversation storage untouched. |

**An AI provider failure is never reported as "your QLOOQO data is
unavailable".** That distinction predates this work (the blocking-reason
precedence depends on it) and every new adapter path preserves it: reasoning
failures return typed outcomes and the deterministic path takes over.

---

## 9. Health and debug metadata

`/zac/health` gains `ai_provider_profile`, `reasoning_provider`,
`reasoning_model`, `synthesis_provider`, `synthesis_model` and
`ai_degradations`, all read from configuration. **No provider is called to
answer a health request** — a health check that bills and can fail is not a
health check.

`technical_details` gains the same profile fields, and the routing inspector
renders them as `AI profile`, `Reasoning provider/model` and `Synthesis
provider/model` — behind the existing debug/UAT flag, which is unchanged.

Cost events gain `provider_profile` and `capability`. Without both, a hybrid
run's rows are unattributable: two calls to two vendors in one turn look like
two unrelated rows, and "cost per routed request" cannot be separated from
"cost per answer".

---

## 10. The benchmark harness

```
OPENAI_API_KEY=… ANTHROPIC_API_KEY=… pnpm --filter @sheer/api zac-provider-benchmark
```

Runs the same workload per profile and reports **four separate scorecards** —
routing, planning, synthesis, operational — never a single "answer quality"
number.

What makes the comparison fair:

- the profile is set per run through an **isolated config object**, never by
  mutating `process.env`, so one run cannot leak configuration into the next;
- every profile gets the same datasets (350 routing cases, 135 orchestration
  cases, 3 synthesis fixtures), the same roles, the same frozen QLOOQO
  fixtures, the same permission-filtered catalogue and the same prompts;
- **a profile whose keys are absent is SKIPPED and reported as skipped**, never
  scored as zero. "We did not measure this" and "this scored nothing" are
  different facts and only one of them is honest.

Run metadata (commit SHA, timestamp, router version, prompt version, dataset
sizes, resolved bindings per profile) is printed with every run, because a
result without it is not reproducible.

**Certification** applies hard safety gates — hypothetical never reads live
data, no live-data false positives on advice, no unavailable-tool proposals, no
unsupported numeric claims — counted, never rated. A profile failing any gate is
not releasable whatever its quality numbers say. Quality is reported as
trade-offs; **no winner is declared**.

---

## 11. No cross-provider fallback

Deliberately not built. A provider failure does not silently retry on the other
vendor, because we have no certification evidence yet that both satisfy the same
capability contract, and an automatic failover would make a benchmark
un-interpretable. The existing safe fallback behaviour — the router's fallback
ladder and the deterministic tool-backed answer — is unchanged and is still the
degradation mode.

---

## 12. Tests

| Suite | Result |
|---|---|
| Provider-switch / profile resolution | 17 passed |
| OpenAI reasoning + synthesis adapter | 20 passed |
| Import boundary | 5 passed |
| Behavioural parity | 7 passed |
| Full API suite | 2507 passed, 226 todo, 120 suites, 0 failed |
| API typecheck / lint | clean |

Parity asserts the property that makes a benchmark meaningful: with two
providers held to identical ZAC-contract outputs, the permission-filtered
catalogue, evidence signals, priority consolidation, requested-count enforcement
and dispatch statuses are **byte-identical**. If vendors could reach different
tool sets, a "quality" difference between them would partly be a difference in
what they were allowed to see.

---

## 13. Known limitations

1. **No live benchmark has been run.** No API keys were available in this
   environment. Every default model is a carried-forward assumption, not a
   measured choice. No provider is claimed to be better than the other.
2. **The OpenAI reasoning and synthesis paths are unit-tested against a mocked
   SDK, never against the live API.** Their schemas pass the boot-time strict
   allowlist, but a live 400 remains possible until a real call is made.
3. **`AnthropicSemanticProvider` is an adapter over the existing whole-vendor
   classifier**, not a separately tuned router. An all-Anthropic profile routes
   with the shipped Anthropic classifier and prompt.
4. **The synthesis benchmark is 3 fixtures**, enough to measure grounding and
   requested-count compliance, not enough to rank narration quality.
5. **`ZAC_ROUTING_MODE` still gates the dedicated router** independently of the
   AI profile; a `legacy` deployment keeps its pre-migration routing whatever
   `ZAC_AI_PROVIDER` says. The benchmark forces `semantic` for its own runs.

---

## 14. Files

**New**

```
apps/api/src/zac/ai/zac-ai.types.ts
apps/api/src/zac/ai/zac-ai-ports.ts
apps/api/src/zac/ai/zac-ai-profile.config.ts
apps/api/src/zac/ai/zac-ai-provider.resolver.ts
apps/api/src/zac/ai/zac-composite-model.provider.ts
apps/api/src/zac/ai/zac-ai-provider.resolver.spec.ts
apps/api/src/zac/ai/zac-provider-boundary.spec.ts
apps/api/src/zac/ai/zac-provider-parity.spec.ts
apps/api/src/zac/models/zac-synthesis.prompt.ts
apps/api/src/zac/models/providers/capability.adapters.ts
apps/api/src/zac/models/providers/openai-zac-provider.ts
apps/api/src/zac/models/providers/openai-zac-provider.spec.ts
apps/api/scripts/zac-provider-benchmark.ts
docs/ZAC/provider-independent-ai-architecture.md
```

**Changed**

```
apps/api/src/zac/zac.module.ts                        resolver-driven wiring
apps/api/src/zac/zac.service.ts                       resolver injected; health + technical_details + cost attribution
apps/api/src/zac/models/providers/anthropic-zac-provider.ts   prompt builders moved to the shared module
apps/api/src/zac/models/zac-model-provider.interface.ts       (unchanged contract; still the composite's shape)
apps/api/src/zac/analysis/zac-analysis-planner.prompt.ts      + OpenAI strict schema
apps/api/src/zac/analysis/zac-priority-synthesis.prompt.ts    + OpenAI strict schema
apps/api/src/zac/measurement/zac-cost-telemetry.service.ts    + provider_profile, capability
apps/api/src/zac/responses/zac-response.types.ts              + profile fields on health and technical_details
apps/api/src/config/env.validation.ts                        + provider/model variables
packages/domain/src/zac-routing.ts                           + AI profile inspector rows
```
