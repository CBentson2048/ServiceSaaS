# QLOOQO V1.1 Week 8 — R7 Cash Up

**Status:** G1 definition, 2026-09-15; product decisions and pre-G5 End of Day
source fixes 2026-09-15 (§8, §9, §11). Builds on
[Ticket A](week-8-ticket-a-foundation.md) (report registry, fail-closed access,
per-location windows) and uses the fact definitions of
[R1 Money](week-8-ticket-b-r1-money.md). R7 is COMPLETE only after its own G5.

**Ownership.** Cosan owns this ticket. No ZAC file and no Dashboard file changes.
The End of Day API received the approved no-migration source fixes D-2, D-5, D-6
and D-8 (§9); its trading-day window (D-1) is unchanged pending §11.

---

## 1. What R7 answers

For each selected location and each local trading day in that location's own
report window:

- was the till cashed up, and was the day signed off;
- what the till was expected to hold and what was counted, per tender (cash,
  card), as recorded at sign-off, and the variance;
- whether the money sources for a signed-off day have changed since it was signed
  off;
- what the till takings were on days without a signed-off cash-up;
- retail takings that never reach the till count (payment method *Other* or not
  recorded).

A day that was never cashed up is **No cash-up recorded**, never £0.00. A figure
R7 cannot state honestly is unavailable with a reason, never a zero.

## 2. Sources (verified on develop `0f4a35e`)

| Fact | Source | Attribution | Units |
|---|---|---|---|
| Cash-up record | `billing.eod_reconciliations`, filtered by `business_id` and `location_id` | `business_date` (a local date label), `location_id` | integer pence |
| Signed off by | `core.user_profiles.full_name` for `signed_off_by_user_profile_id` | the record | text |
| Variance threshold | `core.location_settings.cash_variance_threshold_amount` (current value) | the location | `numeric(12,2)` pounds → pence |
| Till takings | `billing.salon_payments` (cash, card reader) — R1's `tillPaymentsInWindows` | `paid_at`, `location_id` | integer pence |
| Retail takings | `billing.retail_sales` by payment method — R1's `retailSales` | `sold_at`, `location_id` | integer pence |
| Location currency | R1's `locationCurrencies` | the location | ISO 4217 |

Every source read filters `business_id`. Source facts are read inside each
location's own Ticket A window and placed on a day by the location's own
timezone. R7 never calls `billing.eod_expected_figures`, never reuses the EOD
service's day window, and never uses `allowedLocationIds`.

### Facts about End of Day that shaped the definitions

- One record per location per `business_date` (`unique (location_id,
  business_date)`); status `open` or `signed_off`; no reopen, void or delete.
- Expected cash = till cash tenders by `paid_at` + retail cash by `sold_at`;
  expected card likewise with `card_reader`. Retail *Other* and not-recorded
  methods are outside both. Deposits (Stripe) are outside the till.
- Expected figures are **snapshots**: written at open, on Refresh, and a last
  time at sign-off. The recorded variance is `(counted cash + counted card) −
  (expected cash + expected card)`, frozen at sign-off. It ignores the opening
  float, petty cash, and the manual refund and void entries.
- Opening float, refunds and voids are typed in and the columns default to 0, so a
  stored 0 can't show whether anyone entered zero. Petty cash out is the sum of
  the day's entries.
- The EOD expected-figures window is computed on a **Europe/London day for every
  location** (§9 D-1, §11). Before the D-2 fix every day was stored as GBP;
  days opened after it carry the location's currency.
- Signed-off rows are protected by the API only; there is no database guard
  (§9 D-3).

## 3. Definitions

**Days.** For each location, every local date from its window's `from` to `to`:

- `signed_off` — a record with status `signed_off`;
- `open` — a record not signed off (a draft);
- `none` — no record (**No cash-up recorded**);
- `not_started` — a date after the location's `localToday`. Such days carry no
  figures; a record dated in the future (the API allows it) is ignored.

Today is marked: an unsigned today is counted as **in progress**, never as a
missed (`open` or `none`) day.

**As recorded (signed-off days only).**
- Expected cash / expected card: the snapshot stored at sign-off.
- Counted cash / counted card: as entered.
- Cash variance = counted cash − expected cash; card variance likewise; both from
  the stored figures. Variance (combined): the stored `variance_cents`.
