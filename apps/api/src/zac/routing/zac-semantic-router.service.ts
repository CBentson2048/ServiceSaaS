import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZacRoleContext } from '../context/zac-context.types';
import {
  ZAC_MODEL_PROVIDER,
  type ZacModelCompletion,
  type ZacModelProvider,
  type ZacSemanticRouterOutcome,
} from '../models/zac-model-provider.interface';
import {
  ZAC_SEMANTIC_PROVIDER,
  type ZacSemanticProvider,
} from '../models/zac-semantic-provider.interface';
import {
  ZacSemanticHealthService,
  type ZacSemanticFailureKind,
} from '../models/zac-semantic-health.service';
import { ZacRequestModeClassifierService } from './zac-request-mode-classifier.service';
import { isZacResourceCategory } from '../policy/zac-policy.types';
import {
  ZAC_ROUTER_VERSION,
  ZAC_ROUTER_VERSION_LEGACY,
  ZAC_SEMANTIC_PROMPT_VERSION,
} from './zac-semantic-router.prompt';
import {
  ZAC_MODE_INFORMATION_SOURCE,
  confidenceBucketScore,
  isZacConfidenceBucket,
  isZacInformationSource,
  isZacRequestMode,
  isZacRouterAnalysisIntent,
  isZacRoutingReasonCode,
  parseZacRoutingMode,
  type ZacClassifierFailure,
  type ZacDeterministicVerdict,
  type ZacRequestClassification,
  type ZacRequestMode,
  type ZacRouterAnalysisIntent,
  type ZacRoutingMode,
  type ZacSemanticClassification,
} from './zac-request-mode.types';

/**
 * Confidence policy. These are the thresholds the evaluation suite is run
 * against; see docs/ZAC/phase-1-semantic-router.md for the measured basis.
 *
 *  >= ACCEPT   route on the semantic verdict directly.
 *  >= REVIEW   route on it UNLESS accepting it would newly send the turn to
 *              the live-data pipeline against a heuristic that disagrees —
 *              a wrong live-data read is the expensive direction.
 *  <  REVIEW   the semantic layer did not decide; Layer 3 takes over.
 */
export const ZAC_SEMANTIC_ACCEPT_CONFIDENCE = 0.7;
export const ZAC_SEMANTIC_REVIEW_CONFIDENCE = 0.45;
/**
 * The bar for OVERTURNING the deterministic shape rules on whether a turn
 * needs live business data. Higher than the plain accept threshold because
 * those rules encode pinned product behaviour — the stylist restricted router,
 * the honest staff-not-connected answer, "how am I performing?" — and a
 * merely-confident model should not be able to route around them. Genuine
 * paraphrases are classified far above this; borderline calls are not.
 */
export const ZAC_SEMANTIC_OVERRIDE_CONFIDENCE = 0.85;

/**
 * Failures of an ATTEMPTED classification call, as opposed to "this deployment
 * has no classifier". The distinction matters: a call that timed out or was
 * refused is partly user-inducible, so it must not fall open into the data
 * pipeline, whereas a build with no provider should keep its pre-semantic
 * behaviour.
 */
const CALL_FAILURES: ReadonlySet<ZacClassifierFailure> = new Set([
  'classification_timeout',
  'classification_refused',
  'classification_invalid',
  'classification_low_confidence',
]);

/** The one question ZAC asks back when two layers genuinely disagree. */
export const ZAC_ROUTING_CLARIFICATION =
  'Just so I answer the right way — would you like a general answer, or shall I look at your current QLOOQO figures?';

export interface ZacRouteInput {
  question: string;
  roleContext: ZacRoleContext;
  /**
   * Structural summaries of recent turns (oldest first). No transcript text.
   * Their presence IS the "there was a prior turn" signal — a follow-up is
   * resolvable only when there is something to follow up on.
   */
  recentTurnSummaries?: string[];
}

