import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { getReportDefinition, isReportAvailable, type ReportSurface } from '@sheer/domain';
import type { ReportRequest } from './report-actor';
import { reportHttpError } from './report-errors';
import { REPORT_SURFACE } from './report-surface';

/**
 * FIRST guard on every report route, before authentication: a report that is
 * unknown, or not released and the foundation shell is off, does not exist —
 * 404 with the same body either way, so an unauthenticated caller cannot tell
 * the two apart. Deliberately knows nothing about users or permissions; that is
 * {@link ReportAccessGuard}'s job, after {@link SupabaseAuthGuard}.
 */
@Injectable()
export class ReportAvailabilityGuard implements CanActivate {
  constructor(@Inject(REPORT_SURFACE) private readonly surface: ReportSurface) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ReportRequest>();
    const key = request.params?.reportKey;
    const definition = typeof key === 'string' ? getReportDefinition(key) : undefined;
    if (!definition || !isReportAvailable(definition, this.surface)) {
      throw reportHttpError('report_not_found');
    }
    return true;
  }
}
