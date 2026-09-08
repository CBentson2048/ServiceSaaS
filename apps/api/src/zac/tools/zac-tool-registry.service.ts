import { Injectable, Logger } from '@nestjs/common';
import {
  userHasAllPermissions,
  userHasAnyPermission,
  userHasAnyRole,
  userHasPermission,
} from '@sheer/domain';
import type { AuthUser } from '@sheer/domain';
import { ClientIntelligenceService } from '../../client-intelligence/client-intelligence.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { KpiService } from '../../kpi/kpi.service';
import { UtilisationService } from '../../kpi/utilisation.service';
import { LabAppointmentsService } from '../../lab-appointments/lab-appointments.service';
import { RetailSalesService } from '../../retail-sales/retail-sales.service';
import type { ZacActingContext } from '../context/zac-context.types';
import { AppointmentSummaryTool } from './tools/appointment-summary.tool';
import { BusinessContextSummaryTool } from './tools/business-context-summary.tool';
import { BusinessHealthSummaryTool } from './tools/business-health.tool';
import { ClientRetentionTool } from './tools/client-retention.tool';
import { InventoryStockStatusTool } from './tools/inventory-stock-status.tool';
import { KpiSummaryTool } from './tools/kpi-summary.tool';
import { LocationContextSummaryTool } from './tools/location-context-summary.tool';
import { MyScheduleTool } from './tools/my-schedule.tool';
import { PersonalStylistCoachingTool } from './tools/personal-stylist-coaching.tool';
import { ProfitabilityTool } from './tools/profitability.tool';
import { QlabColourAnalyticsTool } from './tools/qlab-colour-analytics.tool';
import { RebookingSummaryTool } from './tools/rebooking-summary.tool';
import { RetailPerformanceTool } from './tools/retail-performance.tool';
import { ServiceMixTool } from './tools/service-mix.tool';
import { StylistPerformanceTool } from './tools/stylist-performance.tool';
import { UtilisationSummaryTool } from './tools/utilisation-summary.tool';
import { ZacCapabilitySummaryTool } from './tools/zac-capability-summary.tool';
import type {
  ZacReadOnlyTool,
  ZacToolDispatchTrace,
  ZacToolName,
  ZacToolResult,
} from './zac-tool.types';

@Injectable()
export class ZacToolRegistryService {
  private readonly logger = new Logger(ZacToolRegistryService.name);
  private readonly tools: readonly ZacReadOnlyTool[];

  constructor(
    dashboard: DashboardService,
    kpi: KpiService,
    labAppointments: LabAppointmentsService,
    utilisation: UtilisationService,
    retailSales: RetailSalesService,
    clientIntelligence: ClientIntelligenceService,
  ) {
    const tools: ZacReadOnlyTool[] = [
      // Live tools. Context tools read only the guard-resolved acting context;
      // the rest call existing guarded QLOOQO services with the resolved actor.
      new BusinessContextSummaryTool(),
      new LocationContextSummaryTool(),
      new ZacCapabilitySummaryTool((actor) =>
        tools.filter((tool) => this.actorMayUse(actor, tool)),
      ),
      new BusinessHealthSummaryTool(dashboard),
      // Staff-performance tools (Week 3): dashboard reducers + KPI engine.
      new StylistPerformanceTool(dashboard),
      new KpiSummaryTool(kpi),
      new RebookingSummaryTool(dashboard),
      // Stylist-self tools: both self-scoped twice (tool contract + service).
      new PersonalStylistCoachingTool(kpi),
      new MyScheduleTool(labAppointments),
      // The final Core MVP tool: canonical utilisation over rota + bookings.
      new UtilisationSummaryTool(utilisation),
      // Workstream 1 — Expanded Intelligence. Each reads an EXISTING guarded
      // QLOOQO service with the resolved actor; none introduces a new KPI
      // formula, and each declares the same permission its own endpoint does.
      new AppointmentSummaryTool(dashboard),
      new ServiceMixTool(dashboard),
      new RetailPerformanceTool(retailSales, dashboard),
      new ClientRetentionTool(clientIntelligence),
      // Optional/deferred skeletons — registered but disabled. Registering
      // them is what lets ZAC answer "not connected yet" honestly instead of
      // falling through to generic capability copy.
      new ProfitabilityTool(),
      new QlabColourAnalyticsTool(),
      new InventoryStockStatusTool(),
    ];

    // Structural guarantees, enforced at boot so a mis-declared tool can never
    // register: read-only, fail-closed, and invisible to clients.
    for (const tool of tools) {
      if ((tool.readOnly as boolean) !== true || tool.errorBehavior !== 'fail_closed') {
        throw new Error(`ZAC tool ${tool.name} violates the read-only fail-closed contract`);
      }
      if (tool.allowedRoles.includes('client')) {
        throw new Error(`ZAC tool ${tool.name} must never be visible to clients`);
      }
    }
    this.tools = tools;
  }