export interface ZacRouteResult {
  classification: ZacRequestClassification;
  /** Usage of the semantic call, when one was made and billed. */
  completion: ZacModelCompletion | null;
  /** Wall time of the semantic call, when one was made. */
  classifierLatencyMs: number | null;
  /** True when a semantic call was attempted this turn (for cost observability). */
  classifierInvoked: boolean;
  /**
   * The shadow classification, when routing mode is `shadow` and a dedicated
   * semantic provider is configured. Settles AFTER the route has been decided
   * — observation only, never awaited on the user's critical path, and the
   * promise never rejects. Null in every other mode.
   */
  shadow: Promise<ZacShadowObservation> | null;
}

/**
 * One shadow classification, for the disagreement telemetry the cutover plan
 * depends on. Contains no question text — only the validated verdict shape,
 * the typed failure and the billed usage.
 */
export interface ZacShadowObservation {
  provider: string;
  model: string;
  /** The VALIDATED shadow verdict; null when nothing usable came back. */
  semantic: ZacSemanticClassification | null;
  failure: ZacClassifierFailure | null;
  failureKind?: ZacSemanticFailureKind;
  completion: ZacModelCompletion | null;
  latencyMs: number;
}

/**
 * The hybrid request router.
 *
 *   Layer 1  deterministic, explicit intent  → short-circuits, no model call
 *   Layer 2  semantic intent classification  → reasons about MEANING
 *   Layer 3  safe fallback ladder            → never blanket-forces live data
 *
 * The router answers "what kind of request is this?". It does NOT answer "what
 * is this user authorised to access?" — nothing here reads or returns actor
 * identity, business scope, location scope, permissions or tool names, and the
 * mode it returns cannot widen access: every tool dispatch downstream
 * re-checks role + permissions independently.
 */
@Injectable()
export class ZacSemanticRouterService {
  private readonly enabled: boolean;
  /** Which pipeline is authoritative for meaning. See {@link ZacRoutingMode}. */
  readonly routingMode: ZacRoutingMode;

  constructor(
    private readonly deterministic: ZacRequestModeClassifierService,
    @Inject(ZAC_MODEL_PROVIDER) private readonly modelProvider: ZacModelProvider,
    config: ConfigService,
    private readonly semanticHealth: ZacSemanticHealthService = new ZacSemanticHealthService(),
    @Optional()
    @Inject(ZAC_SEMANTIC_PROVIDER)
    private readonly semanticProvider: ZacSemanticProvider | null = null,
  ) {
    // Default ON: the semantic layer is Phase 1 behaviour, and a provider that
    // cannot classify already degrades safely on its own. The flag exists to
    // force the pre-semantic path in an incident, matching how ZAC_ENABLED is
    // read elsewhere.
    this.enabled = readBooleanFlag(config.get<string>('ZAC_SEMANTIC_ROUTER_ENABLED'), true);
    this.routingMode = parseZacRoutingMode(config.get<string>('ZAC_ROUTING_MODE'));
  }

  /**
   * True when a semantic layer is CONFIGURED for this deployment — the flag is
   * on and the authoritative pipeline for this routing mode has a classifier.
   * This says nothing about whether a call has ever succeeded; see
   * {@link ZacSemanticHealthService.operational} for that, and never use this
   * alone to claim readiness.
   */
  get semanticRoutingAvailable(): boolean {
    if (!this.enabled) return false;
    if (this.routingMode === 'semantic') return this.semanticProvider !== null;
    return this.modelProvider.semanticRouting === true;
  }

  /** The recorded runtime state of the semantic layer. */
  get health(): ZacSemanticHealthService {
    return this.semanticHealth;
  }

  /** The model performing AUTHORITATIVE semantic routing. Null when none. */
  get routerModel(): string | null {
    if (!this.semanticRoutingAvailable) return null;
    if (this.routingMode === 'semantic') return this.semanticProvider?.model ?? null;
    const provider = this.modelProvider as ZacModelProvider & { routerModel?: string };
    return provider.routerModel ?? this.modelProvider.model;
  }

  /** The dedicated semantic provider's identity (any mode), for /zac/health. */
  get semanticProviderInfo(): { name: string; model: string } | null {
    return this.semanticProvider
      ? { name: this.semanticProvider.name, model: this.semanticProvider.model }
      : null;
  }

  /** The router contract version the AUTHORITATIVE pipeline runs. */
  get routerVersion(): string {
    return this.routingMode === 'semantic' ? ZAC_ROUTER_VERSION : ZAC_ROUTER_VERSION_LEGACY;
  }

