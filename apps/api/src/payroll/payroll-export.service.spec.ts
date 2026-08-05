/**
 * Exports must MATCH THE SCREEN: the CSV/PDF figures are asserted against the
 * exact values returned by the summaries read path (mocked here), because the
 * acceptance criterion is "PDF and CSV exports match the on-screen wage
 * summary figures" — the export service must format, never re-derive.
 *
 * Email is the counterpart criterion: the payslip goes only to the staff
 * member's own server-resolved address (422 when none), and emailed_at is
 * stamped only on actual delivery.
 */

import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type {
  AuthUser,
  ListPaySummariesResponse,
  PayPeriod,
  PaySummaryBreakdown,
  PaySummaryListItem,
} from '@sheer/domain';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../common/testing/supabase-fake';
import { PAYROLL_EXPORT_DISCLAIMER, PayrollExportService } from './payroll-export.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => {
    return (globalThis as { __supabaseFake?: unknown }).__supabaseFake;
  }),
}));

const BUSINESS_ID = 'b1000000-0000-0000-0000-000000000001';
const PERIOD_ID = 'p1000000-0000-0000-0000-000000000001';
const SUMMARY_ID = 's1000000-0000-0000-0000-000000000001';
const RENTER_SUMMARY_ID = 's2000000-0000-0000-0000-000000000002';
const STAFF_ID = 'f1000000-0000-0000-0000-000000000001';
const RENTER_STAFF_ID = 'f2000000-0000-0000-0000-000000000002';

function owner(): AuthUser {
  return {
    id: 'u1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS_ID,
    allowedLocationIds: [],
    locationScope: 'all',
    locations: [],
    permissions: ['payroll.view', 'payroll.export', 'payroll.email'],
    profile: { fullName: 'Owner', email: 'owner@example.com' },
  } as unknown as AuthUser;
}

function period(): PayPeriod {
  return {
    id: PERIOD_ID,
    businessId: BUSINESS_ID,
    locationId: null,
    kind: 'calculation',
    frequency: 'weekly',
    periodStart: '2026-08-04',
    periodEnd: '2026-08-11', // exclusive -> inclusive last day 2026-08-10
    label: null,
    status: 'approved',
    parentPaymentPeriodId: null,
    generatedByUserProfileId: 'u1',
    generatedAt: '2026-08-11T08:00:00Z',
    approvedByUserProfileId: 'u1',
    approvedAt: '2026-08-11T09:00:00Z',
    lockedByUserProfileId: null,
    lockedAt: null,
    markedPaidByUserProfileId: null,
    paidAt: null,
    notes: null,
    createdAt: '2026-08-04T00:00:00Z',
    updatedAt: '2026-08-11T09:00:00Z',
  };
}

function summaryItem(overrides: Partial<PaySummaryListItem> = {}): PaySummaryListItem {
  return {
    summaryId: SUMMARY_ID,
    staffProfileId: STAFF_ID,
    staffName: 'Jane Doe',
    employmentTypeSnapshot: 'employed',
    structureName: 'Employed stylist',
    structureVersionNo: 2,
    payableHours: 40,
    workedHours: 38.5,
    serviceRevenueTargetCents: 146520,
    serviceRevenueCents: 250000,
    retailRevenueCents: 12000,
    basePayCents: 48840,
    commissionCents: 25875,
    revenueSplitCents: 0,
    chairRentCents: 0,
    deductionsCents: 0,
    bonusCents: 5000,
    adjustmentsCents: -1500,
    netPayableCents: 78215,
    businessRetainedCents: 183785,
    greaterOfApplied: false,
    greaterOfWinner: null,
    acceleratorAchieved: true,
    isStale: false,
    staleReason: null,
    warnings: [],
    currencyCode: 'GBP',
    ...overrides,
  };
}

/** A chair renter whose signed net payable is NEGATIVE (they owe the salon). */
function renterItem(): PaySummaryListItem {
  return summaryItem({
    summaryId: RENTER_SUMMARY_ID,
    staffProfileId: RENTER_STAFF_ID,
    staffName: 'O\'Hara, "Renter" Kim',
    employmentTypeSnapshot: 'self_employed',
    structureName: 'Chair renter',
    structureVersionNo: 1,
    payableHours: 0,
    workedHours: 32,
    serviceRevenueTargetCents: null,
    serviceRevenueCents: 110000,
    retailRevenueCents: 0,
    basePayCents: 0,
    commissionCents: 0,
    revenueSplitCents: 77000,
    chairRentCents: -90000,
    deductionsCents: -500,
    bonusCents: 0,
    adjustmentsCents: 0,
    netPayableCents: -13500,
    businessRetainedCents: 123500,
    greaterOfWinner: null,
    warnings: [
      {
        kind: 'source_unavailable',
        source: 'tips',
        message: 'Tips are not captured for this business — tip payouts are not included.',
      },
    ],
  });
}

