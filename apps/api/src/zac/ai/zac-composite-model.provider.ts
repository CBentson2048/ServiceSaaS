import type { ZacAiProviderResolver } from './zac-ai-provider.resolver';
import type {
  ZacAnalysisPlanInput,
  ZacAnalysisPlanOutcome,
  ZacModelCompletion,
  ZacModelProvider,
  ZacModelRequest,
  ZacPrioritySynthesisInput,
  ZacPrioritySynthesisOutcome,
  ZacSemanticRouterInput,
  ZacSemanticRouterOutcome,
} from '../models/zac-model-provider.interface';

/**
 * THE COMPOSITE MODEL PROVIDER.
 *
 * `ZacModelProvider` is the shape ZAC orchestration has always injected, and it
 * is a perfectly good ZAC-owned contract — no SDK type appears in it. Its only
 * flaw was that one object had to answer for every capability, which welded all
 * of them to one vendor.
 *
 * This class keeps the shape and removes the weld: each method delegates to the
 * capability port the resolver chose, so `zac.service.ts` and
 * `zac-orchestrator.service.ts` are untouched by this refactor while their
 * calls can now land on either vendor. A rewrite of those two files would have
 * put the shipped Phase 1 answer behaviour at risk for no architectural gain —
 * the seam belongs here, not in the orchestration.
 *
 * The optional methods are assigned conditionally on purpose. Callers test
 * `if (provider.planAnalysis)` and `if (!provider.synthesisePriorities)` to
 * decide whether the deterministic path applies, so a method that exists and
 * always fails would silently convert "no reasoning provider configured" into
 * "reasoning attempted and failed" — a different fact, differently reported.
 */
export class ZacCompositeModelProvider implements ZacModelProvider {
  readonly name: string;
  readonly model: string;
  readonly narrates: boolean;
  readonly semanticRouting: boolean;
  /** The model that performs semantic routing; read by the router for health. */
  readonly routerModel: string | undefined;

  classifyRequestMode?: (input: ZacSemanticRouterInput) => Promise<ZacSemanticRouterOutcome>;
  planAnalysis?: (input: ZacAnalysisPlanInput) => Promise<ZacAnalysisPlanOutcome>;
  synthesisePriorities?: (
    input: ZacPrioritySynthesisInput,
  ) => Promise<ZacPrioritySynthesisOutcome>;

  constructor(private readonly resolver: ZacAiProviderResolver) {
    const synthesis = resolver.synthesis();
    const reasoning = resolver.reasoning();
    const semantic = resolver.semantic();

    // Identity reports the SYNTHESIS binding, because that is the model whose
    // words a user reads and the one `/zac/health.provider` has always meant.
    // The other bindings are reported separately rather than folded in here.
    this.name = synthesis.providerId;
    this.model = synthesis.model;
    this.narrates = synthesis.narrates;
    this.semanticRouting = semantic !== null;
    this.routerModel = semantic?.model;

    // The LEGACY classifier — the narration vendor's own request-mode
    // classification, which is what this method has always been. It is
    // deliberately NOT the dedicated semantic port: in `legacy` and `shadow`
    // routing modes the router calls this to get the pre-migration verdict, and
    // pointing it at the dedicated provider would make shadow mode compare a
    // provider against itself and silently end the migration it exists to
    // measure.
    const legacy = resolver.legacyClassifier();
    if (legacy) {
      this.classifyRequestMode = (input) => legacy.classify(input);
    }

    if (reasoning) {
      this.planAnalysis = (input) => reasoning.planAnalysis(input);
      this.synthesisePriorities = (input) => reasoning.synthesisePriorities(input);
    }
  }

  complete(request: ZacModelRequest): Promise<ZacModelCompletion> {
    return this.resolver.synthesis().generate(request);
  }
}
