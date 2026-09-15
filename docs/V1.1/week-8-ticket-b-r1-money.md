# QLOOQO V1.1 Week 8 — Ticket B: R1 Money

**Status:** G1 definition, 2026-09-15. Builds on
[Ticket A](week-8-ticket-a-foundation.md) (report registry, fail-closed access,
per-location windows). R1 is COMPLETE only after its own G5.

**Ownership.** Cosan owns this ticket. No ZAC file and no Dashboard file changes;
§9 lists the later Dashboard and ZAC consumers.

---

## 1. What R1 answers

R1 is the canonical report of money **as QLOOQO recorded it**, for the selected
locations and each location's own report window:

- paid bill revenue: gross, net of VAT, VAT;
- what those bills were made of (services, colour, reconciliation adjustments);
- how those bills were settled (cash, card reader, deposits applied);
- retail sales and how they were paid;
- deposits collected, redeemed and refunded — three separate events;
- which financial categories QLOOQO does not record.

A missing source is never zero. A category QLOOQO does not record renders **Not
recorded**, never £0.00.

## 2. Sources (verified on develop `8252ada`)

| Fact | Source | Attribution | Units |
|---|---|---|---|
| Paid bill | `billing.bills` with `status = 'paid'` | `occurred_at` (payment confirmation), `location_id` | integer pence |
| Bill composition | `billing.bill_lines` of those bills | the parent bill | integer pence |
| Till settlement | `billing.salon_payments` joined to the bill by `visit_id` | the parent bill | integer pence |
| Retail sale | `billing.retail_sales` (one row per product line; no status) | `sold_at`, `location_id` | integer pence |
| Deposit collected | `booking.deposits` with `paid_at` set and status `paid`, `partially_refunded` or `refunded` | `paid_at`, `location_id` | `numeric(12,2)` pounds, converted exactly to pence |
| Deposit redeemed | `billing.bills.deposit_applied_cents` of paid bills | the bill | integer pence |
| Deposit refunded | `booking.deposits` with `refunded_at` set, whatever the current status | `refunded_at`, `location_id` | pounds → pence |

Every read filters `business_id` and constrains each location to **its own**
Ticket A window (`[fromUtc, toUtcExclusive)`); there is no envelope. A location
whose window has not started contributes no facts and renders **Not started**.

Never used: `visit_line_items`, appointment or catalogue prices, dashboard or KPI
calculations, `lab.formulas` expected charges, EOD expected figures, UTC or
browser-local day windows, `allowedLocationIds`, unpaginated reads.

### Facts that shaped the definitions

- `bills.status` admits `voided`, but nothing writes it; every bill is `paid`.
- Written line types: `service`, `product_usage` (the QLAB colour charge — taxed
  under the `retail` tax category but it is **not** retail) and `adjustment`
  (ledger reconciliation, VAT 0, can be negative). `retail`, `deposit_credit` and
  `discount` are admitted by the check constraint but never written.
- By construction `gross = Σ line gross = balance_collected + deposit_applied`,
  and `balance_collected = Σ salon_payments` for the visit. Nothing enforces this
  in the database, and seeded demo bills break it.
- `salon_payments` are insert-only, `cash` or `card_reader`, one row per method
  per visit. Deposits are never a tender.
- The bill write is fail-soft: a paid visit can have till payments but no bill
  snapshot until it is repaired.
- `retail_sales` has no VAT fields, no status and no link to bills.
- Deposits are Stripe-only. Refunds are full refunds made in QLOOQO
  (`refunded_at`); `partially_refunded` is never written; refunds made in the
  Stripe dashboard are invisible. A forfeited deposit leaves no money record.
- Risk: the deposit webhook is not idempotent on status. A re-delivered
  `payment_intent.succeeded` for a refunded deposit sets `status` back to `paid`
  and rewrites `paid_at` (leaving `refunded_at` in place). R1 therefore reads
  refunds by `refunded_at` regardless of status, so the refund is never lost; the
  collection moves to the re-delivery day, which R1 cannot detect. The webhook fix
  belongs to the payments owner, not to R1.
- `bills.discount_cents` is always written as 0.

## 3. Definitions

All sums are over the scoped locations, each within its own window.

**Paid bill revenue**
- `Gross` = Σ `bills.gross_cents` (VAT inclusive; includes deposits applied).
- `Net of VAT` = Σ `bills.net_cents`. This is the stored ex-VAT snapshot — not a
  net position, not profit.
- `VAT` = Σ `bills.tax_cents` (VAT recorded on paid bills).

**Bill composition** (reconciles exactly to Gross)
- one figure per recorded `line_type` = Σ line `gross_cents`: Services
  (`service`), Colour (`product_usage`), Reconciliation adjustments (`adjustment`),
  and any other admitted type if it ever appears (reported under its own name,
  never dropped);
