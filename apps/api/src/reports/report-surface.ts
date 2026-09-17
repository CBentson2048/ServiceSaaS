import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ReportSurface } from '@sheer/domain';

/** Injection token for this deployment's {@link ReportSurface}. */
export const REPORT_SURFACE = Symbol('REPORT_SURFACE');

/**
 * The foundation preview shell is on only for the exact string `'true'`. No
 * dev-mode default and no other truthy spelling: a typo in a deployed
 * environment must leave unreleased reports hidden, not exposed.
 */
export function reportSurfaceFromEnv(value: string | undefined): ReportSurface {
  return { foundationShell: value === 'true' };
}

/** Read once when the module is created; the flag is a deployment decision. */
export const reportSurfaceProvider: Provider = {
  provide: REPORT_SURFACE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ReportSurface =>
    reportSurfaceFromEnv(config.get<string>('REPORTS_FOUNDATION_SHELL')),
};
