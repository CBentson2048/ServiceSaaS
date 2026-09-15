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
| Location currency | `core.location_settings.currency_code` (one row per location); for a location with no settings row, `core.businesses.default_currency_code` | the location | ISO 4217 code |

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
- Source-integrity defect, **fixed with R1**: a re-delivered
  `payment_intent.succeeded` set a refunded deposit back to `paid` and rewrote
  `paid_at`, moving the collection to the re-delivery day. The payment webhook now
  records a collection only while none is recorded (`paid_at` null, status still
  awaiting payment), so a repeat changes nothing. R1 still reads refunds by
  `refunded_at` whatever the status, which keeps any deposit altered before the
  fix counted as refunded.
- Source-integrity defect, **fixed with R1**: a declined card, then a successful
  payment on the same PaymentIntent, took the money but recorded nothing. The web
  booking page keeps the PaymentIntent after a decline (the payment form stays
  mounted and "Pay deposit and confirm" stays enabled; the client secret is kept
  in session storage); the mobile app presents one PaymentSheet per intent, and
  Stripe's sheet lets the client try another card after a decline.
  `payment_intent.payment_failed` marked the attempt `payment_failed`, and the
  later success was ignored. A success on the attempt's own intent now completes
  a `payment_failed` attempt exactly once, and a failure never overwrites a
  recorded collection.
- Location currency is set when a location is created (from the business
  default) and is not editable through the API. Transactions do not all follow
  it: service lines are written in GBP and retail sales default to GBP, while
  deposits use the location's currency. A non-GBP location's figures can
  therefore read "mixed currencies" until those writers are fixed (outside R1).
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

**Currency.** There is no default currency anywhere in R1.
- A location's figures are in its own configured currency (§2). Its currency set
  is that currency plus every currency its facts were recorded in.
- One currency: figures are written in it — a location with no activity is a
  genuine zero in its own currency (£0.00 in London, €0.00 in Dublin).
- More than one: not totalled (`mixed_currencies`). Facts are never relabelled
  into the location's currency.
- None (no facts and no determinable currency): `currency_not_recorded`, shown
  as words, never a zero in some other currency.
- The summary's currency set is the union over the started locations, so a scope
  spanning locations with different currencies is not totalled even when one of
  them had no activity.
- Detail rows and the coverage notice carry the currency they were recorded in.
  The web writes a figure only in the currency the API names.

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

1. **Net position — not selected; R1 shows "Definition pending".** Three
   candidates are exact on stored data. None is profit and none is an accounting
   net position. All sums are per location in its own window.

   **A. Paid bills net of VAT**
   - Formula: Σ `billing.bills.net_cents` where `status = 'paid'`, by `occurred_at`.
   - Sources: `billing.bills`. Already shown as *Net of VAT* in Paid bill revenue.
   - Interpretation: service and colour revenue the salon earned on bills that were
     paid, excluding VAT — an accrual view of the chair.
   - Limitations: excludes retail (no VAT is stored for retail, so it has no
     net-of-VAT figure), unredeemed deposits and till payments whose bill is
     missing; no costs (commission, wages, stock, rent, card fees); discounts,
     voids and till refunds are not recorded; a deposit applied to the bill is
     inside it, so the same money also appears as a deposit collected earlier.

   **B. Money received**
   - Formula: Σ `billing.salon_payments.amount_cents` by `paid_at`
     + Σ `billing.retail_sales.total_amount_cents` by `sold_at`
     + Σ `booking.deposits.amount` collected, by `paid_at`.
   - Sources: `billing.salon_payments`, `billing.retail_sales`, `booking.deposits`.
     No overlap: till tenders must equal the bill's service and colour gross less
     paid deposits, so they include neither retail nor deposits.
   - Interpretation: cash basis — every payment QLOOQO recorded as taken in the
     period, VAT included, whether or not a bill exists.
   - Limitations: includes VAT; a deposit collected for a future appointment is
     counted when taken (money held, not yet earned); refunds are not deducted;
     card and Stripe fees, tips, and payments taken outside QLOOQO are not
     recorded; money is counted when recorded, not when it settles in the bank.

   **C. Money received less deposit refunds in QLOOQO**
   - Formula: B − Σ `booking.deposits.amount` by `refunded_at` (whatever the
     current status).
   - Sources: as B.
   - Interpretation: cash basis, net of the only refunds QLOOQO records.
   - Limitations: all of B's; refunds made in the Stripe dashboard and till refunds
     are invisible; when a partially refunded deposit is in scope its refund amount
     is unknown, so C is unavailable; a refund in the period for a deposit collected
     in an earlier period can make C lower than the money taken in the period.
2. **Forfeited deposits** and **deposit excess over a bill** have no money record;
   showing them needs a data model (a migration). For V1.1, forfeited deposits
   stay **Not recorded** unless expanded scope is approved.
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

## 10. Follow-ups outside R1 (recorded, not in this ticket)

- **Transaction currency.** Service lines and therefore bills and till payments
  are written in GBP (`lab-appointments.service.ts`), and retail sales default to
  GBP (the API sends no currency to `record_retail_sale`); deposits use the
  location's configured currency. R1 shows such a location's figures as "mixed
  currencies" rather than relabelling them, which is sufficient for this ticket.
- **FD-1 Client retry status UX — MUST FIX BEFORE PILOT** (booking clients; not
  R1 technical debt). After decline → retry on the same PaymentIntent → success,
  both clients poll the attempt and stop at the first `payment_failed`, which is
  still the decline's status until the success webhook is processed, so the
  customer is told the payment failed although the booking is confirmed moments
  later.
  - *Web* (`ClientBookingReviewPage.tsx`, `waitForConfirmedAttempt`): shows
    "Payment failed, so the booking was not confirmed." under a still-enabled
    Pay button. The intent has already succeeded, so paying again on it is
    refused by Stripe; the risk is the customer abandoning or starting a new
    booking. Fix ships with a normal web deploy.
  - *Mobile* (`sheer-app/app/booking/review.tsx`, `waitForConfirmedAttempt`):
    shows the same message after the PaymentSheet has closed; tapping confirm
    again starts a new checkout (new attempt, new PaymentIntent), so a second
    charge for another slot is possible. Fix needs an app release, so it has the
    longer lead time.
- **FD-2 Paid but slot no longer available — HIGH PRIORITY / MUST FIX BEFORE
  PILOT** (booking/payment defect; not R1 technical debt). A PaymentIntent can
  succeed after the attempt's slot hold has expired (15 minutes) or, after an
  earlier decline, once another client has taken the slot (a `payment_failed`
  attempt no longer holds it). Finalisation revalidates the slot and throws, the
  webhook answers an error, Stripe retries for up to three days, and the customer
  has paid with no booking and no recorded deposit collection. A separate non-ZAC
  ticket/spec for Cosan follows R1 G5.
- **Refunds made in the Stripe dashboard** are not captured (no `charge.refunded`
  handler); R1 lists them as not recorded.
- **Deposits altered before the webhook fix** are not repaired.
