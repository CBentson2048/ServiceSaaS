import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { KpiModule } from '../kpi/kpi.module';
import { LabAppointmentsModule } from '../lab-appointments/lab-appointments.module';
import { ZacContextService } from './context/zac-context.service';
import { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import { StubZacModelProvider } from './models/providers/stub-zac-provider';
import { ZAC_MODEL_PROVIDER } from './models/zac-model-provider.interface';
import { ZacResponseBuilderService } from './responses/zac-response-builder.service';
import { ZacRoleProfileService } from './roles/zac-role-profile.service';
import { ZacToolRegistryService } from './tools/zac-tool-registry.service';
import { ZacController } from './zac.controller';
import { ZacFeatureGuard } from './zac-feature.guard';
import { ZacRolloutService } from './zac-rollout.service';
import { ZacService } from './zac.service';

/**
 * ZAC Phase 1 backend (Week 2). Tools reach business data ONLY through
 * existing guarded QLOOQO services (DashboardModule here), called with the
 * resolved actor — ZAC never opens its own reasoning-readable DB client for
 * business data.
 */
@Module({
  imports: [AuthModule, DashboardModule, KpiModule, LabAppointmentsModule],
  controllers: [ZacController],
  providers: [
    ZacFeatureGuard,
    ZacRolloutService,
    ZacContextService,
    ZacRoleProfileService,
    ZacToolRegistryService,
    ZacResponseBuilderService,
    ZacCostTelemetryService,
    { provide: ZAC_MODEL_PROVIDER, useClass: StubZacModelProvider },
    ZacService,
  ],
})
export class ZacModule {}
