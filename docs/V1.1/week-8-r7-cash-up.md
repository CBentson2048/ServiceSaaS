# QLOOQO V1.1 Week 8 — R7 Cash Up

**Status:** G1 definition, 2026-09-15. Builds on
[Ticket A](week-8-ticket-a-foundation.md) (report registry, fail-closed access,
per-location windows) and uses the fact definitions of
[R1 Money](week-8-ticket-b-r1-money.md). R7 is COMPLETE only after its own G5.

**Ownership.** Cosan owns this ticket. No ZAC file and no Dashboard file changes.
The End of Day screen and API are **not** changed by R7; §9 lists their defects
for a separate decision.

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
- Opening float, petty cash out, refunds and voids are manual, default 0 and
  indistinguishable from "not entered".
- The EOD trading day is computed in **Europe/London for every location** and
  its currency is always stored as GBP (§9 D-1, D-2).
- Signed-off rows are protected by the API only; there is no database guard
  (§9 D-3).

## 3. Definitions

**Days.** For each location, every local date from its window's `from` to `to`:

- `signed_off` — a record with status `signed_off`;
- `open` — a record not signed off (a draft);
- `none` — no record (**No cash-up recorded**);
- `not_started` — a date after the location's `localToday`. Such days carry no
  figures; a record dated in the future (the API allows it) is ignored.

Today is marked, so an unsigned today reads as in progress, not as missed.

**As recorded (signed-off days only).**
- Expected cash / expected card: the snapshot stored at sign-off.
- Counted cash / counted card: as entered.
- Cash variance = counted cash − expected cash; card variance likewise; both from
  the stored figures. Variance (combined): the stored `variance_cents`.
- Petty cash out, refunds entered, voids entered: as entered, summed.
- Outside threshold: `|variance| > current threshold` for the location. The
  threshold is not stored at sign-off, so this is **against today's threshold**.
  With no settings row the threshold is unknown and this count is unavailable —
  never an assumed £5.00.

A signed-off record with a missing stored value shows that value as Not
recorded. Open days never contribute to these totals.

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
recorded expected figures, variances, threshold flag and source check are
unavailable (`london_trading_day`). Counted figures, float, petty cash and manual
entries are still shown.

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
bound to the windows it was issued for (as R1). The rows on a page are known
from the windows alone, so a continuation page reads only its own days.

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

None. R7 reads existing tables only and changes no function. `0113`/`0114` stay
reserved; `0115` is not taken.

## 8. Decisions taken as defaults (for product approval)

| # | Question | Default in R7 |
|---|---|---|
| P-1 | Which variance is official | The one recorded at sign-off. Recomputation is shown separately as "changed since sign-off". |
| P-2 | Days with no record | **No cash-up recorded**; their takings from sources are shown under "without a signed-off cash-up". |
| P-3 | Open days | Draft figures appear in detail only, marked *Not signed off*; never in signed-off totals. |
| P-4 | Future days / future records | *Not started*; future-dated records ignored. |
| P-5 | Float and petty cash | EOD's formula is kept (neither enters the variance); both shown as entered. No "expected drawer" figure is invented. |
| P-6 | Per-tender variance | Shown next to the recorded combined variance, so a cash shortfall is not hidden by a card surplus. |
| P-7 | Payments after sign-off | Shown as "changed since sign-off". |
| P-8 | Non-London locations | Recorded expected and variance unavailable (`london_trading_day`). |
| P-9 | Record currency | Recorded figures only when the record's currency equals the location's configured currency. |
| P-10 | Manual refunds and voids | Shown as "entered at cash-up"; a zero reads **None entered**. |
| P-11 | Threshold | Today's threshold, labelled so; unknown threshold → unavailable. |

## 9. End of Day defects found in the G1 audit (not changed by R7)

| # | Defect | Effect on R7 |
|---|---|---|
| D-1 | EOD trading day hardcoded to Europe/London; the web page's default date is the browser's | Non-London records unavailable (P-8) |
| D-2 | `currency_code` never set on open (always GBP); expected figures summed across currencies | Guarded by P-9 |
| D-3 | Sign-off immutability is API-only: an edit that read the row before sign-off can land after it; sign-off is two separate updates | A changed signed-off row is not detectable from the row |
| D-4 | Row edits and Refresh are not audited; only sign-off is | History of counts can't be rebuilt |
| D-5 | A failed petty-cash read writes a petty-cash total of 0 | A recorded petty cash of 0 may be wrong |
| D-6 | An owner can open a day for a location of another business (no ownership check) | R7 filters `business_id` and `location_id` |
| D-7 | EOD deposits collected count only current `paid` deposits; redeemed has no bill-status filter | Not used by R7 (deposits are in Money) |
| D-8 | Future dates can be opened and signed off | Ignored (P-4) |
| D-9 | EOD uses `allowedLocationIds` for location scope | Not used by R7 |
| D-10 | Retail sales can be backdated (`soldAt`) and edited or deleted under the management RLS policy | Surfaces as "changed since sign-off" |
| D-11 | The variance threshold is not stored at sign-off; EOD silently falls back to £5 | P-11 |

Fixing D-1 to D-6 and D-8 needs no migration; D-3 (database guard), D-7 and D-10
(RLS) would.

## 10. Later consumers (not changed in R7)

- **End of Day screen**: could read R7's per-day source check instead of its own
  RPC once D-1/D-2 are decided.
- **ZAC**: any till or cash-variance signal should consume R7's recorded and
  source-check figures (handoff note in the R7 report).