- Petty cash out, refunds entered, voids entered: as entered, summed.
- Threshold check per day: `outside` when `|variance| > current threshold`,
  otherwise `within`; `not_signed_off`, `not_comparable` (variance unavailable) or
  `no_threshold` otherwise. The threshold is not stored at sign-off, so this is
  **against the CURRENT threshold**, and is always labelled so — never presented
  as the threshold in force at sign-off. With no settings row it is
  `no_threshold` and the count is unavailable — never an assumed £5.00.
- Manual entries (opening float, refunds, voids): a stored zero is shown as
  **£0.00 recorded**, with a note that a stored zero can't show whether anyone
  entered it. A non-zero value can only come from an entry and is shown as the
  amount.

Every recorded figure (tills, petty cash, manual entries) covers the same days:
signed-off days whose figures are all available. A signed-off day that isn't —
London trading day, currency mismatch, missing stored value — is left out of all
of them and counted in *days not included* with its reason. When no day can be
judged, the counts (days outside threshold, days changed) are unavailable, never
0. Open days never contribute.

**Source check (signed-off days).** Expected from sources = till tenders by
`paid_at` + retail by `sold_at` for that local day, per tender, recomputed now.
Change since sign-off = expected from sources − recorded expected. A day with any
non-zero change counts as **changed since sign-off** (a payment taken after
sign-off, a backdated or edited retail sale, a repaired payment).

**Takings without a signed-off cash-up.** Expected cash and card from sources,
summed over started days whose status is `open` or `none` (today included).

**Retail outside the till.** Retail *Other* and *Method not recorded* from
sources, summed over started days. Neither is guessed into cash or card.

**London trading day.** For a location whose timezone is not `Europe/London`,
EOD computed its expected snapshot on a London day, not the location's. Its
recorded expected figures, variances, threshold check and source check are
unavailable (`london_trading_day`); its counted figures, float, petty cash and
manual entries are still shown on its day row. The zone must be exactly
`Europe/London`: aliases (`Europe/Belfast`, `GB`, `Europe/Jersey`…) are treated
as not London, which errs on the safe side.

**Currency.** Source figures follow R1: the location's configured currency plus
the currencies the facts carry; more than one is not totalled. Recorded figures
are shown only when the record's `currency_code` equals the location's
configured currency; otherwise unavailable (`currency_mismatch`). The summary
across locations is not totalled when locations differ.

## 4. Detail view

One row per location per started local day, newest day first, then by location
id: status, today marker, recorded figures and variances, threshold flag, petty
cash, manual entries, signed off by and the local date and time of sign-off,
change since sign-off, and notes. Paged 50 rows at a time by an opaque cursor
bound to each location's zone, local dates, UTC bounds and last started day (a
past window's cursor survives midnight). The rows on a page are known from the
windows alone, so a continuation page reads cash-ups only for its own days; it
reads its locations' takings for their whole windows, so each location's
currencies — and therefore its figures — are the same as on the first page.

## 5. Contract

- Report `cash-up`, permission `report.financials.view`, controls: dates,
  locations, summary/detail; no staff control. Access is Ticket A's single
  decision. Signing off stays on the End of Day screen (`eod.sign_off`).
- `GET /api/reports/cash-up/result?…[&cursor=…]` returns `body:
  CashUpReportBody` (`packages/domain/src/cash-up-report.ts`): a first page
  carries the summary, one row per resolved location and the first detail page;
  a continuation page (`continuation: true`) carries only detail rows.
- Every amount is `{availability:'available', cents}` |
  `{availability:'unavailable', reason}` | `{availability:'not_started'}`.
- All arithmetic is in the API. The web formats and renders.

## 6. Release

Cash up stays `release: 'foundation'` until R7 G1–G5 pass; the flip is a
separate commit.

## 7. Migrations

None. R7 reads existing tables only and changes no function; the End of Day
source fixes are API-only. `0113`/`0114` stay reserved, and no further Week 8
migration number is allocated: the D-1 source-versioning design (§11) is approved
in direction only, and its migration is not to be created until the migration
plan is approved.

## 8. Product decisions (approved 2026-09-15)

