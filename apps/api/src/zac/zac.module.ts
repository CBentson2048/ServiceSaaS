import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
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
 * ZAC Phase 1 backend foundation (Week 1). Deliberately isolated: no business
 * modules are imported yet. Week 2 wires tools to the guarded QLOOQO services
 * (Kpi/Dashboard/…) with the resolved actor — ZAC never opens its own
 * reasoning-readable DB client for business data.
 */
@Module({
  imports: [AuthModule],
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