function listResponse(): ListPaySummariesResponse {
  return { period: period(), summaries: [summaryItem(), renterItem()], periodWarnings: [] };
}

function breakdown(): PaySummaryBreakdown {
  const item = renterItem();
  return {
    summary: {
      id: item.summaryId,
      businessId: BUSINESS_ID,
      payPeriodId: PERIOD_ID,
      staffProfileId: item.staffProfileId,
      employmentTypeSnapshot: item.employmentTypeSnapshot,
      structureId: 'st1',
      structureVersionId: 'sv1',
      currencyCode: 'GBP',
      serviceRevenueCents: item.serviceRevenueCents,
      retailRevenueCents: item.retailRevenueCents,
      totalCollectedCents: 110000,
      basePayCents: item.basePayCents,
      commissionCents: item.commissionCents,
      revenueSplitCents: item.revenueSplitCents,
      bonusCents: item.bonusCents,
      chairRentCents: item.chairRentCents,
      deductionsCents: item.deductionsCents,
      tipsPaidOutCents: 0,
      tipsOwedCents: 0,
      adjustmentsCents: item.adjustmentsCents,
      netPayableCents: item.netPayableCents,
      businessRetainedCents: item.businessRetainedCents,
      greaterOfApplied: false,
      greaterOfWinner: null,
      isStale: false,
      staleReason: null,
      supersededById: null,
      generatedByUserProfileId: 'u1',
      generatedAt: '2026-08-11T08:00:00Z',
      exportedAt: null,
      emailedAt: null,
      createdAt: '2026-08-11T08:00:00Z',
      updatedAt: '2026-08-11T08:00:00Z',
    },
    staffName: item.staffName,
    hours: [
      {
        id: 'h1',
        summaryId: item.summaryId,
        category: 'worked',
        hours: 32,
        countedTowardTarget: true,
        countedAsPaid: false,
        notes: null,
        createdAt: '2026-08-11T08:00:00Z',
      },
    ],
    lines: [
      {
        id: 'l1',
        summaryId: item.summaryId,
        sequenceNo: 1,
        lineType: 'revenue_split',
        stageId: null,
        bandId: null,
        label: 'Revenue split (70%)',
        sourceType: null,
        sourceId: null,
        occurredOn: null,
        quantity: null,
        basisAmountCents: 110000,
        vatRatePercentSnapshot: 20,
        ratePercent: 70,
        amountCents: 77000,
        structureVersionId: 'sv1',
        sourceUnavailable: false,
        unavailableSource: null,
        createdAt: '2026-08-11T08:00:00Z',
      },
    ],
    target: { targetCents: null, basis: null, derivation: 'Not recorded.', adjustments: [] },
    accelerator: null,
    bands: [],
    greaterOf: null,
    adjustments: [],
    warnings: item.warnings,
  };
}

interface Deps {
  payroll: { listSummaries: jest.Mock; getSummaryBreakdown: jest.Mock };
  email: { send: jest.Mock };
  audit: { record: jest.Mock };
  state: SupabaseFakeState;
}

function buildService(overrides: Partial<Record<string, unknown>> = {}): {
  service: PayrollExportService;
  deps: Deps;
} {
  const state = createSupabaseFakeState({
    'core.businesses': [{ id: BUSINESS_ID, name: 'Luke Ormsby Hair' }],
    'core.staff_profiles': [
      {
        id: RENTER_STAFF_ID,
        business_id: BUSINESS_ID,
        user_profile_id: 'up2',
        user_profiles: { email: 'kim@example.com' },
      },
    ],
    'payroll.pay_summaries': [
      { id: SUMMARY_ID, business_id: BUSINESS_ID, exported_at: null, emailed_at: null },
      { id: RENTER_SUMMARY_ID, business_id: BUSINESS_ID, exported_at: null, emailed_at: null },
    ],
    ...(overrides['tables'] as Record<string, Record<string, unknown>[]> | undefined),
  });
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);

  const payroll = {
    listSummaries: jest.fn().mockResolvedValue(listResponse()),
    getSummaryBreakdown: jest.fn().mockResolvedValue({ breakdown: breakdown() }),
  };
  const email = { send: jest.fn().mockResolvedValue({ delivered: true, id: 'msg1' }) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const config = { getOrThrow: (key: string) => `fake-${key}` };

  const service = new PayrollExportService(
    config as never,
    payroll as never,
    email as never,
    audit as never,
  );
  return { service, deps: { payroll, email, audit, state } };
}

