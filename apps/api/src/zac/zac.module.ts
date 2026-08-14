import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { KpiModule } from '../kpi/kpi.module';
import { LabAppointmentsModule } from '../lab-appointments/lab-appointments.module';
import { ZacContextService } from './context/zac-context.service';
import { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import { AnthropicZacModelProvider } from './models/providers/anthropic-zac-provider';
import { StubZacModelProvider } from './models/providers/stub-zac-provider';
import { ZAC_MODEL_PROVIDER } from './models/zac-model-provider.interface';
import type { ZacModelProvider } from './models/zac-model-provider.interface';
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
    {
      provide: ZAC_MODEL_PROVIDER,
      inject: [ConfigService],
      // The API key is the provider switch; ZAC_ENABLED stays the dark switch.
      // No key = the deterministic stub — local dev, CI and dark builds need
      // neither a secret nor network access.
      useFactory: (config: ConfigService): ZacModelProvider => {
        if (config.get<string>('ANTHROPIC_API_KEY')) {
          return new AnthropicZacModelProvider(config);
        }
        new Logger('ZacModule').warn(
          'ANTHROPIC_API_KEY not set — ZAC answers stay deterministic (stub provider).',
        );
        return new StubZacModelProvider();
      },
    },
    ZacService,
  ],
})
export class ZacModule {}