| # | Question | Decision |
|---|---|---|
| P-1 | Which variance is official | Approved. The one recorded at sign-off. Recomputation is shown separately as "changed since sign-off". |
| P-2 | Days with no record | Approved. **No cash-up recorded**; their takings from sources are shown under "without a signed-off cash-up". |
| P-3 | Open days | Approved. Draft figures appear in detail only, marked *Not signed off*; never in signed-off totals. |
| P-4 | Future days / future records | Approved. *Not started*; future-dated records ignored. |
| P-5 | Float and petty cash | Approved. EOD's formula is kept (neither enters the variance); both shown as stored. No "expected drawer" figure is invented. |
| P-6 | Per-tender variance | Approved. Shown next to the recorded combined variance, so a cash shortfall is not hidden by a card surplus. |
| P-7 | Payments after sign-off | Approved. Shown as "changed since sign-off". |
| P-8 | Non-London locations | Approved as **temporary legacy behaviour**: recorded expected and variance unavailable (`london_trading_day`) until §11 is decided. |
| P-9 | Record currency | Approved. Recorded figures only when the record's currency equals the location's configured currency. |
| P-10 | Manual refunds, voids and float | **Changed.** A stored zero reads **£0.00 recorded**, with help text that a stored zero can't show whether anyone entered it. Never "None entered". Labels say "manual entry", not "entered". |
| P-11 | Threshold | Approved with a constraint: always labelled the **CURRENT threshold** ("Days outside current threshold", "Current threshold", "Against current threshold"), with a note that the threshold at sign-off was not stored. Unknown threshold → unavailable. |

## 9. End of Day defects found in the G1 audit

| # | Defect | Status | Effect on R7 |
|---|---|---|---|
| D-1 | EOD expected-figures window hardcoded to a Europe/London day; the web page's default date is the browser's | **Not changed.** Audit in §11; the source-versioning direction is approved in principle (2026-09-15) but **no migration is to be created yet**. The API's "today" is now the location's (D-8). | Non-London records unavailable (P-8, temporary); unmarked rows are legacy semantics |
| D-2 | `currency_code` never set on open (always the GBP default); expected figures summed across currencies | **Fixed for new days** (2026-09-15): open stores the location's currency by R1's rule (settings row, else business default); a location with no usable currency can't open a day. Historical rows are not rewritten. The RPC still sums across currencies (a migration). | P-9 still refuses a record whose currency isn't the location's; mixed takings are not comparable |
| D-3 | Sign-off immutability is API-only: an edit, Refresh or petty cash add that read the row before sign-off can land after it; sign-off is two separate updates | **HIGH PRIORITY / MUST FIX BEFORE PILOT.** Not solved inside R7 G5. After R7 G5, a separate transactional / database-integrity proposal covering the edit vs sign-off race, the Refresh vs sign-off race and a petty cash write after sign-off: a signed-off record must be immutable **by invariant**, not by API convention. | A changed signed-off row is not detectable from the row |
| D-4 | Row edits and Refresh are not audited; only sign-off is | Tracked as a cash-up audit/history improvement. | History of counts can't be rebuilt |
| D-5 | A failed petty-cash read writes a petty-cash total of 0 | **Fixed** (2026-09-15): a failed read never writes a total. Adding petty cash saves (and audits) the entry first; if the re-read or the reload then fails, no total is written, the day keeps its previous total and the answer says the entry was recorded, so it isn't added twice. Refresh and sign-off read the entries before writing anything, so a signed-off total is the entries' sum at sign-off (subject to D-3). Reading a day or the history fails instead of showing no entries. | An open day's draft petty cash can be behind its entries after a failed re-read, until Refresh or sign-off |
| D-6 | An owner can open a day for a location of another business (no ownership check) | **Fixed** (2026-09-15): every route checks the location belongs to the actor's business, owners included; a foreign location and an unknown id get the same 403; a stray row of another business's location can't be read or changed. Not fixable without a data fix: a stray row the old defect already wrote still holds `unique(location_id, business_date)`, so the owning business gets a 500 opening that date. See §13 for the read-only check and what to do if it returns rows. | R7 filters `business_id` and `location_id` |
| D-7 | EOD deposits collected count only current `paid` deposits; redeemed has no bill-status filter | Not part of R7 (R7 does not consume the EOD deposit calculation). | Not used |
| D-8 | Future dates can be opened and signed off | **Fixed** (2026-09-15): opening or signing off a day after the location's own local today is refused (400); an omitted date defaults to the location's own today; an invalid location timezone is refused, never guessed. | Ignored (P-4) |
| D-9 | EOD uses `allowedLocationIds` for non-owner location scope | Unchanged, now inside the same-business check (D-6). | Not used by R7 |
| D-10 | Retail sales can be backdated (`soldAt`) and edited or deleted under the management RLS policy | Accepted: R7's changed-since-sign-off treatment. | Surfaces as "changed since sign-off" |
| D-11 | The variance threshold is not stored at sign-off; EOD silently falls back to £5 | R7 uses the current threshold, labelled CURRENT (P-11). EOD's own £5 fallback is unchanged. | P-11 |