  /**
   * Every registered tool, regardless of role, permission or enablement.
   * Read-only metadata for capability reporting: it answers "does ZAC have
   * this capability at all?", which is a different question from "may this
   * actor use it?" — conflating the two is what let a planning miss be
   * reported as a data outage.
   */
  allTools(): readonly ZacReadOnlyTool[] {
    return this.tools;
  }

  /**
   * The tool set visible to this actor — filtered by role AND per-tool permission
   * BEFORE any model ever sees a tool list. `zac.access` alone yields nothing here.
   */
  buildFor(actor: Pick<AuthUser, 'roles' | 'permissions'>): ZacReadOnlyTool[] {
    return this.tools.filter((tool) => this.actorMayUse(actor, tool));
  }

  /**
   * Tools the actor's ROLE would allow but their EFFECTIVE permissions do not —
   * the honest "your role could, your current security level does not" set for
   * permission explainability. Descriptive only: nothing here is dispatchable,
   * and dispatch re-checks permissions regardless.
   */
  permissionGapsFor(actor: Pick<AuthUser, 'roles' | 'permissions'>): ZacReadOnlyTool[] {
    return this.tools.filter(
      (tool) => userHasAnyRole(actor, tool.allowedRoles) && !this.actorMayUse(actor, tool),
    );
  }

  /**
   * Tool-level permission re-check pattern: every dispatch re-asserts `zac.access`
   * plus the tool's own role/permission requirements against the guard-verified
   * actor — regardless of what the registry showed earlier or what any model asked
   * for. Fail-closed and non-throwing: a denied, disabled or failing tool becomes a
   * safe result ZAC can explain, never an exception or a data leak.
   */
  async dispatch(
    actor: AuthUser,
    context: ZacActingContext,
    toolName: ZacToolName,
    input: Record<string, unknown>,
  ): Promise<{ result: ZacToolResult; trace: ZacToolDispatchTrace }> {
    const startedAt = Date.now();
    const tool = this.tools.find((candidate) => candidate.name === toolName);

    const finish = (result: ZacToolResult): { result: ZacToolResult; trace: ZacToolDispatchTrace } => ({
      result,
      trace: {
        tool: toolName,
        status: result.status,
        latency_ms: Date.now() - startedAt,
        row_count: result.rowCount,
      },
    });
    const deny = (
      status: 'permission_denied' | 'unavailable' | 'not_connected',
      explanation: string,
    ) => finish({ status, data: null, explanation, rowCount: null });

    if (!tool) {
      return deny('unavailable', 'That capability is not available.');
    }
    if (!userHasPermission(actor, 'zac.access')) {
      return deny('permission_denied', 'ZAC access is not enabled for this account.');
    }
    if (!this.actorMayUse(actor, tool)) {
      return deny('permission_denied', 'That data is not available to your role.');
    }
    if (tool.requiresStaffSelf && !context.staffProfileId) {
      return deny('permission_denied', 'This is only available to the stylist the data belongs to.');
    }
    if (!tool.enabled) {
      return deny(
        'not_connected',
        tool.notConnectedExplanation ?? 'This capability is not connected to live data yet.',
      );
    }

    try {
      return finish(await tool.execute(actor, context, input));
    } catch (error) {
      // Message only — never tool arguments, results or user content.
      this.logger.error(`zac tool ${toolName} failed: ${(error as Error).message}`);
      return finish({
        status: 'error',
        data: null,
        explanation: 'That data is temporarily unavailable.',
        rowCount: null,
      });
    }
  }

  private actorMayUse(
    actor: Pick<AuthUser, 'roles' | 'permissions'>,
    tool: ZacReadOnlyTool,
  ): boolean {
    if (!userHasAnyRole(actor, tool.allowedRoles)) return false;
    if (!userHasAllPermissions(actor, tool.requiredPermissions)) return false;
    if (tool.anyOfPermissions.length > 0 && !userHasAnyPermission(actor, tool.anyOfPermissions)) {
      return false;
    }
    return true;
  }
}
