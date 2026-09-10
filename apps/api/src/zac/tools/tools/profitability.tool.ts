import type { AuthUser } from '@sheer/domain';
import type { PayrollService } from '../../../payroll/payroll.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { periodFromInput } from '../zac-period';

/** A pay period is monthly at most sites; a month of context is the useful default. */
const DEFAULT_RANGE_DAYS = 30;

/**
 * WHAT REMAINS AFTER RECORDED PAYROLL — and why that is not net profit.
 *
 * ZAC used to refuse every profit question outright. That was too blunt: the
 * two largest lines a salon owner cares about ARE recorded. What is missing is
 * everything else.
 *
 *   Revenue                    recorded  (payroll.pay_summaries)
 *   - Recorded payroll         recorded  (payroll.pay_summaries)
 *   = Remaining after payroll  REPORTED HERE
 *   - Rent, products, utilities, software, insurance, taxes   NOT RECORDED
 *   = Net profit               NOT COMPUTABLE
 *
 * A word-boundary search of every migration confirms QLOOQO has no expenses,
 * overheads, rent or utilities table, so the last two lines genuinely cannot be
 * produced. This tool therefore reports the third line and says plainly that it
 * is not the fifth.
 *
 * NAMING IS LOAD-BEARING. This figure is NOT:
 *   - "profit" / "profit margin" — those mean net profit, which needs the costs
 *     above. If ZAC says 55.6% and the accountant says 18%, ZAC is the one that
 *     looks broken, and every other figure it gives becomes suspect.
 *   - "contribution margin" — that is revenue minus VARIABLE costs (commission,
 *     product consumed, processing fees). Payroll alone is not that set, so the
 *     term would be wrong in a way an accountant would immediately catch.
 *   - "retained earnings" or anything implying cash available to withdraw.
 * The only claim made is the literal one: this much revenue is left once the
 * payroll QLOOQO recorded is taken off.
 *
 * WHY NOT `business_retained_cents`. Payroll already stores a similar figure,
 * but it is computed as `max(0, totalCollected - max(grossPayable, 0))` — a
 * CASH-COLLECTED base, floored at zero per stylist. Summing a per-stylist floor
 * silently overstates the business total whenever anyone is negative, and a
 * cash base does not reconcile with the revenue shown elsewhere in ZAC. Both
 * inputs here are taken from the same statements instead, so the subtraction
 * shown to the user is the subtraction that was performed.
 */
export class ProfitabilityTool implements ZacReadOnlyTool {
  readonly name = 'report.profitability' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Revenue remaining after the payroll QLOOQO recorded, with an explicit statement that it is not net profit.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  /**
   * Payroll, not general financials. The figure is derived from settlement
   * statements: anyone who can see it can infer the wage bill, so it sits
   * behind the permission that already guards payroll rather than the broader
   * reporting one.
   */
  readonly requiredPermissions = ['payroll.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: { period: { type: 'object' } },
    additionalProperties: true,
  };
  readonly outputSchema = {
    type: 'object',
    description:
      'Revenue, recorded payroll, and what remains — with the excluded cost categories named.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = ['recorded_payroll_cents'] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 0, perTenant: true } as const;
  readonly rateLimit = { perMinute: 6 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly payroll: PayrollService) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const period = periodFromInput(input, DEFAULT_RANGE_DAYS);

    let periods: Awaited<ReturnType<PayrollService['listPeriods']>>;
    try {
      periods = await this.payroll.listPeriods(actor, {
        from: period.fromIso,
        to: period.toIso,
      });
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read your payroll periods just now, so I cannot say what is left after payroll.',
        rowCount: null,
      };
    }

    // Only GENERATED periods carry settlement figures. A period that exists but
    // has not been run has no payroll to subtract, and treating it as zero
    // would overstate what remains — the exact direction that flatters.
    const generated = periods.periods.filter((entry) => entry.totals !== null);
    if (generated.length === 0) {
      return {
        status: 'not_connected',
        data: { pay_periods_found: periods.periods.length },
        explanation:
          periods.periods.length === 0
            ? `No pay period covers ${period.label}, so there is no recorded payroll to subtract and I will not estimate one.`
            : `A pay period covers ${period.label} but payroll has not been generated for it yet, so there is no recorded payroll to subtract and I will not estimate one.`,
        rowCount: 0,
      };
    }

    let revenueCents = 0;
    let payrollCents = 0;
    let staleCount = 0;
    let staffCount = 0;
    let currency = 'GBP';
    const labels: string[] = [];

