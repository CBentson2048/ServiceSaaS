/**
 * PDF/CSV export + email of pay summaries (Week 3 deliverable: "Generate
 * PDF/CSV exports and email pay summaries to staff or accountant").
 *
 * Figures-match-the-screen guarantee: every export is generated FROM THE SAME
 * READ PATH the web screens render — `PayrollService.listSummaries` for the
 * period table and `PayrollService.getSummaryBreakdown` for the payslip
 * drill-down. This service never re-derives a figure with its own queries;
 * it only formats what those methods return (acceptance: "PDF and CSV exports
 * match the on-screen wage summary figures").
 *
 * Recipient rules:
 *  - Payslip email: the staff member's OWN email, resolved server-side from
 *    core.staff_profiles -> core.user_profiles. The endpoint takes no
 *    recipient parameter by construction.
 *  - Period email: an explicit recipient (the accountant), validated by DTO.
 *
 * Stamps: exported_at / emailed_at on payroll.pay_summaries are best-effort
 * (allowlisted as writable even on locked periods — that is by design); a
 * failed stamp is logged, never surfaced.
 */

import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import type {
  AuthUser,
  ListPaySummariesResponse,
  PayPeriod,
  PaySummaryBreakdown,
  PaySummaryListItem,
  PayrollWarning,
} from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { PayrollService } from './payroll.service';

export const PAYROLL_EXPORT_DISCLAIMER =
  'Total pay before tax, National Insurance and pension.';

interface PeriodExport {
  filename: string;
  content: Buffer;
}

export interface EmailDeliveryResult {
  delivered: boolean;
  to: string;
}

