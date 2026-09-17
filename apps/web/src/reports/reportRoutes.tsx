import type { ReactElement, ReactNode } from 'react';
import { Navigate, Route } from 'react-router-dom';
import {
  REPORT_DEFINITIONS,
  isReportAvailable,
  reportAccessDecision,
  type ReportDefinition,
  type ReportSurface,
} from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import { ReportPage } from './ReportPage';
import { reportPath } from './reportNav';

/**
 * Applies the same decision as the API's ReportAccessGuard. A route for an
 * unavailable report is never declared (see {@link reportRoutes}); this gate is
 * the second line if one is reached anyway.
 */
export function ReportGate({
  definition,
  surface,
  children,
}: {
  definition: ReportDefinition;
  surface: ReportSurface;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const decision = reportAccessDecision(user, definition, surface);
  if (decision === 'unavailable') return <Navigate to="/" replace />;
  if (decision === 'forbidden') return <Navigate to="/unauthorized" replace />;
  return <>{children}</>;
}

/**
 * Route elements for the reports available in this build. Unavailable reports
 * get no route at all, so `/reports/<key>` falls through to the app's catch-all.
 * Mount inside the signed-in owner/manager layout.
 */
export function reportRoutes(
  surface: ReportSurface,
  definitions: readonly ReportDefinition[] = REPORT_DEFINITIONS,
): ReactElement[] {
  return definitions
    .filter((definition) => isReportAvailable(definition, surface))
    .map((definition) => (
      <Route
        key={definition.key}
        path={reportPath(definition)}
        element={
          <ReportGate definition={definition} surface={surface}>
            <ReportPage key={definition.key} definition={definition} />
          </ReportGate>
        }
      />
    ));
}
