# ZAC — Request Modes & Instruction Following (Phase 1, implemented)

> **Status: implemented** — describes code on the current branch
> (`apps/api/src/zac/routing/` + the orchestrator). Supersedes any earlier
> statement that every meaningful ZAC question routes through a business tool:
> **tool use is now conditional on the request mode.**

This layer resolves Luke's behavioural sign-off feedback: ZAC distinguishes
*analyse my data* from *give me general advice* and *reason about a
hypothetical*, honours explicit instructions like "forget the QLOOQO data",
and can explain the acting user's actual access boundaries.

---

## 1. The closed mode set

`ZacRequestMode` ([zac-request-mode.types.ts](../../apps/api/src/zac/routing/zac-request-mode.types.ts)):

| Mode | Meaning | May run operational tools? |
|---|---|---|
| `qlooqo_data` | Their real business/salon data | **Yes** — the full permission-aware pipeline (intent routing, stylist router, staff check, grounding) |
| `general_advice` | General salon/business guidance | No — one no-evidence model call |
| `hypothetical` | Supplied scenario / "ignore my data" | No — reasons only from supplied figures + the actor's own stated goals |
| `memory` | "What do you remember…" | No — the existing memory system |
| `permission_capability` | "What am I allowed to see?" | No — reads the acting context + registry metadata only |
| `conversational` | Follow-ups, acknowledgements | No — model reply (bare "thanks" answers deterministically, zero cost) |

The enum is closed and server-authoritative. The mode decides **how ZAC
reasons — never what the actor may access**: every tool dispatch re-checks
role + permissions exactly as before, so classification cannot enable a
forbidden tool, and advisory paths contain no dispatch code at all
(structurally tool-free).

## 2. Classification precedence

`ZacRequestModeClassifierService`, deterministic layers first:

1. **Memory recall** (single source of truth: the memory extractor).
2. **Explicit current-turn data instructions** — always beat keyword inference
   and stale conversation context:
   - *"forget/ignore/don't use my (QLOOQO) data/figures"* → `hypothetical`
     when a scenario is supplied, else `general_advice`;
   - *"use my actual data" / "based on my current figures" / "don't give me
     generic advice"* → `qlooqo_data`.
3. **Permission-boundary questions** ("allowed to see", "my permissions",
   "why can't you show me…", "can I see [restricted thing]").
4. **Capability/identity** ("what can you do", "who are you") — stays on the
   existing capability tool.
5. **Hypothetical framing** — suppose/imagine/what-if/fictional/hypothetically,
   or a conditional over supplied numbers ("if a stylist has… 50%… 40%…").
6. **General-advice framing** — leading "generally"/"in general", "N ways
   to…", best practices, indefinite subjects ("how should *a* salon
   manager…"). **Business nouns alone never force a tool** — "improve
   rebooking" is advice unless anchored to *my/our* data.
7. **Conversational** — acknowledgements, "explain that more simply", "why did
   you recommend that".
8. **Own-data anchors** — *my/our* + business noun, imperatives ("show
   business revenue"), staff-list phrases → `qlooqo_data`.
9. **Ambiguous** → optional model tie-break (`classifyMode` on the provider):
   one tiny call, output validated against the closed enum (invented modes are
   discarded), priced as `task_type: 'classification'`. No model → the
   fail-safe default `qlooqo_data`, which is exactly the pre-mode pipeline.

## 3. Grounding by provenance

Three number provenances, each with its own structural protection:

| Provenance | Where it may appear | Protection |
|---|---|---|
| **QLOOQO evidence** (tool output) | narrated data answers | numeric allow-set: every narration number must exist in the evidence pack |
| **Memory context** (stated goals) | data + hypothetical answers | allowed only in attribution-shaped sentences ("your stated goal of 60%") |
| **User-supplied assumptions** | advisory answers | no evidence banner exists to fake; derived arithmetic ("a 10-point gap") is legal, but the **live-claim guard** rejects any sentence presenting a figure as the user's *current/actual* number (`model_fallback: live_claim`) |

Advisory responses carry `zac.reasoning` evidence markers and explicit
limitations ("no QLOOQO business data was read for this answer") — never tool
evidence, never fabricated confidence.

## 4. Permission explainability

`permission_capability` answers are generated per-request from **effective**
state, never from the role name:

- accessible areas = the registry's permission-filtered visible tools;
- boundaries = connected tools the actor's *role* would allow but their
  *current security level* blocks (`ZacToolRegistryService.permissionGapsFor`),
  described as categories — no record details, no internal permission IDs;
- role-scope boundaries (manager location scope, stylist role territory);
- the fixed privacy rule both ways (stylists' private coaching notes are never
  visible to owners/managers; colleagues' notes never visible to stylists);
- the Phase 1 read-only list (no bookings/clients/staff/stock/prices/payments/messages).

Descriptive only: the answer states that describing an area never grants it,
and dispatch re-checks permissions when data is actually requested. Changed
permissions are reflected on the very next question (nothing is cached).

## 5. Luke's acceptance scenarios (regression-tested)

- *"Forget the QLOOQO data for this question. If a stylist has a rebooking
  target of 50% and is currently achieving 40%, what would you recommend…"* →
  `hypothetical`, zero tool dispatches, one no-evidence model call using 50/40
  as assumptions, no test-business figures, no re-introduction
  (`request modes: instruction following (Luke sign-off scenario)` in
  [zac.service.spec.ts](../../apps/api/src/zac/zac.service.spec.ts)).
- *"What information am I allowed/not allowed to see based on my
  permissions?"* → the effective-permission explanation above
  (`permission explainability` suite).

Run them: `cd apps/api && npx jest src/zac/zac.service.spec.ts src/zac/routing`.

## 6. Security boundaries (tested)

Classification cannot enable a forbidden tool (dispatch re-checks);
hypothetical/general/conversational handlers have no dispatch path at all;
"pretend I'm the owner", "ignore your permission rules", hypothetical/fictional
framings around protected data all leave the acting identity, permissions and
memory visibility untouched; ambiguous-classification model output outside the
closed enum is discarded. See `request modes: prompt injection cannot change
authorisation` and the classifier spec.

## 7. Telemetry

Each turn emits `request_classified` (`request_mode`,
`classification_source`, `explicit_data_instruction` — metadata only), and the
response's `technical_details` carries `request_mode` +
`classification_source`. Classification model calls are priced as
`task_type: 'classification'` cost events.