## 10. Later consumers (not changed in R7)

- **End of Day screen**: could read R7's per-day source check instead of its own
  RPC once D-1/D-2 are decided.
- **ZAC**: any till or cash-variance signal should consume R7's recorded and
  source-check figures (handoff note in the R7 report).

## 11. D-1: can existing rows tell which trading-day algorithm wrote them?

Read-only audit, 2026-09-15.

**A. A field recording the timezone or date algorithm?** No. The row has
`business_date` (a date label), status, the figures, `opened_by`/`signed_off_by`,
`signed_off_at`, `currency_code`, `created_at`, `updated_at` — nothing names the
zone or window that computed the expected snapshot. The `cashup.opened` and
`cashup.signed_off` audit events record the date and figures, no zone, and audit
writes are fail-soft (an event can be missing).

**B. Can historical non-London rows be told apart from rows written after a
fix?** No. A fixed writer would produce rows of identical shape; nothing in a row
would differ except the figures.

**C. Can `created_at`, `signed_off_at` or another field give a reliable cutover?**
No.
- The deploy instant is not in the database, and differs per environment.
- Railway runs old and new instances side by side during a deploy, so rows near
  any cutover instant are ambiguous.
- The expected snapshot is rewritten at Refresh and sign-off, so `created_at`
  says nothing about the final snapshot, and `updated_at` moves on every edit.
- A location's timezone is editable with no history (location updates are not
  audited), so even a known-local row can't be recomputed if the zone changed.
- Inferring the algorithm by recomputing both windows is a guess: it fails when
  sources changed after sign-off, or when both windows hold the same takings.

What the code shows: the End of Day writer has used `Europe/London` since it was
added (one commit, 2026-08-12), so every row written so far was written by a
London-day writer. That is evidence from the writer, not a property of the row —
a row itself carries no proof of how it was computed, so an unmarked row is
**LEGACY EOD SEMANTICS**, never "known-good London-comparable". End of Day is not
on `main`, so production has not served it; the production database was not read.

**D. If the writer switched now, how would R7 know?** It couldn't. So the writer
has **not** been switched, and R7 keeps P-8 (non-London recorded figures
unavailable) as temporary legacy behaviour.

### Source-versioning design — direction approved in principle, 2026-09-15

**No migration now.** `0113` and `0114` stay reserved, and no further Week 8
migration number is allocated until the migration plan itself is approved. Until
then the writer is unchanged and R7 keeps its legacy behaviour.

1. **What the persisted model must identify.** For every stored expected
   snapshot, both the exact interval used and the semantics that produced it:
   - calculation timezone;
   - window start (UTC);
   - window end (UTC, exclusive);
   - window semantics / version.

   Held together (all set or all absent) and written in the same statement as the
   figures they describe, so a marker can never describe a different snapshot.
   Historical rows are not rewritten and are not backfilled.
2. **Unmarked rows are LEGACY EOD SEMANTICS.** Absence of a marker says only
   "written before versioning". It is not a guarantee of a London window, and it
   must never be presented as one. A legacy row at a non-`Europe/London` location
   stays **Not comparable** (P-8). A legacy row at a `Europe/London` location
   keeps today's treatment, which rests on the writer's history rather than on the
   row — R7 says which rule it applied.
