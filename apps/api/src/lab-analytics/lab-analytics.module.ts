import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { LabAnalyticsController, LabSessionAnalyticsController } from './lab-analytics.controller';
import { LabAnalyticsService } from './lab-analytics.service';

@Module({
  imports: [AuthModule, LabSessionModule],
  controllers: [LabAnalyticsController, LabSessionAnalyticsController],
  providers: [LabAnalyticsService],
  // Exported for ZacModule (Phase 2 Workstream 3), which reads colour cost,
  // margin and product usage through `summary` with the resolved actor. Without
  // this export Nest cannot construct ZacToolRegistryService and the API fails
  // to boot.
  //
  // NOTE for anyone widening ZAC's use of this service: `summary` re-checks the
  // ROLE and the location scope, but NOT `report.lab_analytics.view`. On the
  // ZAC path that key is enforced solely by the tool's own `requiredPermissions`
  // declaration, so it must never be weakened. The payload also carries staff
  // pay data on `byStylist` (hourlyRate, contractedHours, averageBillBenchmark)
  // under that same reporting key with no payroll permission anywhere in the
  // path — ZAC's read-only port projects it away and never reads it.
  exports: [LabAnalyticsService],
})
export class LabAnalyticsModule {}
