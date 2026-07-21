# ZAC — Phase 0 Documentation

**ZAC** is the proposed **server-side, permission-aware, evidence-grounded intelligence layer inside QLOOQO** — an assistant that explains, coaches, and recommends for owners, managers, and stylists, grounded in QLOOQO's own data.

> ### ⚠️ Documentation only — nothing here is implemented
> Everything in this folder is **Phase 0 discovery and architecture planning**. No ZAC code, NestJS module, database migration, permission, `zac` schema, environment variable, or package change exists in the repository. Module paths, schemas, and file trees named in these documents are **proposed future designs**, not existing artifacts. Do not treat any of it as built.

---

## Contents

| Document | What it is |
|---|---|
| [`QLOOQO/ZAC Phase 0 Discovery Report.md`](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md) | **Day 1** — read-only discovery of the QLOOQO repo + Supabase (dev-test branch): repo map, data model, tenant/role/permission model, reporting/KPI surface, constitution→architecture mapping, measurement architecture, and the risks/unknowns that shape ZAC. |
| [`phase-0-day-2-core-architecture.md`](phase-0-day-2-core-architecture.md) | **Day 2** — the core technical architecture: request flow, Phase 1 product direction (read-only), role experiences, proposed module layout, Context Assembler, Permission-Aware Tool Registry, response/recommendation contracts, model router, measurement & cost telemetry, channel architecture, and hard decisions to lock. |
| [`phase-0-day-3-knowledge-tools-outcome-memory.md`](phase-0-day-3-knowledge-tools-outcome-memory.md) | **Day 3** — defines ZAC's knowledge architecture, Phase 1 read-only tool structure, Context Memory, Outcome Memory, recommendation lifecycle, attribution model, privacy boundaries, and minimum measurement spine. |
| [`phase-0-decision-log.md`](phase-0-decision-log.md) | The recommended-to-lock decisions (Day 2 + Day 3), product-direction decisions, and the open questions for Cosan (technical) and Luke (product), each with status. |
| [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md) | The bridge to the codebase: where ZAC attaches to existing modules/guards/endpoints, the proposed `zac` schema, and a suggested integration sequence — **for a future authorised phase, not now.** |

**Suggested reading order:** Day 1 Discovery Report → Day 2 Core Architecture → Day 3 Knowledge, Tools & Outcome Memory → Decision Log → Future Integration Notes.

---

## The one-paragraph summary

ZAC lives inside the QLOOQO backend (`apps/api/src/zac/`, *future*), authenticates as the **acting user's JWT** (never a service-role key, because DB-level tenant isolation is dormant), and reads only through the **existing guarded API** with tools gated by the user's own permissions. **Phase 1 is read-only** — ZAC coaches, explains, and recommends but takes no autonomous actions. Every answer is **evidence-grounded** (it quotes QLOOQO's deterministic KPI engine and report endpoints rather than inventing numbers) and every recommendation carries reason, evidence, and expected outcome. Every meaningful interaction is **measured from Phase 1** — conversations, recommendations, acceptance, and KPI snapshots — so the question *"what value has ZAC created this month?"* becomes answerable later. Future channels (in-app, website, voice, WhatsApp, phone) are **adapters over one core**, not separate systems.

---

## Phase 0 status

- **Day 1 (Discovery):** complete — see the Discovery Report.
- **Day 2 (Core Architecture):** captured in the Day 2 document above.
- **Day 3 (Knowledge, Tools & Outcome Memory):** captured in the Day 3 document above.
- **Next:** answer the open questions in the [decision log](phase-0-decision-log.md) and the Day 3 open decisions (Luke §22, Cosan §23) and confirm production schema parity **before** any Phase 1 build. Implementation is out of scope until explicitly authorised.

---

*This folder is planning documentation. No application source code, migrations, environment files, package manifests, or Supabase data have been created or changed to produce it.*