3. **Writer, two deploys.**
   - Step 1: every expected snapshot (open, Refresh, sign-off) writes the marker
     with the current London window. No change in meaning.
   - Step 2, after step 1 is fully live: the window becomes the location's own
     day and the marker says so. During step 2's rollover an older instance still
     writes a London snapshot with a London marker, so a marker always describes
     the snapshot written with it.
   - Sign-off must write the final expected figures, the marker, the variance and
     the status in **one** update. Today they are two updates, so an older
     instance's Refresh landing between them would leave a variance computed on a
     different window from the marker (this also narrows D-3).
   - The location's window must come from the same local-midnight function R7
     uses (`localDateStartUtc` in `payroll/period-dates.ts`), not
     `businessDayWindow` with another zone: its offset probe is taken at UTC
     midnight, which is wrong for zones whose offset changes between UTC midnight
     and local midnight (for example Australia/Sydney on 2026-04-05 it gives 01:00
     local), so R7's "stored window equals R7's window" check would never match.
4. **R7.** Recorded expected figures, variances, threshold check and source check
   are comparable only when the marker's semantics version is one R7 understands,
   its zone equals the location's current timezone, and its window equals R7's
   window for that local date. A marker whose zone differs from the location's
   current zone is unavailable with its own reason (timezone changed since the
   cash-up). Unmarked rows follow rule 2.
5. **End of Day web.** The default date becomes the location's own today, from the
   API, instead of the browser's date.

Rejected: a `created_at`/`signed_off_at` cutover, and inferring the algorithm
from the figures (both guess, per C).

## 12. Changed behaviour from the pre-G5 source fixes

- End of Day, open: a day after the location's own today is refused; with no date
  given the day is the location's own today (it was London's); a new day is stored
  in the location's currency; a location with no usable currency or an invalid
  timezone can't open a day.
- End of Day page: unchanged apart from the threshold label, which now reads
  "current threshold". Its date picker still defaults to, and is capped at, the
  **browser's** date. A browser ahead of the location (for example after London
  midnight for a New York location) defaults to a date the API now refuses, with
  the message "This trading day has not started yet at this location"; a browser
  behind the location can't pick the location's today. For the UK dev-test
  business and a UK browser the dates agree. The fix belongs with §11 step 4.
- End of Day, sign-off: refused for a day after the location's own today; the
  petty cash total is re-read from its entries. Refresh re-reads it too.
- End of Day, petty cash add: a failure after the entry is saved answers "Petty
  cash was recorded, but the day could not be reloaded. Reload the day before
  adding it again." The audit event is written as soon as the entry is saved.
- End of Day, every route: a location outside the actor's business is refused
  (403) for owners as well as managers.
- End of Day, reads: a failed petty cash read is an error (500), not an empty list.
- R7: totals and the reconciliation fixture are unchanged. Wording only: manual
  entries read "£0.00 recorded" for a stored zero, and the threshold is labelled
  the current threshold.

## 13. Before and during R7 G5

### Stray cross-tenant rows (D-6 legacy data)

Read-only, run by the user on dev-test before R7 G5, and on production before
pilot:

```sql
select r.id, r.business_id, l.business_id as location_business_id, r.business_date
from billing.eod_reconciliations r
join core.locations l on l.id = r.location_id
where r.business_id <> l.business_id;
```

Expected: 0 rows. If any row comes back: **do not modify or delete it.** Report
the count and each row's business, location and date; establish whether the
location's real business is blocked from cashing up that date (the unique
constraint is on location and date, so it would be); and propose a repair plan
for approval before anything is changed.

### G5 data plan (after R1 G5 figures are recorded)

- **Kensington:** sign off the completed test day; reconcile expected cash and
  card against the R1 source ledger.
- **Primrose Hill:** a day left open — verify *Not signed off*.
- **Pinner:** untouched — verify *No cash-up recorded*.
- **Non-London:** optional legacy evidence for *Not comparable*; it does not block
  UK-location G5.

Verify in the report: recorded variance; recomputed (current) takings; changed
since sign-off; per-tender variance; combined variance; the CURRENT threshold
wording; "£0.00 recorded" for defaulted manual-entry fields; and no invented zero
anywhere a figure is unavailable.

### Branch sequencing

R7 is based on develop `0f4a35e`. It is not pushed. After R1 G5 completes and R1
is accepted and merged: rebase onto the accepted develop, resolve conflicts with
care, confirm no R1 canonical behaviour is overwritten, rebuild clean, and rerun
the full API and web suites plus the R7 reconciliation, End of Day, permission,
timezone and paging tests. Report the updated SHA and results, and only then
prepare the R7 PR.
