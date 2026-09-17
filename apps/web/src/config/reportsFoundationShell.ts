/**
 * Build-time read of the report foundation preview flag.
 *
 *   VITE_REPORTS_FOUNDATION_SHELL=true  — dev-test only: unreleased reports are
 *                                        navigable for G4/G5 testing
 *   unset (production)                  — only released reports appear
 *
 * Vite bakes the value into the bundle, so changing it needs a rebuild. The
 * rules live in reportsFoundationShellPolicy.ts (jest cannot compile
 * `import.meta`, so specs mock this module).
 */
import type { ReportSurface } from '@sheer/domain';
import { resolveReportsFoundationShell } from './reportsFoundationShellPolicy';

export function reportsSurface(): ReportSurface {
  const explicit = import.meta.env.VITE_REPORTS_FOUNDATION_SHELL;
  return { foundationShell: resolveReportsFoundationShell(typeof explicit === 'string' ? explicit : undefined) };
}