  /** The versioned v2 prompt, when the v2 pipeline is authoritative. */
  get promptVersion(): string | null {
    return this.routingMode === 'semantic' ? ZAC_SEMANTIC_PROMPT_VERSION : null;
  }

  async route(input: ZacRouteInput): Promise<ZacRouteResult> {
    const { question, roleContext } = input;

    // Shadow starts FIRST so it observes every turn — including the ones
    // Layer 1 decides without a model. It can never influence the route.
    const shadow = this.beginShadow(input);

    // ---- Layer 1: explicit, unambiguous intent. No model call. --------------
    const explicit = this.deterministic.classifyExplicit(question, roleContext);
    if (explicit) {
      return {
        classification: this.finalize({
          mode: explicit.mode,
          source: 'deterministic',
          dataInstruction: explicit.dataInstruction,
          reasonCode: explicit.reasonCode,
          confidence: null,
          classifierFailure: null,
          requiresLiveBusinessData: null,
          // Layer 1 rules classify the MODE only; the deterministic resource
          // classifier runs in the orchestrator alongside policy.
          resourceCategory: null,
        }),
        completion: null,
        classifierLatencyMs: null,
        classifierInvoked: false,
        shadow,
      };
    }

    // Recomputed as DEFENCE IN DEPTH. Today Layer 1 decides every turn that
    // carries an explicit data instruction, so this is expected to be null
    // here — but the veto below and the fallback ladder both honour it, so a
    // future Layer 1 change cannot silently let an exclusion through.
    const dataInstruction = this.deterministic.detectDataInstruction(question);
    // Whether the conversation already contains a DATA turn. Derived here, on
    // the server, from the structural summaries — which are name-free by
    // contract (D32) and never leave the process. The summaries are redacted
    // separately on the way to the model; this read is the same one
    // `priorFixedBoundary` already performs.
    const priorDataTurn = (input.recentTurnSummaries ?? []).some((summary) =>
      / via report\./.test(summary),
    );
    const heuristicVerdict = this.deterministic.classifyHeuristic(question, roleContext, {
      priorDataTurn,
    });

    // ---- Layer 2: semantic intent classification. ---------------------------
    // Which classifier is Layer 2 depends on the routing mode: in `semantic`
    // the dedicated provider (OpenAI) is authoritative; in `legacy` and
    // `shadow` the model provider's own classifier is, exactly as before.
    let semantic: ZacSemanticClassification | null = null;
    let failure: ZacClassifierFailure | null = null;
    let completion: ZacModelCompletion | null = null;
    let latencyMs: number | null = null;
    let invoked = false;

    const layer2 = this.selectLayer2();
    if (!this.enabled) {
      failure = 'router_disabled';
    } else if (!layer2) {
      failure = 'provider_unavailable';
    } else {
      invoked = true;
      const startedAt = Date.now();
      const outcome = await layer2({
        question,
        roleContext,
        recentTurnSummaries: input.recentTurnSummaries,
      })
        // A provider is contracted not to throw; belt-and-braces so a routing
        // bug can never take down the user's turn.
        .catch(() => ({
          raw: null,
          failure: 'provider_unavailable' as ZacClassifierFailure,
          completion: null,
          failureKind: 'transport' as const,
        }));
      latencyMs = Date.now() - startedAt;
      completion = outcome.completion;
      semantic = this.validate(outcome.raw);
      failure = semantic ? null : (outcome.failure ?? 'classification_invalid');
      // Readiness is evidence, not configuration: record what actually
      // happened so /zac/health can stop guessing from flags.
      if (semantic) {
        this.semanticHealth.recordSuccess('router');
      } else {
        this.semanticHealth.recordFailure(
          'router',
          outcome.failureKind ?? (outcome.raw ? 'invalid_output' : 'transport'),
        );
      }
    }

    if (semantic) {
      const decision = this.applyConfidencePolicy(
        question,
        semantic,
        heuristicVerdict,
        dataInstruction,
        (input.recentTurnSummaries ?? []).length > 0,
      );
      if (decision) {
        return {
          classification: this.finalize(decision),
          completion,
          classifierLatencyMs: latencyMs,
          classifierInvoked: invoked,
          shadow,
        };
      }
      failure = 'classification_low_confidence';
    }

    // ---- Layer 3: safe fallback ladder. -------------------------------------
    return {
      classification: this.finalize(
        this.fallback({
          question,
          dataInstruction,
          heuristicVerdict,
          failure: failure ?? 'classification_invalid',
          semantic,
        }),
      ),
      completion,
      classifierLatencyMs: latencyMs,
      classifierInvoked: invoked,
      shadow,
    };
  }