- `Not itemised` = Σ over bills of (`gross_cents` − Σ that bill's line gross).
  Zero for every bill QLOOQO wrote; non-zero only for bills without matching lines.

**Colour** = the `product_usage` composition figure (gross, plus its net and VAT).
It is a breakdown of Gross and is never added to it.

**Bill settlement** (reconciles exactly to Gross)
- `Cash`, `Card reader` = Σ `salon_payments.amount_cents` by method, for the
  payments of the scoped paid bills;
- `Deposits applied` = Σ `bills.deposit_applied_cents`;
- `Not itemised` = Σ over bills of (gross − payments − deposit applied).

**Retail**
- `Retail sales recorded` = Σ `retail_sales.total_amount_cents`. VAT on retail is
  **Not recorded**.
- Payment methods (reconcile exactly to retail sales recorded): `Cash`,
  `Card reader`, `Other`, `Method not recorded` (null).

Retail is separate from bill revenue and is never added to it. Retail attach and
retail as a percentage of service revenue are R2, not R1.

**Deposits** — three events, never netted:
- `Collected` = Σ amount of deposits whose `paid_at` falls in the window, whatever
  happened to them later (a later refund does not rewrite the collection day);
- `Redeemed` = Σ `bills.deposit_applied_cents` (the same money as *Deposits
  applied* above);
- `Refunded in QLOOQO` = Σ amount of deposits whose `refunded_at` falls in the
  window, whatever their current status (see the webhook risk in §2). If a
  `partially_refunded` deposit falls in the window its refund amount is unknown,
  so the figure is **Not recorded**.

**Net position** — **definition pending.** No approved product definition exists,
and no stored source supports an accounting-style net position: discounts, till
refunds, voids, tips, forfeited deposits and card fees are not recorded. R1 returns
it as unavailable (`definition_pending`). The honest candidates, for a product
decision, are in §8.

**Not recorded** (always listed, never a number): discounts, till refunds, voids,
tips, VAT on retail, forfeited deposits, and deposit refunds made outside QLOOQO.

**Coverage check.** Till payments recorded in the window whose visit has no paid
bill snapshot are counted and totalled and shown as a notice: they are real
money not yet in bill revenue.

**Currency.** If the scoped facts carry more than one currency, money figures are
unavailable (`mixed_currencies`) rather than summed. Each location row carries its
own `currencyCode`: a location with no facts takes the report's single currency;
it is null when the location's own facts are mixed, or when it has no facts and
the report has no single currency (then its zeros are written in the platform
default, GBP). The coverage notice carries its own currency. The web writes each
figure in its own currency.

## 4. Detail view

Rows: one per paid bill, retail sale line, deposit collection and deposit refund,
each with the location, **local** date and time (from the location's timezone,
never raw UTC), its type, a reference (the bill number for paid bills; other rows
have no customer-safe reference and show their type only) and its amounts.
Ordered by (instant, row kind, id), paged by an opaque keyset cursor with no row
cap: identical instants never duplicate or skip a row. Instants keep the
database's microsecond precision. Pages hold 50 rows; each source is read by
keyset until the page is full, so a server row cap cannot shorten a page. When no
location's window has started, detail says so (`detail.notStarted`) instead of
"nothing recorded".

## 5. Contract

- Report `money`, permission `report.financials.view`, controls: dates, locations,
  summary/detail; no staff control. Access is Ticket A's single decision.
- `GET /api/reports/money/result?…[&cursor=…]` returns `body: MoneyReportBody`
  (`packages/domain/src/money-report.ts`): `summary`, one `locations[]` row per
  resolved location (additive figures sum to the summary), `notRecorded`,
  `coverage`, and `detail` when `view=detail`.
- A request with a `cursor` returns a **continuation** page (the body type is a
  union on `continuation`): `continuation: true`, `summary: null`,
  `coverage: null`, `locations: []`, and only the next `detail` rows. The summary is not recomputed for every page.
- Reads are made for at most ten locations at a time, so request URLs stay
  bounded for large businesses.
- Every amount is `{availability:'available', cents}` |
  `{availability:'unavailable', reason}` | `{availability:'not_started'}`.
- A `cursor` without `view=detail`, or a malformed cursor, is
  `400 report_cursor_invalid`.
- All arithmetic is in the API. The web formats and renders.

## 6. Release

Money stays `release: 'foundation'` (preview shell only) until R1 G1–G5 pass; the
flip to `released` is a separate commit.

## 7. Migrations

None. R1 reads existing tables only. `0113`/`0114` stay reserved; `0115` is not
taken by R1.

## 8. Decisions for the product owner

1. **Net position.** Candidates that are exact on stored data, each with the list
   of what it excludes:
   - *Paid bills net of VAT* = Σ `net_cents` (already shown);
   - *Money received* = till payments + retail sales + deposits collected (cash
     basis, before refunds);
   - *Money received less deposit refunds in QLOOQO*.
2. **Forfeited deposits** and **deposit excess over a bill** have no money record;
   showing them needs a data model (a migration).
3. **Average bill** (locked: `bill_lines` only) is not in the R1 ticket's metric
   list and is not built here.

## 9. Later consumers (not changed in R1)

- **Dashboard** (`dashboard.service.ts` revenue, average bill, top services,
  stylist revenue) reads `visit_line_items` and appointment prices by
  `scheduled_start_at`; it should move to R1 facts.
- **ZAC** tools reading DashboardService or KpiService revenue (business health,
  KPI summary, scorecard, service mix, stylist performance, retail performance,
  appointment summary) and the metric registry's `DashboardService.kpis` source
  will disagree with R1 until Oleksandr moves them. Handoff note in the R1 report.
