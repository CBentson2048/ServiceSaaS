/**
 * Pre-flight gate for pay-period generation.
 *
 * Runs the SAME pure engine in dry-run and classifies the outcome per staff
 * member: missing configuration inputs BLOCK (canGenerate=false); uncaptured
 * transaction sources WARN but do not block (docs/V1.1/3-2 plan.md §5.1).
 * Because readiness and generation share one code path, they can never
 * disagree about whether a statement is calculable.
 */

import { Injectable } from '@nestjs/common';
import type { AuthUser, PayrollReadiness, PayrollWarning } from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { PayrollInputsService } from './payroll-inputs.service';
import { calculatePaySummary } from './payroll.calc';

interface ReadinessArgs {
  actor: AuthUser;
  periodStart: string;
  periodEnd: string;
  locationId: string | null;
}

@Injectable()
export class PayrollReadinessService {
  constructor(private readonly inputs: PayrollInputsService) {}

  async assess(args: ReadinessArgs): Promise<PayrollReadiness> {
    const { actor, periodStart, periodEnd, locationId } = args;
    const settings = await this.inputs.loadSettings(actor.businessId);
    const { capture, rows } = await this.inputs.loadCaptureMatrix(actor.businessId);
    const allStaff = await this.inputs.loadStaff(actor.businessId);
    const locationScoped = locationId
      ? allStaff.filter((s) => s.primaryLocationId === locationId)
      : allStaff;
    // A location-scoped manager must never see other locations' staff revenue
    // through a business-wide period's readiness payload.
    const staff = userHasRole(actor, 'owner')
      ? locationScoped
      : locationScoped.filter(
          (s) =>
            s.primaryLocationId !== null && actor.allowedLocationIds.includes(s.primaryLocationId),
        );
    const versions = await this.inputs.resolveRuleVersions(
      actor.businessId,
      staff.map((s) => s.staffProfileId),
      periodStart,
    );
    const engineInputs = await this.inputs.buildEngineInputs({
      businessId: actor.businessId,
      periodStart,
      periodEnd,
      timezone: settings.effectiveTimezone,
      staff,
      versions,
      capture,
    });

    const readiness: PayrollReadiness = { canGenerate: true, staff: [], warnings: [] };

    // Business-level: name every uncaptured source up front.
    for (const row of rows) {
      if (!row.isCaptured) {
        readiness.warnings.push({
          kind: 'source_unavailable',
          source: row.source,
          stageLabel: null,
          message: `${sourceSentence(row.source)} capture is not enabled${row.notes ? ` — ${row.notes}` : '.'}`,
        });
      }
    }

    for (const member of staff) {
      const engineInput = engineInputs.get(member.staffProfileId);
      if (!engineInput) continue;
      if (!engineInput.version) {
        const hadRevenue = engineInput.serviceLines.length > 0;
        readiness.staff.push({
          staffProfileId: member.staffProfileId,
          staffName: member.staffName,
          canGenerate: !hadRevenue,
          warnings: hadRevenue
            ? [
                {
                  kind: 'input_missing',
                  input: 'pay_structure',
                  staffProfileId: member.staffProfileId,
                  message: `${member.staffName} took revenue this period but has no pay structure assigned.`,
                },
              ]
            : [
                {
                  kind: 'input_missing',
                  input: 'pay_structure',
                  staffProfileId: member.staffProfileId,
                  message: `${member.staffName} has no pay structure assigned and will be skipped.`,
                },
              ],
        });
        if (hadRevenue) readiness.canGenerate = false;
        continue;
      }
      const result = calculatePaySummary(engineInput);
      const blocking = result.warnings.filter((w) => w.kind === 'input_missing');
      readiness.staff.push({
        staffProfileId: member.staffProfileId,
        staffName: member.staffName,
        canGenerate: result.ok,
        warnings: result.warnings,
      });
      if (!result.ok && blocking.length > 0) readiness.canGenerate = false;
    }
    return readiness;
  }
}

function sourceSentence(source: PayrollWarning extends never ? never : string): string {
  const labels: Record<string, string> = {
    service_revenue: 'Service revenue',
    retail_sales: 'Retail sales',
    tips: 'Tips',
    refunds: 'Refunds',
    cancellation_fees: 'Cancellation fee',
    product_cost: 'Product cost',
  };
  return labels[source] ?? source;
}