/** £ with 2dp for humans (PDF). Signed: -£12.34. */
function poundsDisplay(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}£${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Plain signed 2dp number for CSV cells (spreadsheet-summable). */
function poundsCsv(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** RFC 4180 escaping: quote when the value contains comma, quote or newline. */
function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(cells: Array<string | number | null | undefined>): string {
  return cells.map(csvCell).join(',');
}

/** period_end is EXCLUSIVE in the data; humans read the inclusive last day. */
function inclusiveEndDate(periodEndExclusive: string): string {
  const date = new Date(`${periodEndExclusive}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** "4 Aug – 10 Aug 2026" for email subjects and PDF headers. */
function humanRange(period: PayPeriod): string {
  const format = (iso: string): string => {
    const date = new Date(`${iso}T00:00:00Z`);
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  };
  const year = inclusiveEndDate(period.periodEnd).slice(0, 4);
  return `${format(period.periodStart)} – ${format(inclusiveEndDate(period.periodEnd))} ${year}`;
}

/** "2026-08-04_2026-08-10" (inclusive range) for filenames. */
function periodSlug(period: PayPeriod): string {
  return `${period.periodStart}_${inclusiveEndDate(period.periodEnd)}`;
}

function nameSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'staff';
}

@Injectable()
export class PayrollExportService {
  private readonly logger = new Logger(PayrollExportService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly payroll: PayrollService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Period CSV
  // ---------------------------------------------------------------------------

  async exportPeriodCsv(actor: AuthUser, periodId: string): Promise<PeriodExport> {
    const data = await this.loadPeriodData(actor, periodId);
    const csv = this.buildPeriodCsv(data);
    await this.stampExported(
      actor,
      data.summaries.map((s) => s.summaryId),
      { periodId: data.period.id, format: 'csv' },
    );
    return {
      filename: `pay-period_${periodSlug(data.period)}.csv`,
      content: Buffer.from(csv, 'utf8'),
    };
  }

  // ---------------------------------------------------------------------------
  // Period PDF
  // ---------------------------------------------------------------------------

  async exportPeriodPdf(actor: AuthUser, periodId: string): Promise<PeriodExport> {
    const data = await this.loadPeriodData(actor, periodId);
    const pdf = await this.buildPeriodPdf(data);
    await this.stampExported(
      actor,
      data.summaries.map((s) => s.summaryId),
      { periodId: data.period.id, format: 'pdf' },
    );
    return { filename: `pay-period_${periodSlug(data.period)}.pdf`, content: pdf };
  }

  // ---------------------------------------------------------------------------
  // Single payslip PDF
  // ---------------------------------------------------------------------------

  async exportSummaryPdf(actor: AuthUser, summaryId: string): Promise<PeriodExport> {
    const { breakdown, period } = await this.loadSummaryData(actor, summaryId);
    const pdf = await this.buildPayslipPdf(breakdown, period);
    await this.stampExported(actor, [breakdown.summary.id], {
      periodId: period.id,
      format: 'pdf',
    });
    return {
      filename: `payslip_${nameSlug(breakdown.staffName)}_${periodSlug(period)}.pdf`,
      content: pdf,
    };
  }

  // ---------------------------------------------------------------------------
  // Email: payslip to the staff member's OWN address (server-resolved)
  // ---------------------------------------------------------------------------

  async emailSummaryToStaff(actor: AuthUser, summaryId: string): Promise<EmailDeliveryResult> {
    const { breakdown, period } = await this.loadSummaryData(actor, summaryId);
    const to = await this.resolveStaffEmail(actor.businessId, breakdown.summary.staffProfileId);
    if (!to) {
      throw new UnprocessableEntityException(
        `${breakdown.staffName} has no email address on file, so their pay summary cannot be emailed.`,
      );
    }

    const pdf = await this.buildPayslipPdf(breakdown, period);
    const range = humanRange(period);
    const result = await this.email.send({
      to,
      subject: `Your pay summary — ${range}`,
      text: [
        `Hi ${breakdown.staffName},`,
        `Your pay summary for ${range} is attached as a PDF. It shows the full breakdown behind your gross payable figure.`,
        PAYROLL_EXPORT_DISCLAIMER,
      ].join('\n\n'),
      html: [
        `<p>Hi ${escapeHtml(breakdown.staffName)},</p>`,
        `<p>Your pay summary for ${escapeHtml(range)} is attached as a PDF. It shows the full breakdown behind your gross payable figure.</p>`,
        `<p>${escapeHtml(PAYROLL_EXPORT_DISCLAIMER)}</p>`,
      ].join('\n'),
      attachments: [
        {
          filename: `payslip_${nameSlug(breakdown.staffName)}_${periodSlug(period)}.pdf`,
          content: pdf,
        },
      ],
      tags: [{ name: 'category', value: 'payroll-payslip' }],
    });

    if (result.delivered) {
      await this.stampEmailed(actor, [breakdown.summary.id], {
        periodId: period.id,
        recipient: 'staff',
      });
    }
    return { delivered: result.delivered, to };
  }

  // ---------------------------------------------------------------------------
  // Email: consolidated period CSV+PDF to an explicit recipient (accountant)
  // ---------------------------------------------------------------------------

  async emailPeriodToRecipient(
    actor: AuthUser,
    periodId: string,
    recipientEmail: string,
  ): Promise<EmailDeliveryResult> {
    const data = await this.loadPeriodData(actor, periodId);
    const csv = Buffer.from(this.buildPeriodCsv(data), 'utf8');
    const pdf = await this.buildPeriodPdf(data);
    const range = humanRange(data.period);
    const to = recipientEmail.trim().toLowerCase();

    const result = await this.email.send({
      to,
      subject: `Pay summaries — ${data.businessName}, ${range}`,
      text: [
        `The pay summaries for ${data.businessName} covering ${range} are attached as CSV and PDF.`,
        `The figures were exported by ${actor.profile?.fullName ?? 'a payroll user'} from QLOOQO.`,
        PAYROLL_EXPORT_DISCLAIMER,
      ].join('\n\n'),
      html: [
        `<p>The pay summaries for ${escapeHtml(data.businessName)} covering ${escapeHtml(range)} are attached as CSV and PDF.</p>`,
        `<p>The figures were exported by ${escapeHtml(actor.profile?.fullName ?? 'a payroll user')} from QLOOQO.</p>`,
        `<p>${escapeHtml(PAYROLL_EXPORT_DISCLAIMER)}</p>`,
      ].join('\n'),
      attachments: [
        { filename: `pay-period_${periodSlug(data.period)}.csv`, content: csv },
        { filename: `pay-period_${periodSlug(data.period)}.pdf`, content: pdf },
      ],
      tags: [{ name: 'category', value: 'payroll-period' }],
    });

    if (result.delivered) {
      await this.stampEmailed(
        actor,
        data.summaries.map((s) => s.summaryId),
        { periodId: data.period.id, recipient: 'external' },
      );
    }
    return { delivered: result.delivered, to };
  }

  // ---------------------------------------------------------------------------
  // Shared data loading — THE screen read paths, nothing else
  // ---------------------------------------------------------------------------

  private async loadPeriodData(
    actor: AuthUser,
    periodId: string,
  ): Promise<ListPaySummariesResponse & { businessName: string }> {
    // Same method behind GET /payroll/periods/:periodId/summaries — the
    // period-detail screen's table. Scoping/404s happen inside it.
    const response = await this.payroll.listSummaries(actor, periodId);
    if (response.summaries.length === 0) {
      throw new ConflictException('Nothing to export — calculate pay first.');
    }
    return { ...response, businessName: await this.businessName(actor.businessId) };
  }

  private async loadSummaryData(
    actor: AuthUser,
    summaryId: string,
  ): Promise<{ breakdown: PaySummaryBreakdown; period: PayPeriod }> {
    // Same method behind GET /payroll/summaries/:summaryId — the payslip
    // drill-down screen. Scoping/404s happen inside it.
    const { breakdown } = await this.payroll.getSummaryBreakdown(actor, summaryId);
    // The period is only needed for its date range/status header; re-reading it
    // through the scoped list path keeps a single source of truth.
    const list = await this.payroll.listSummaries(actor, breakdown.summary.payPeriodId);
    return { breakdown, period: list.period };
  }

  private async businessName(businessId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('id,name')
      .eq('id', businessId)
      .maybeSingle<{ id: string; name: string | null }>();
    if (error) {
      this.logger.error(`businessName failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load the business for export');
    }
    return data?.name?.trim() || 'Your business';
  }

  /** staff_profiles -> user_profiles email, service-role, business-scoped. */
  private async resolveStaffEmail(
    businessId: string,
    staffProfileId: string,
  ): Promise<string | null> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,user_profile_id,user_profiles(email)')
      .eq('id', staffProfileId)
      .eq('business_id', businessId)
      .maybeSingle<{
        id: string;
        user_profile_id: string | null;
        user_profiles: { email: string | null }[] | { email: string | null } | null;
      }>();
    if (error) {
      this.logger.error(`resolveStaffEmail failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve the staff email address');
    }
    if (!data) throw new NotFoundException('Staff member not found in your business');
    const profile = Array.isArray(data.user_profiles) ? data.user_profiles[0] : data.user_profiles;
    const email = profile?.email?.trim().toLowerCase();
    return email || null;
  }

  // ---------------------------------------------------------------------------
  // Stamps (best-effort; allowlisted writable on locked periods by design)
  // ---------------------------------------------------------------------------

  private async stampExported(
    actor: AuthUser,
    summaryIds: string[],
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.stamp(actor, summaryIds, { exported_at: new Date().toISOString() });
    await this.audit.record(actor, {
      entityType: 'pay_summary',
      entityId: (meta['periodId'] as string) ?? null,
      action: 'payroll.exported',
      after: { ...meta, summaryCount: summaryIds.length },
    });
  }

  private async stampEmailed(
    actor: AuthUser,
    summaryIds: string[],
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.stamp(actor, summaryIds, { emailed_at: new Date().toISOString() });
    await this.audit.record(actor, {
      entityType: 'pay_summary',
      entityId: (meta['periodId'] as string) ?? null,
      action: 'payroll.emailed',
      after: { ...meta, summaryCount: summaryIds.length },
    });
  }

  private async stamp(
    actor: AuthUser,
    summaryIds: string[],
    patch: Record<string, string>,
  ): Promise<void> {
    if (summaryIds.length === 0) return;
    try {
      const { error } = await this.admin
        .schema('payroll')
        .from('pay_summaries')
        .update(patch)
        .in('id', summaryIds)
        .eq('business_id', actor.businessId);
      if (error) {
        this.logger.error(`pay summary stamp failed (${Object.keys(patch).join(',')}): ${error.message}`);
      }
    } catch (err) {
      this.logger.error(`pay summary stamp threw: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // CSV rendering
  // ---------------------------------------------------------------------------

  buildPeriodCsv(data: ListPaySummariesResponse & { businessName: string }): string {
    const { period, summaries, businessName } = data;
    const lines: string[] = [];
    lines.push(csvRow(['Business', businessName]));
    lines.push(
      csvRow(['Period', `${period.periodStart} to ${inclusiveEndDate(period.periodEnd)}`]),
    );
    lines.push(csvRow(['Kind', period.kind]));
    lines.push(csvRow(['Frequency', period.frequency]));
    lines.push(csvRow(['Status', period.status]));
    lines.push(csvRow(['Generated at', period.generatedAt ?? '']));
    lines.push(csvRow(['Disclaimer', PAYROLL_EXPORT_DISCLAIMER]));
    lines.push('');
    lines.push(
      csvRow([
        'Staff name',
        'Employment type',
        'Pay plan',
        'Plan version',
        'Payable hours',
        'Worked hours',
        'Service revenue target (£)',
        'Service revenue (£)',
        'Retail revenue (£)',
        'Base pay (£)',
        'Commission (£)',
        'Revenue split (£)',
        'Chair rent (£)',
        'Deductions (£)',
        'Bonuses (£)',
        'Adjustments (£)',
        'Gross payable (£)',
        'Business retained (£)',
        'Greater-of winner',
        'Warnings',
      ]),
    );
    for (const summary of summaries) {
      lines.push(
        csvRow([
          summary.staffName,
          summary.employmentTypeSnapshot,
          summary.structureName ?? '',
          summary.structureVersionNo ?? '',
          summary.payableHours.toFixed(2),
          summary.workedHours.toFixed(2),
          summary.serviceRevenueTargetCents === null
            ? ''
            : poundsCsv(summary.serviceRevenueTargetCents),
          poundsCsv(summary.serviceRevenueCents),
          poundsCsv(summary.retailRevenueCents),
          poundsCsv(summary.basePayCents),
          poundsCsv(summary.commissionCents),
          poundsCsv(summary.revenueSplitCents),
          poundsCsv(summary.chairRentCents),
          poundsCsv(summary.deductionsCents),
          poundsCsv(summary.bonusCents),
          poundsCsv(summary.adjustmentsCents),
          poundsCsv(summary.grossPayableCents),
          poundsCsv(summary.businessRetainedCents),
          summary.greaterOfWinner ?? '',
          summary.warnings.length,
        ]),
      );
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  // ---------------------------------------------------------------------------
  // PDF rendering (pdfkit; built-in Helvetica only, tabular text layout)
  // ---------------------------------------------------------------------------

  private async buildPeriodPdf(
    data: ListPaySummariesResponse & { businessName: string },
  ): Promise<Buffer> {
    const { period, summaries, businessName } = data;
    return renderPdf({ layout: 'landscape' }, (doc) => {
      doc.font('Helvetica-Bold').fontSize(16).text(businessName);
      doc.moveDown(0.2);
      doc
        .font('Helvetica')
        .fontSize(11)
        .text(
          `Pay summaries — ${humanRange(period)} (${period.kind}, ${period.frequency}) — status: ${period.status}`,
        );
      doc.moveDown(0.2);
      doc
        .fontSize(9)
        .fillColor('#555555')
        .text(
          `Exported ${new Date().toISOString().slice(0, 10)}${period.generatedAt ? ` · figures generated ${period.generatedAt.slice(0, 10)}` : ''}`,
        );
      doc.fillColor('#000000');
      doc.moveDown(1);

      const columns: Array<{ header: string; width: number; value: (s: PaySummaryListItem) => string; align?: 'left' | 'right' }> = [
        { header: 'Staff', width: 108, value: (s) => s.staffName },
        { header: 'Type', width: 62, value: (s) => s.employmentTypeSnapshot.replace(/_/g, ' ') },
        { header: 'Hours', width: 44, value: (s) => s.payableHours.toFixed(2), align: 'right' },
        { header: 'Service rev', width: 62, value: (s) => poundsDisplay(s.serviceRevenueCents), align: 'right' },
        { header: 'Retail rev', width: 58, value: (s) => poundsDisplay(s.retailRevenueCents), align: 'right' },
        { header: 'Base pay', width: 58, value: (s) => poundsDisplay(s.basePayCents), align: 'right' },
        { header: 'Commission', width: 62, value: (s) => poundsDisplay(s.commissionCents), align: 'right' },
        { header: 'Rev split', width: 55, value: (s) => poundsDisplay(s.revenueSplitCents), align: 'right' },
        { header: 'Chair rent', width: 55, value: (s) => poundsDisplay(s.chairRentCents), align: 'right' },
        { header: 'Deductions', width: 58, value: (s) => poundsDisplay(s.deductionsCents), align: 'right' },
        { header: 'Adjust.', width: 50, value: (s) => poundsDisplay(s.adjustmentsCents), align: 'right' },
        { header: 'Gross payable', width: 62, value: (s) => poundsDisplay(s.grossPayableCents), align: 'right' },
      ];
      drawTable(doc, columns, summaries);

      doc.moveDown(1);
      const totalGross = summaries.reduce((sum, s) => sum + s.grossPayableCents, 0);
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(
          `Total gross payable across ${summaries.length} staff: ${poundsDisplay(totalGross)}`,
        );
      const warningCount = summaries.reduce((sum, s) => sum + s.warnings.length, 0);
      if (warningCount > 0) {
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor('#8a6d00')
          .text(
            `${warningCount} warning${warningCount === 1 ? '' : 's'} across this period — open the individual payslips for details.`,
          );
        doc.fillColor('#000000');
      }
      doc.moveDown(1);
      doc.font('Helvetica-Oblique').fontSize(9).text(PAYROLL_EXPORT_DISCLAIMER);
    });
  }

  private async buildPayslipPdf(
    breakdown: PaySummaryBreakdown,
    period: PayPeriod,
  ): Promise<Buffer> {
    const { summary, staffName, hours, lines, warnings } = breakdown;
    return renderPdf({ layout: 'portrait' }, (doc) => {
      doc.font('Helvetica-Bold').fontSize(16).text('Pay summary');
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(12).text(staffName);
      doc
        .font('Helvetica')
        .fontSize(10)
        .text(`Employment type: ${summary.employmentTypeSnapshot.replace(/_/g, ' ')}`)
        .text(`Period: ${humanRange(period)} (${period.frequency}) — status: ${period.status}`)
        .text(`Generated: ${summary.generatedAt.slice(0, 10)}`);
      doc.moveDown(1);

      // Hours table
      doc.font('Helvetica-Bold').fontSize(11).text('Hours');
      doc.moveDown(0.3);
      drawTable(
        doc,
        [
          { header: 'Category', width: 130, value: (h: (typeof hours)[number]) => h.category.replace(/_/g, ' ') },
          { header: 'Hours', width: 60, value: (h) => h.hours.toFixed(2), align: 'right' },
          { header: 'Counts toward target', width: 110, value: (h) => (h.countedTowardTarget ? 'yes' : 'no') },
          { header: 'Paid', width: 50, value: (h) => (h.countedAsPaid ? 'yes' : 'no') },
        ],
        hours,
      );
      doc.moveDown(1);

      // Itemised lines
      doc.font('Helvetica-Bold').fontSize(11).text('Itemised pay lines');
      doc.moveDown(0.3);
      drawTable(
        doc,
        [
          { header: 'Item', width: 210, value: (l: (typeof lines)[number]) => l.label ?? l.lineType.replace(/_/g, ' ') },
          {
            header: 'Basis',
            width: 90,
            value: (l) => (l.basisAmountCents === null ? '' : poundsDisplay(l.basisAmountCents)),
            align: 'right',
          },
          {
            header: 'Rate',
            width: 60,
            value: (l) => (l.ratePercent === null ? '' : `${l.ratePercent}%`),
            align: 'right',
          },
          {
            header: 'Amount',
            width: 90,
            value: (l) => (l.sourceUnavailable ? 'not captured' : poundsDisplay(l.amountCents)),
            align: 'right',
          },
        ],
        lines,
      );
      doc.moveDown(1);

      // Totals block. Gross payable is SIGNED: negative means the stylist owes
      // the business (normal for chair renters), and the sign is preserved.
      doc.font('Helvetica-Bold').fontSize(11).text('Totals');
      doc.moveDown(0.3);
      const totals: Array<[string, number]> = [
        ['Base pay', summary.basePayCents],
        ['Commission', summary.commissionCents],
        ['Revenue split', summary.revenueSplitCents],
        ['Bonuses', summary.bonusCents],
        ['Chair rent', summary.chairRentCents],
        ['Deductions', summary.deductionsCents],
        ['Adjustments', summary.adjustmentsCents],
      ];
      doc.font('Helvetica').fontSize(10);
      for (const [label, cents] of totals) {
        doc.text(`${label}: ${poundsDisplay(cents)}`);
      }
      doc.moveDown(0.3);
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(`Gross payable: ${poundsDisplay(summary.grossPayableCents)}`);
      if (summary.grossPayableCents < 0) {
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor('#8a1f11')
          .text('A negative gross payable means this amount is owed to the business.');
        doc.fillColor('#000000');
      }
      doc.moveDown(1);

      // Warnings, verbatim — an uncaptured source must never read as £0.00.
      if (warnings.length > 0) {
        doc.font('Helvetica-Bold').fontSize(11).text('Warnings');
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(9).fillColor('#8a6d00');
        for (const warning of warnings) {
          doc.text(`• ${warningText(warning)}`);
        }
        doc.fillColor('#000000');
        doc.moveDown(1);
      }

      doc.font('Helvetica-Oblique').fontSize(9).text(PAYROLL_EXPORT_DISCLAIMER);
    });
  }
}

function warningText(warning: PayrollWarning): string {
  return warning.message;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// -----------------------------------------------------------------------------
// pdfkit plumbing
// -----------------------------------------------------------------------------

function renderPdf(
  options: { layout: 'portrait' | 'landscape' },
  draw: (doc: PDFKit.PDFDocument) => void,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: options.layout, margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

interface TableColumn<T> {
  header: string;
  width: number;
  value: (row: T) => string;
  align?: 'left' | 'right';
}

/**
 * Styled table: dark header band, zebra rows, hairline row separators,
 * page-break aware (the header band repeats on every page).
 */
function drawTable<T>(doc: PDFKit.PDFDocument, columns: TableColumn<T>[], rows: T[]): void {
  const startX = doc.page.margins.left;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const headerHeight = 20;
  const rowHeight = 18;
  const cellPadX = 6;
  const tableWidth = columns.reduce((w, c) => w + c.width, 0);

  const drawCells = (texts: string[], y: number, height: number): void => {
    let x = startX;
    for (let i = 0; i < columns.length; i += 1) {
      doc.text(texts[i], x + cellPadX, y + (height - 8) / 2 - 1, {
        width: columns[i].width - cellPadX * 2,
        align: columns[i].align ?? 'left',
        lineBreak: false,
      });
      x += columns[i].width;
    }
  };

  const drawHeader = (): void => {
    const y = doc.y;
    doc.rect(startX, y, tableWidth, headerHeight).fill('#2b2b33');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    drawCells(columns.map((c) => c.header), y, headerHeight);
    doc.fillColor('#000000');
    doc.x = startX;
    doc.y = y + headerHeight;
  };

  drawHeader();
  rows.forEach((row, index) => {
    if (doc.y + rowHeight > bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    if (index % 2 === 1) {
      doc.rect(startX, y, tableWidth, rowHeight).fill('#f5f5f7');
      doc.fillColor('#000000');
    }
    doc.font('Helvetica').fontSize(8).fillColor('#1a1a1a');
    drawCells(columns.map((c) => c.value(row)), y, rowHeight);
    doc
      .moveTo(startX, y + rowHeight)
      .lineTo(startX + tableWidth, y + rowHeight)
      .lineWidth(0.5)
      .strokeColor('#dddde2')
      .stroke();
    doc.x = startX;
    doc.y = y + rowHeight;
  });
  doc.strokeColor('#000000').fillColor('#000000');
  doc.x = startX;
}
