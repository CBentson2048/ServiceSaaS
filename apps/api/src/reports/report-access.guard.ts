import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { getReportDefinition, reportAccessDecision, type ReportSurface } from '@sheer/domain';
import { toReportActor, type ReportRequest } from './report-actor';
import { reportHttpError } from './report-errors';
import { REPORT_SURFACE } from './report-surface';

/**
 * Runs after {@link SupabaseAuthGuard}. Applies the same decision the web route
 * gate and the sidebar use — owners, or a manager membership grant carrying the
 * report's permission — and attaches the definition for the handler.
 *
 * Carries no `@RequireRoles` / `@RequirePermissions` metadata and reads none:
 * those guards fail open when metadata is missing and handler metadata replaces
 * class metadata, which is exactly how a route silently loses its gate.
 */
@Injectable()
export class ReportAccessGuard implements CanActivate {
  constructor(@Inject(REPORT_SURFACE) private readonly surface: ReportSurface) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ReportRequest>();
    const key = request.params?.reportKey;
    const definition = typeof key === 'string' ? getReportDefinition(key) : undefined;
    if (!definition) {
      throw reportHttpError('report_not_found');
    }

    const actor = request.auth ? toReportActor(request.auth) : null;
    const decision = reportAccessDecision(actor, definition, this.surface);
    if (decision === 'unavailable') {
      throw reportHttpError('report_not_found');
    }
    if (decision === 'forbidden') {
      throw reportHttpError('report_forbidden');
    }

    request.reportDefinition = definition;
    return true;
  }
}
