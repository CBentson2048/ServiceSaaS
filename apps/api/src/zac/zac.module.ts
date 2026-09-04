import { Module } from '@nestjs/common';
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
import { ZacAiProviderResolver } from './ai/zac-ai-provider.resolver';
import { ZacCompositeModelProvider } from './ai/zac-composite-model.provider';
import { ZAC_REASONING_PROVIDER, ZAC_SYNTHESIS_PROVIDER } from './ai/zac-ai-ports';
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
    // ---------------------------------------------------------------------
    // AI PROVIDER WIRING.
    //
    // One resolver decides which vendor performs which capability, from
    // ZAC_AI_PROVIDER (+ the per-capability variables under `hybrid`). It is
    // the ONLY place a vendor adapter is constructed, so no other file needs to
    // know which provider is running — which is what makes a like-for-like
    // benchmark possible and keeps `if (provider === 'openai')` out of ZAC.
    //
    // It throws at boot on an unsupported profile. A silent fallback would let
    // a typo quietly measure the other vendor and report it as this one.
    // ---------------------------------------------------------------------
    {
      provide: ZacAiProviderResolver,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ZacAiProviderResolver =>
        new ZacAiProviderResolver(config),
    },
    {
      provide: ZAC_MODEL_PROVIDER,
      inject: [ZacAiProviderResolver],
      // The shape ZAC orchestration has always injected, now composed from the
      // resolved capability ports rather than welded to one vendor.
      useFactory: (resolver: ZacAiProviderResolver): ZacModelProvider =>
        new ZacCompositeModelProvider(resolver),
    },
    {
      provide: ZAC_SEMANTIC_PROVIDER,
      inject: [ConfigService, ZacAiProviderResolver],
      // The DEDICATED semantic router. Still gated on the routing mode exactly
      // as before: `legacy` deployments get null and keep their pre-migration
      // behaviour, so this refactor does not switch anyone's router on.
      useFactory: (
        config: ConfigService,
        resolver: ZacAiProviderResolver,
      ): ZacSemanticProvider | null => {
        const routingMode = parseZacRoutingMode(config.get<string>('ZAC_ROUTING_MODE'));
        if (routingMode === 'legacy') return null;
        return resolver.semantic();
      },
    },
    {
      provide: ZAC_REASONING_PROVIDER,
      inject: [ZacAiProviderResolver],
      useFactory: (resolver: ZacAiProviderResolver) => resolver.reasoning(),
    },
    {
      provide: ZAC_SYNTHESIS_PROVIDER,
      inject: [ZacAiProviderResolver],
      useFactory: (resolver: ZacAiProviderResolver) => resolver.synthesis(),
    },
    ZacService,
  ],
  // Exported so a later workstream can consume persisted signals without
  // reaching into ZAC internals. Nothing outside ZacModule injects it today.
  exports: [ZacIntelligenceSignalService],
})
export class ZacModule {}