  /** The authoritative Layer 2 classifier for the configured routing mode. */
  private selectLayer2():
    | ((input: {
        question: string;
        roleContext: ZacRoleContext;
        recentTurnSummaries?: string[];
      }) => Promise<ZacSemanticRouterOutcome>)
    | null {
    if (this.routingMode === 'semantic') {
      const provider = this.semanticProvider;
      return provider ? (input) => provider.classify(input) : null;
    }
    const modelProvider = this.modelProvider;
    if (!modelProvider.classifyRequestMode || !modelProvider.semanticRouting) return null;
    return (input) => modelProvider.classifyRequestMode!(input);
  }

  /**
   * Fire the shadow classification. Never awaited on the turn, never rejects,
   * and records its health under `shadow_router` so shadow failures cannot
   * degrade the authoritative pipeline's readiness.
   */
  private beginShadow(input: ZacRouteInput): Promise<ZacShadowObservation> | null {
    if (this.routingMode !== 'shadow' || !this.enabled || !this.semanticProvider) return null;
    const provider = this.semanticProvider;
    const startedAt = Date.now();
    return provider
      .classify({
        question: input.question,
        roleContext: input.roleContext,
        recentTurnSummaries: input.recentTurnSummaries,
      })
      .catch(() => ({
        raw: null,
        failure: 'provider_unavailable' as ZacClassifierFailure,
        completion: null,
        failureKind: 'transport' as const,
      }))
      .then((outcome) => {
        const semantic = this.validate(outcome.raw);
        if (semantic) {
          this.semanticHealth.recordSuccess('shadow_router');
        } else {
          this.semanticHealth.recordFailure(
            'shadow_router',
            outcome.failureKind ?? (outcome.raw ? 'invalid_output' : 'transport'),
          );
        }
        return {
          provider: provider.name,
          model: outcome.completion?.model ?? provider.model,
          semantic,
          failure: semantic ? null : (outcome.failure ?? 'classification_invalid'),
          failureKind: outcome.failureKind,
          completion: outcome.completion,
          latencyMs: Date.now() - startedAt,
        };
      });
  }

  /**
   * The last line of the §11 invariants, applied to EVERY classification that
   * leaves the router whatever path produced it: a non-qlooqo_data turn never
   * carries an analysis intent.
   */
  private finalize(classification: ZacRequestClassification): ZacRequestClassification {
    return {
      ...classification,
      analysisIntent:
        classification.mode === 'qlooqo_data' ? (classification.analysisIntent ?? 'none') : 'none',
    };
  }

  /**
   * Validate untrusted model output against the closed enums. Anything that
   * is not exactly right is discarded — a malformed field never degrades into
   * a partial decision.
   */
  private validate(raw: unknown): ZacSemanticClassification | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Record<string, unknown>;

    if (!isZacRequestMode(candidate.mode)) return null;
    if (!isZacRoutingReasonCode(candidate.reason_code)) return null;

