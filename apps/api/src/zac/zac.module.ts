import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { KpiModule } from '../kpi/kpi.module';
import { LabAppointmentsModule } from '../lab-appointments/lab-appointments.module';
import { ZacContextService } from './context/zac-context.service';
import { ZacConversationService } from './conversation/zac-conversation.service';
import { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import { ZacMeasurementService } from './measurement/zac-measurement.service';
import { ZacMemoryExtractionService } from './memory/zac-memory-extraction.service';
import { ZacMemoryService } from './memory/zac-memory.service';
import { ZacIntelligenceSignalService } from './intelligence/zac-intelligence-signal.service';
import { ZacMetricObservationService } from './intelligence/zac-metric-observation.service';
import { ZacSignalEvaluatorRegistry } from './intelligence/zac-signal-evaluator.registry';
import { ZacSignalPriorityAdapter } from './intelligence/zac-signal-priority.adapter';
import { ZacSignalReconciler } from './intelligence/zac-signal-reconciler';
import { ZacConversationStore } from './persistence/zac-conversation.store';
import { ZacIntelligenceSignalStore } from './persistence/zac-intelligence-signal.store';
import { ZacMeasurementStore } from './persistence/zac-measurement.store';
import { ZacMemoryStore } from './persistence/zac-memory.store';
import { ZacRequestModeClassifierService } from './routing/zac-request-mode-classifier.service';
import { ZacSemanticRouterService } from './routing/zac-semantic-router.service';
import { AnthropicZacModelProvider } from './models/providers/anthropic-zac-provider';
import { OpenAiSemanticProvider } from './models/providers/openai-semantic-provider';
import { StubZacModelProvider } from './models/providers/stub-zac-provider';
import { ZAC_MODEL_PROVIDER } from './models/zac-model-provider.interface';
import type { ZacModelProvider } from './models/zac-model-provider.interface';
import { ZAC_SEMANTIC_PROVIDER } from './models/zac-semantic-provider.interface';
import type { ZacSemanticProvider } from './models/zac-semantic-provider.interface';
import { parseZacRoutingMode } from './routing/zac-request-mode.types';
import { ZacAnalysisIntentService } from './analysis/zac-analysis-intent.service';
import { ZacEvidenceService } from './analysis/zac-evidence.service';
import { ZacPriorityService } from './analysis/zac-priority.service';
import { ZacOrchestratorService } from './analysis/zac-orchestrator.service';
import { ZacToolPlannerService } from './analysis/zac-tool-planner.service';
import { ZacSemanticHealthService } from './models/zac-semantic-health.service';
import { ZacPolicyService } from './policy/zac-policy.service';
import { ZacResourceCategoryService } from './policy/zac-resource-category.service';
import { ZacResponseBuilderService } from './responses/zac-response-builder.service';
import { ZacRoleProfileService } from './roles/zac-role-profile.service';
import { ZacToolRegistryService } from './tools/zac-tool-registry.service';
import { ZacController } from './zac.controller';
import { ZacFeatureGuard } from './zac-feature.guard';
import { ZacRolloutService } from './zac-rollout.service';
import { ZacService } from './zac.service';

/**
 * ZAC Phase 1 backend. Tools reach business data ONLY through existing guarded
 * QLOOQO services (DashboardModule here), called with the resolved actor —
 * ZAC never opens its own reasoning-readable DB client for business data.
 * The stores write exclusively to ZAC-OWNED tables (zac.conversations,
 * zac.messages, zac.memory_items): safe summaries and scoped memory, never
 * operational records.
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
    ZacResourceCategoryService,
    ZacPolicyService,
    ZacAnalysisIntentService,
    ZacToolPlannerService,
    ZacEvidenceService,
    ZacPriorityService,
    ZacOrchestratorService,
    ZacSemanticHealthService,
    ZacCostTelemetryService,
    ZacConversationStore,
    ZacMemoryStore,
    ZacMeasurementStore,
    // Phase 2 Workstream 1 — the intelligence/signal framework. Evaluation is
    // on demand only: no scheduler, no background scan, no proactive feed.
    ZacIntelligenceSignalStore,
    ZacMetricObservationService,
    ZacSignalEvaluatorRegistry,
    ZacSignalReconciler,
    ZacSignalPriorityAdapter,
    ZacIntelligenceSignalService,
    ZacConversationService,
    ZacMemoryExtractionService,
    ZacMemoryService,
    ZacRequestModeClassifierService,
    ZacSemanticRouterService,
    ZacMeasurementService,
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
    {
      provide: ZAC_SEMANTIC_PROVIDER,
      inject: [ConfigService],
      // The DEDICATED semantic-routing provider (OpenAI). Constructed only
      // when a non-legacy routing mode asks for it AND the key exists; null
      // otherwise, which the router treats as "no dedicated router" — shadow
      // observes nothing, semantic mode degrades through the safe fallback
      // ladder exactly like a keyless legacy build.
      useFactory: (config: ConfigService): ZacSemanticProvider | null => {
        const routingMode = parseZacRoutingMode(config.get<string>('ZAC_ROUTING_MODE'));
        if (routingMode === 'legacy') return null;
        const providerName = (config.get<string>('ZAC_SEMANTIC_PROVIDER') ?? 'openai')
          .trim()
          .toLowerCase();
        if (providerName !== 'openai') {
          new Logger('ZacModule').warn(
            `ZAC_SEMANTIC_PROVIDER='${providerName}' is not a known semantic provider — ${routingMode} routing runs without one.`,
          );
          return null;
        }
        if (!config.get<string>('OPENAI_API_KEY')) {
          new Logger('ZacModule').warn(
            `ZAC_ROUTING_MODE=${routingMode} but OPENAI_API_KEY is not set — ${routingMode} routing runs without a dedicated semantic provider.`,
          );
          return null;
        }
        return new OpenAiSemanticProvider(config);
      },
    },
    ZacService,
  ],
  // Exported so a later workstream can consume persisted signals without
  // reaching into ZAC internals. Nothing outside ZacModule injects it today.
  exports: [ZacIntelligenceSignalService],
})
export class ZacModule {}