function csvLines(content: Buffer): string[] {
  return content.toString('utf8').split('\r\n');
}

/** Split one CSV line respecting quotes — enough for assertions. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

describe('period CSV export', () => {
  it('reproduces exactly the figures the summaries read path returned', async () => {
    const { service, deps } = buildService();
    const { filename, content } = await service.exportPeriodCsv(owner(), PERIOD_ID);

    // Same read path as the screen: GET periods/:id/summaries.
    expect(deps.payroll.listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID }),
      PERIOD_ID,
    );

    expect(filename).toBe('pay-period_2026-08-04_2026-08-10.csv');
    const lines = csvLines(content);
    const headerIndex = lines.findIndex((line) => line.startsWith('Staff name,'));
    expect(headerIndex).toBeGreaterThan(0);

    const jane = parseCsvLine(lines[headerIndex + 1]);
    expect(jane).toEqual([
      'Jane Doe',
      'employed',
      'Employed stylist',
      '2',
      '40.00',
      '38.50',
      '1465.20',
      '2500.00',
      '120.00',
      '488.40',
      '258.75',
      '0.00',
      '0.00',
      '0.00',
      '50.00',
      '-15.00',
      '782.15',
      '1837.85',
      '',
      '0',
    ]);

    // Chair renter: SIGNED negative net payable survives into the export.
    const renter = parseCsvLine(lines[headerIndex + 2]);
    expect(renter[0]).toBe('O\'Hara, "Renter" Kim');
    expect(renter[1]).toBe('self_employed');
    expect(renter[12]).toBe('-900.00'); // chair rent
    expect(renter[16]).toBe('-135.00'); // net payable, negative = owes the salon
    expect(renter[19]).toBe('1'); // warnings count
  });

  it('escapes names containing commas and quotes per RFC 4180', async () => {
    const { service } = buildService();
    const { content } = await service.exportPeriodCsv(owner(), PERIOD_ID);
    expect(content.toString('utf8')).toContain('"O\'Hara, ""Renter"" Kim"');
  });

  it('carries the pre-tax disclaimer and the period metadata rows', async () => {
    const { service } = buildService();
    const { content } = await service.exportPeriodCsv(owner(), PERIOD_ID);
    const text = content.toString('utf8');
    expect(text).toContain(PAYROLL_EXPORT_DISCLAIMER);
    expect(text).toContain('Business,Luke Ormsby Hair');
    expect(text).toContain('Period,2026-08-04 to 2026-08-10');
    expect(text).toContain('Kind,calculation');
    expect(text).toContain('Frequency,weekly');
    expect(text).toContain('Status,approved');
  });

  it('refuses a period with no generated summaries with 409', async () => {
    const { service, deps } = buildService();
    deps.payroll.listSummaries.mockResolvedValue({
      period: period(),
      summaries: [],
      periodWarnings: [],
    });
    await expect(service.exportPeriodCsv(owner(), PERIOD_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.exportPeriodCsv(owner(), PERIOD_ID)).rejects.toMatchObject({
      message: 'Nothing to export — calculate pay first.',
    });
  });

  it('stamps exported_at on the exported summaries (best effort)', async () => {
    const { service, deps } = buildService();
    await service.exportPeriodCsv(owner(), PERIOD_ID);
    const stamp = deps.state.log.find(
      (entry) => entry.table === 'payroll.pay_summaries' && entry.verb === 'update',
    );
    expect(stamp).toBeDefined();
    expect(stamp?.matched).toBe(2);
    expect(Object.keys(stamp?.payload as Record<string, unknown>)).toEqual(['exported_at']);
  });
});

describe('PDF exports', () => {
  it('renders a period PDF from the same read path', async () => {
    const { service, deps } = buildService();
    const { filename, content } = await service.exportPeriodPdf(owner(), PERIOD_ID);
    expect(deps.payroll.listSummaries).toHaveBeenCalled();
    expect(filename).toBe('pay-period_2026-08-04_2026-08-10.pdf');
    expect(content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(content.length).toBeGreaterThan(500);
  });

  it('renders a single payslip PDF from the breakdown read path, slugged filename', async () => {
    const { service, deps } = buildService();
    const { filename, content } = await service.exportSummaryPdf(owner(), RENTER_SUMMARY_ID);
    expect(deps.payroll.getSummaryBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID }),
      RENTER_SUMMARY_ID,
    );
    expect(filename).toBe('payslip_o-hara-renter-kim_2026-08-04_2026-08-10.pdf');
    expect(content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('payslip email (recipient resolved server-side, never a parameter)', () => {
  it('emails the staff member their own payslip PDF and stamps emailed_at', async () => {
    const { service, deps } = buildService();
    const result = await service.emailSummaryToStaff(owner(), RENTER_SUMMARY_ID);

    expect(result).toEqual({ delivered: true, to: 'kim@example.com' });
    expect(deps.email.send).toHaveBeenCalledTimes(1);
    const input = deps.email.send.mock.calls[0][0];
    expect(input.to).toBe('kim@example.com');
    expect(input.subject).toBe('Your pay summary — 4 Aug – 10 Aug 2026');
    expect(input.text).toContain(PAYROLL_EXPORT_DISCLAIMER);
    expect(input.attachments).toHaveLength(1);
    expect(input.attachments[0].filename).toBe(
      'payslip_o-hara-renter-kim_2026-08-04_2026-08-10.pdf',
    );
    expect((input.attachments[0].content as Buffer).subarray(0, 5).toString('latin1')).toBe(
      '%PDF-',
    );

    const stamp = deps.state.log.find(
      (entry) => entry.table === 'payroll.pay_summaries' && entry.verb === 'update',
    );
    expect(Object.keys(stamp?.payload as Record<string, unknown>)).toEqual(['emailed_at']);
  });

  it('refuses with 422 when the staff member has no email on file, and sends nothing', async () => {
    const { service, deps } = buildService({
      tables: {
        'core.staff_profiles': [
          {
            id: RENTER_STAFF_ID,
            business_id: BUSINESS_ID,
            user_profile_id: 'up2',
            user_profiles: { email: null },
          },
        ],
      },
    });
    await expect(service.emailSummaryToStaff(owner(), RENTER_SUMMARY_ID)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(deps.email.send).not.toHaveBeenCalled();
    expect(
      deps.state.log.filter(
        (entry) => entry.table === 'payroll.pay_summaries' && entry.verb === 'update',
      ),
    ).toHaveLength(0);
  });

  it('does not stamp emailed_at when delivery fails', async () => {
    const { service, deps } = buildService();
    deps.email.send.mockResolvedValue({ delivered: false, skipped: true });
    const result = await service.emailSummaryToStaff(owner(), RENTER_SUMMARY_ID);
    expect(result.delivered).toBe(false);
    expect(
      deps.state.log.filter(
        (entry) => entry.table === 'payroll.pay_summaries' && entry.verb === 'update',
      ),
    ).toHaveLength(0);
  });
});

describe('period email to an explicit recipient (the accountant)', () => {
  it('attaches both CSV and PDF and reports the recipient back', async () => {
    const { service, deps } = buildService();
    const result = await service.emailPeriodToRecipient(
      owner(),
      PERIOD_ID,
      'Accounts@Practice.co.uk',
    );
    expect(result).toEqual({ delivered: true, to: 'accounts@practice.co.uk' });
    const input = deps.email.send.mock.calls[0][0];
    expect(input.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      'pay-period_2026-08-04_2026-08-10.csv',
      'pay-period_2026-08-04_2026-08-10.pdf',
    ]);
    expect(input.text).toContain(PAYROLL_EXPORT_DISCLAIMER);
  });

  it('propagates the 409 for an uncalculated period before any email is sent', async () => {
    const { service, deps } = buildService();
    deps.payroll.listSummaries.mockResolvedValue({
      period: period(),
      summaries: [],
      periodWarnings: [],
    });
    await expect(
      service.emailPeriodToRecipient(owner(), PERIOD_ID, 'accounts@practice.co.uk'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(deps.email.send).not.toHaveBeenCalled();
  });
});