    for (const entry of generated) {
      let detail;
      try {
        detail = await this.payroll.listSummaries(actor, entry.period.id);
      } catch {
        // One unreadable period must not silently shrink the total; the whole
        // answer degrades rather than quietly reporting a smaller business.
        return {
          status: 'unavailable',
          data: null,
          explanation:
            'I could not read every pay statement for that period, so any total I gave you would be short. I would rather say so than under-report.',
          rowCount: null,
        };
      }

      labels.push(entry.period.label ?? `${entry.period.periodStart} to ${entry.period.periodEnd}`);
      for (const summary of detail.summaries) {
        revenueCents += summary.serviceRevenueCents + summary.retailRevenueCents;
        payrollCents += summary.grossPayableCents;
        if (summary.isStale) staleCount += 1;
        staffCount += 1;
        currency = summary.currencyCode ?? currency;
      }
    }

    if (revenueCents <= 0) {
      return {
        status: 'ok',
        data: { revenue_cents: revenueCents, recorded_payroll_cents: payrollCents },
        explanation: 'Pay statements exist for this window but record no revenue.',
        rowCount: staffCount,
        presentation: {
          answer: `The pay statements covering ${period.label} record no revenue, so there is nothing to take payroll off. That usually means the period has been created but its figures have not been generated yet.`,
          evidence: [this.evidence(labels)],
          confidence: 'high',
          limitations: ['No revenue was recorded on the statements for this window.'],
          suggestedNextStep: 'Ask "How is my business doing?" for the trading picture instead.',
          responseType: 'Explanation',
        },
      };
    }

    const remainingCents = revenueCents - payrollCents;
    // Percentages are of REVENUE, stated as such — a bare "%" beside a money
    // figure invites reading it as a profit margin.
    const payrollPct = round1((payrollCents / revenueCents) * 100);
    const remainingPct = round1((remainingCents / revenueCents) * 100);

    const answer = [
      `Across ${labels.length === 1 ? 'the pay period' : `${labels.length} pay periods`} covering ${period.label}, ${money(revenueCents, currency)} of revenue was recorded and ${money(payrollCents, currency)} of that went on payroll (${payrollPct}% of revenue).`,
      `That leaves ${money(remainingCents, currency)} — ${remainingPct}% of revenue — after recorded payroll.`,
      `**This is not your net profit.** It still has to cover rent, products, utilities, software, insurance, taxes and everything else, and QLOOQO does not record those, so I cannot work out a profit figure and will not estimate one.`,
    ].join('\n\n');

    return {
      status: 'ok',
      data: {
        pay_periods: labels.length,
        staff_statements: staffCount,
        revenue_cents: revenueCents,
        recorded_payroll_cents: payrollCents,
        remaining_after_payroll_cents: remainingCents,
        remaining_after_payroll_percent: remainingPct,
        currency_code: currency,
        stale_statement_count: staleCount,
      },
      explanation:
        'Revenue and payroll are read from your generated pay statements; the subtraction is shown in full.',
      rowCount: staffCount,
      presentation: {
        answer,
        evidence: [this.evidence(labels)],
        confidence: staleCount > 0 ? 'medium' : 'high',
        limitations: [
          'This is revenue less recorded payroll — NOT net profit, gross profit or a contribution margin. Rent, products, utilities, software, insurance and taxes are not recorded in QLOOQO.',
          `Figures come from ${labels.length === 1 ? 'the pay period' : 'the pay periods'} ${labels.join(', ')}, which may not line up exactly with ${period.label}.`,
          staleCount > 0
            ? `${staleCount} pay statement${staleCount === 1 ? ' is' : 's are'} marked out of date, so this total may move when payroll is regenerated.`
            : 'All pay statements in this window are current.',
          ...(period.unsupportedReason ? [period.unsupportedReason] : []),
        ],
        suggestedNextStep:
          'Ask "How is my retail doing?" for gross margin on the products where cost was recorded.',
        responseType: 'Insight',
      },
    };
  }

  private evidence(labels: string[]) {
    return {
      source_type: 'payroll.pay_summaries',
      source_ref: `pay-periods:${labels.length}`,
      as_of: null,
      entities_used: [],
    };
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function money(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  const sign = cents < 0 ? '-' : '';
  return `${sign}${symbol}${(Math.abs(cents) / 100).toFixed(2)}`;
}