    // Confidence arrives as a 0..1 number from the legacy (v1) contract or as
    // a closed bucket from the v2 contract. Buckets project onto the SAME
    // measured numeric policy, so one confidence policy governs both.
    const rawConfidence = candidate.confidence;
    let confidenceBucket: ZacSemanticClassification['confidenceBucket'] = null;
    let confidence: number;
    if (isZacConfidenceBucket(rawConfidence)) {
      confidenceBucket = rawConfidence;
      confidence = confidenceBucketScore(rawConfidence);
    } else if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
      confidence = rawConfidence;
    } else {
      return null;
    }

    const requiresLive = candidate.requires_live_business_data;
    if (typeof requiresLive !== 'boolean') return null;

    // v2 fields. Their PRESENCE marks a v2 verdict; a legacy verdict that never
    // carried them is not penalised for their absence. A v2 verdict whose
    // values fall outside the closed enums is discarded whole — the strict
    // schema makes that unreachable from a live call, so reaching it means the
    // pipe itself is untrustworthy.
    const isV2 = candidate.analysis_intent !== undefined || candidate.information_source !== undefined;
    let analysisIntent: ZacRouterAnalysisIntent = 'none';
    let informationSource: ZacSemanticClassification['informationSource'] = null;
    let semanticallyCoherent = true;
    if (isV2) {
      if (!isZacRouterAnalysisIntent(candidate.analysis_intent)) return null;
      if (!isZacInformationSource(candidate.information_source)) return null;
      informationSource = candidate.information_source;

      // §11 invariants. Violations are not discarded — the MODE may still be
      // right — but they void self-consistency, which caps confidence below
      // the accept threshold: an incoherent verdict cannot reach tool
      // execution on its own say-so.
      const mode = candidate.mode as ZacRequestMode;
      if (mode === 'qlooqo_data') {
        analysisIntent = candidate.analysis_intent;
        if (analysisIntent === 'none') semanticallyCoherent = false;
      } else {
        // Hard invariant: a non-data turn NEVER carries an intent, whatever
        // the model said. The claim is still scored for coherence.
        analysisIntent = 'none';
        if (candidate.analysis_intent !== 'none') semanticallyCoherent = false;
      }
      if (informationSource !== ZAC_MODE_INFORMATION_SOURCE[mode]) {
        semanticallyCoherent = false;
      }
    }

    // A verdict that contradicts itself — "this is general advice, and it needs
    // live business data", or "this is a data question that needs none" — is
    // not a reliable verdict. It is not discarded (the mode may still be
    // right), but its confidence is capped below the accept threshold so the
    // corroboration rules and the fallback ladder get a say.
    const selfConsistent =
      requiresLive === (candidate.mode === 'qlooqo_data') && semanticallyCoherent;
    const clamped = Math.min(1, Math.max(0, confidence));

    // The category is ADVISORY input to policy, not part of the verdict's
    // validity: an unrecognised value is dropped to null rather than voiding an
    // otherwise good classification, because the deterministic category
    // classifier and the fixed-boundary guards still run regardless.
    const resourceCategory = isZacResourceCategory(candidate.resource_category)
      ? candidate.resource_category
      : null;

    return {
      mode: candidate.mode,
      resourceCategory,
      confidence: selfConsistent
        ? clamped
        : Math.min(clamped, ZAC_SEMANTIC_ACCEPT_CONFIDENCE - 0.01),
      requiresLiveBusinessData: requiresLive,
      reasonCode: candidate.reason_code,
      selfConsistent,
      analysisIntent,
      informationSource,
      confidenceBucket,
    };
  }

  /**
   * Decide whether the semantic verdict is trusted for this turn. Returns null
   * when it is not, which hands the turn to Layer 3.
   */
  private applyConfidencePolicy(
    question: string,
    semantic: ZacSemanticClassification,
    heuristicVerdict: ZacDeterministicVerdict | null,
    dataInstruction: ZacRequestClassification['dataInstruction'],
    hadPriorTurn: boolean,
  ): ZacRequestClassification | null {
    // The hard veto outranks the model. If the user excluded their data this
    // turn, a qlooqo_data verdict is rewritten, never honoured.
    if (dataInstruction === 'ignore_data' && semantic.mode === 'qlooqo_data') {
      return {
        mode: this.deterministic.suppliesScenario(question.toLowerCase())
          ? 'hypothetical'
          : 'general_advice',
        source: 'deterministic',
        dataInstruction,
        reasonCode: 'explicit_ignore_live_data',
        confidence: semantic.confidence,
        classifierFailure: null,
        requiresLiveBusinessData: semantic.requiresLiveBusinessData,
        resourceCategory: semantic.resourceCategory,
        // The vetoed turn is advisory: no intent hint survives the rewrite.
        analysisIntent: 'none',
        informationSource: semantic.informationSource,
      };
    }

    const accepted = (source: ZacRequestClassification['source']): ZacRequestClassification => ({
      mode: semantic.mode,
      source,
      dataInstruction,
      reasonCode: semantic.reasonCode,
      confidence: semantic.confidence,
      classifierFailure: null,
      requiresLiveBusinessData: semantic.requiresLiveBusinessData,
      resourceCategory: semantic.resourceCategory,
      analysisIntent: semantic.analysisIntent,
      informationSource: semantic.informationSource,
    });

    // A follow-up resolved from prior-turn context is recorded as such: it is
    // a different decision basis from "the sentence said so". It requires an
    // actual prior turn — without one there was no context to resolve from,
    // whatever the model called it.
    const source: ZacRequestClassification['source'] =
      hadPriorTurn && semantic.reasonCode === 'conversation_followup'
        ? 'contextual_followup'
        : 'semantic_model';

    // Whether this verdict would overturn the shape rules on the data
    // question. Disagreement about WHICH advisory mode (general vs
    // hypothetical) is not a conflict — neither reads data.
    const wantsLiveDataNow = semantic.mode === 'qlooqo_data';
    const shapeWantsLiveDataNow = heuristicVerdict?.mode === 'qlooqo_data';
    const overturnsShapeRule =
      heuristicVerdict !== null && wantsLiveDataNow !== shapeWantsLiveDataNow;

    if (semantic.confidence >= ZAC_SEMANTIC_ACCEPT_CONFIDENCE) {
      if (!overturnsShapeRule || semantic.confidence >= ZAC_SEMANTIC_OVERRIDE_CONFIDENCE) {
        return accepted(source);
      }
      return null;
    }

    if (semantic.confidence >= ZAC_SEMANTIC_REVIEW_CONFIDENCE) {
      // Medium confidence needs corroboration whenever it would CHANGE the
      // data/no-data decision the deterministic rules arrived at — in either
      // direction. Both errors are real product failures:
      //
      //   advisory  → live data  : the acceptance-test failure (ZAC ignores
      //                            "forget my figures" and reads the business)
      //   live data → advisory   : ZAC refuses to look at the owner's own
      //                            numbers when they plainly asked
      //
      // Disagreement about WHICH advisory mode (general vs hypothetical) is
      // harmless — neither reads data — so it is not treated as a conflict.
      // With no shape opinion at all, a medium-confidence live-data reading is
      // still uncorroborated — and that is the direction that must not be
      // taken on a guess.
      const uncorroboratedLiveData = wantsLiveDataNow && heuristicVerdict === null;
      if (!overturnsShapeRule && !uncorroboratedLiveData) return accepted(source);
    }

    return null;
  }

  /**
   * The documented safe fallback. Ordered so that the two directions the
   * product cares about are protected first: an explicit exclusion can never
   * reach live data, and a supplied scenario stays hypothetical.
   */
  private fallback(input: {
    question: string;
    dataInstruction: ZacRequestClassification['dataInstruction'];
    heuristicVerdict: ZacDeterministicVerdict | null;
    failure: ZacClassifierFailure;
    semantic: ZacSemanticClassification | null;
  }): ZacRequestClassification {
    const { question, dataInstruction, heuristicVerdict, failure, semantic } = input;
    const normalised = question.toLowerCase();

    const base = {
      source: 'fallback' as const,
      dataInstruction,
      confidence: semantic?.confidence ?? null,
      classifierFailure: failure,
      requiresLiveBusinessData: semantic?.requiresLiveBusinessData ?? null,
      // Preserved even for an UNTRUSTED verdict: the category is not an access
      // decision, and policy re-derives fixed boundaries deterministically, so
      // carrying it forward can only make a refusal more specific.
      resourceCategory: semantic?.resourceCategory ?? null,
      // The intent HINT survives the same way: it widens no access (the
      // planner and registry re-validate everything) and finalize() strips it
      // from any non-data mode this fallback lands on.
      analysisIntent: semantic?.analysisIntent ?? ('none' as const),
      informationSource: semantic?.informationSource ?? null,
    };

    // 1. An explicit "do not use my data" NEVER falls back to qlooqo_data.
    if (dataInstruction === 'ignore_data') {
      return {
        ...base,
        mode: this.deterministic.suppliesScenario(normalised) ? 'hypothetical' : 'general_advice',
        reasonCode: 'explicit_ignore_live_data',
      };
    }

    // 2. A supplied scenario falls back to hypothetical.
    if (this.deterministic.suppliesScenario(normalised)) {
      return { ...base, mode: 'hypothetical', reasonCode: 'hypothetical_scenario' };
    }

    // 3. An explicit request for their real figures falls back to live data.
    if (dataInstruction === 'use_data') {
      return { ...base, mode: 'qlooqo_data', reasonCode: 'explicit_live_data_request' };
    }

    // 4. The shape rules and an untrusted verdict DISAGREE about the data
    //    question. Neither side wins on principle: the shape rules are evidence
    //    from the sentence itself, but they are also what misroutes 43% of
    //    no-data questions on unseen phrasing; and the verdict reached this
    //    point precisely because it could not be relied on. Guessing either way
    //    is a coin toss on the one decision that matters, so this is the case
    //    the brief reserves a clarifying question for.
    if (
      heuristicVerdict &&
      semantic &&
      (heuristicVerdict.mode === 'qlooqo_data') !== semantic.requiresLiveBusinessData
    ) {
      return {
        ...base,
        source: 'clarification',
        mode: 'conversational',
        reasonCode: 'ambiguous_business_request',
        clarificationPrompt: ZAC_ROUTING_CLARIFICATION,
      };
    }

    // 5. Otherwise a deterministic shape rule decides — either it agrees with
    //    the verdict, or there is no verdict at all.
    if (heuristicVerdict) {
      return { ...base, mode: heuristicVerdict.mode, reasonCode: heuristicVerdict.reasonCode };
    }

    // 6. No shape rule at all. "No live business data is needed" is a narrower
    //    claim than "the mode is X" and survives low confidence better: a
    //    classifier can be unsure whether a turn is general advice or a
    //    hypothetical while being quite sure it is neither about their real
    //    figures. With nothing to weigh it against, honour it — erring
    //    tool-free costs an advisory answer, erring live is the failure this
    //    work exists to fix.
    if (semantic && !semantic.requiresLiveBusinessData) {
      return {
        ...base,
        mode: semantic.mode === 'qlooqo_data' ? 'general_advice' : semantic.mode,
        reasonCode: semantic.reasonCode,
      };
    }

    // 7. Genuinely undetermined AND pointing at live data: no explicit
    //    instruction, no scenario, no shape rule, and an unreliable verdict
    //    that wants the data pipeline. This is the narrow case worth one
    //    question back rather than a guess in either direction.
    //
    //    A CALL that failed (timeout, refusal, malformed output) also lands
    //    here rather than defaulting into the data pipeline: classifier
    //    failure is partly user-inducible, so failing open on it would hand
    //    users a lever to force a live-data read on an advisory question.
    if (semantic || CALL_FAILURES.has(failure)) {
      return {
        ...base,
        source: 'clarification',
        mode: 'conversational',
        reasonCode: 'ambiguous_business_request',
        clarificationPrompt: ZAC_ROUTING_CLARIFICATION,
      };
    }

    // 8. No semantic layer at all — this deployment has no provider, or the
    //    router is switched off. The data pipeline is the terminal default: it
    //    is permission-filtered and its own routing already ends in the honest
    //    capability answer when no tool fits, so this preserves the
    //    pre-semantic behaviour exactly. Reached only after every exclusion and
    //    scenario check above declined it.
    return { ...base, mode: 'qlooqo_data', reasonCode: 'ambiguous_business_request' };
  }
}

/** Parse a boolean env flag the same way the rest of the API does. */
function readBooleanFlag(raw: string | undefined, fallbackValue: boolean): boolean {
  if (raw === undefined || raw === null || raw.trim() === '') return fallbackValue;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) return false;
  return fallbackValue;
}

/** Re-exported so the orchestrator can label telemetry without importing the enum twice. */
export function dataInstructionLabel(
  instruction: ZacRequestClassification['dataInstruction'],
): 'use' | 'ignore' | 'none' {
  if (instruction === 'use_data') return 'use';
  if (instruction === 'ignore_data') return 'ignore';
  return 'none';
}
