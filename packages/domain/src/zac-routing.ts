/**
 * ZAC semantic-routing inspector contract (UAT / developer visibility).
 *
 * The closed routing vocabulary the API stamps on every `/zac/ask` answer's
 * `technical_details`, and the ONE human-readable label set that the web
 * console, the floating assistant and the mobile ZAC screen render it with.
 *
 * Purely observational. Nothing here decides a route, and no consumer may
 * treat any of these values as an authorisation source — the backend remains
 * authoritative for routing, permissions and privacy. The inspector exists so
 * a correct-looking answer produced by the deterministic fallback is never
 * mistaken for a successful semantic classification.
 *
 * Every wire field is optional: an older API build omits the newer ones, and
 * the inspector must render safely with whatever arrived. Unknown values are
 * humanised rather than dropped, so a new server enum value still shows.
 */

export type ZacRequestMode =
  | 'qlooqo_data'
  | 'general_advice'
  | 'hypothetical'
  | 'memory'
  | 'permission_capability'
  | 'privacy_boundary'
  | 'conversational';

export const ZAC_REQUEST_MODE_LABELS: Readonly<Record<ZacRequestMode, string>> = {
  qlooqo_data: 'QLOOQO Data',
  general_advice: 'General Knowledge / Advice',
  hypothetical: 'Hypothetical',
  memory: 'Memory',
  permission_capability: 'Permission / Capability',
  privacy_boundary: 'Privacy Boundary',
  conversational: 'Conversational',
};

export type ZacAnalysisIntent =
  | 'specific_metric'
  | 'business_health'
  | 'business_priorities'
  | 'team_priorities'
  | 'diagnostic'
  | 'comparison'
  | 'explanation';

export const ZAC_ANALYSIS_INTENT_LABELS: Readonly<Record<ZacAnalysisIntent, string>> = {
  specific_metric: 'Specific Metric',
  business_health: 'Business Health',
  business_priorities: 'Business Priorities',
  team_priorities: 'Team Priorities',
  diagnostic: 'Diagnostic',
  comparison: 'Comparison',
  explanation: 'Explanation',
};

export type ZacClassificationSource =
  | 'deterministic'
  | 'semantic_model'
  | 'contextual_followup'
  | 'fallback'
  | 'clarification';

export const ZAC_CLASSIFICATION_SOURCE_LABELS: Readonly<Record<ZacClassificationSource, string>> = {
  deterministic: 'Deterministic rules',
  semantic_model: 'Semantic model',
  contextual_followup: 'Contextual follow-up',
  fallback: 'Fallback',
  clarification: 'Clarification',
};

export type ZacInformationSource =
  | 'live_qlooqo'
  | 'general_knowledge'
  | 'user_hypothesis'
  | 'zac_memory'
  | 'capability_context'
  | 'none';

export const ZAC_INFORMATION_SOURCE_LABELS: Readonly<Record<ZacInformationSource, string>> = {
  live_qlooqo: 'Live QLOOQO data',
  general_knowledge: 'General knowledge',
  user_hypothesis: 'User hypothesis',
  zac_memory: 'ZAC memory',
  capability_context: 'Capability context',
  none: 'None',
};

export type ZacRoutingMode = 'legacy' | 'shadow' | 'semantic';

export const ZAC_ROUTING_MODE_LABELS: Readonly<Record<ZacRoutingMode, string>> = {
  legacy: 'Legacy',
  shadow: 'Shadow',
  semantic: 'Semantic',
};

export type ZacConfidenceBucket = 'high' | 'medium' | 'low';

export const ZAC_CONFIDENCE_BUCKET_LABELS: Readonly<Record<ZacConfidenceBucket, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** Why the semantic layer did not decide a turn. Closed; never a provider message. */
export type ZacClassifierFailure =
  | 'classification_timeout'
  | 'classification_refused'
  | 'classification_invalid'
  | 'classification_low_confidence'
  | 'provider_unavailable'
  | 'router_disabled';

export const ZAC_FALLBACK_REASON_LABELS: Readonly<Record<ZacClassifierFailure, string>> = {
  classification_timeout: 'Provider timeout',
  classification_refused: 'Provider refused',
  classification_invalid: 'Semantic validation failure',
  classification_low_confidence: 'Low confidence',
  provider_unavailable: 'Provider unavailable',
  router_disabled: 'Router disabled',
};

/** The typed cause of a shadow-router failure. Closed; safe to display. */
export type ZacSemanticFailureKind =
  | 'auth'
  | 'credit'
  | 'schema'
  | 'rate_limit'
  | 'timeout'
  | 'refusal'
  | 'invalid_output'
  | 'transport';

export const ZAC_SEMANTIC_FAILURE_KIND_LABELS: Readonly<Record<ZacSemanticFailureKind, string>> = {
  auth: 'Authentication',
  credit: 'Credit / quota',
  schema: 'Schema rejected',
  rate_limit: 'Rate limited',
  timeout: 'Timeout',
  refusal: 'Refused',
  invalid_output: 'Invalid output',
  transport: 'Transport',
};

/** Display names for the providers that can classify a turn. */
/**
 * The deployment's AI profile, as an operator reads it. `Hybrid` is not a
 * hedge: it is the shipped design, where a dedicated router runs on one vendor
 * in front of another vendor's reasoning and narration.
 */
export const ZAC_AI_PROFILE_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  hybrid: 'Hybrid',
};

export const ZAC_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  stub: 'Stub',
};

/**
 * The shadow verdict for one turn, present only when routing mode is `shadow`
 * and the shadow classification settled before the answer was assembled.
 * Closed enums and booleans only.
 */
export interface ZacShadowRouteDetails {
  provider: string;
  model: string;
  request_mode: string | null;
  analysis_intent: string | null;
  information_source: string | null;
  confidence_bucket: string | null;
  failure: string | null;
  failure_kind: string | null;
  mode_agreement: boolean | null;
  live_data_agreement: boolean | null;
}

/**
 * The subset of `technical_details` the inspector reads. Wire names, all
 * optional. The server is the source of truth for the closed enums; the
 * client never narrows them beyond `string` so an unknown value still renders.
 */
export interface ZacRoutingDetails {
  request_mode?: string;
  classification_source?: string;
  /** The ROUTER's intent reading; absent when it made none. */
  router_analysis_intent?: string;
  /** The PLANNER's intent decision on a live-data turn. */
  analysis_intent?: string;
  information_source?: string;
  routing_mode?: string;
  router_version?: string;
  /**
   * The active AI provider profile and the vendor/model behind each capability.
   *
   * Debug/UAT metadata: an operator comparing two providers has to be able to
   * tell, from the answer in front of them, which one produced it. Safe
   * configuration identities only — never a key, never anything a model said.
   */
  ai_provider_profile?: string;
  reasoning_provider?: string | null;
  reasoning_model?: string | null;
  synthesis_provider?: string | null;
  synthesis_model?: string | null;
  prompt_version?: string | null;
  /** The provider/model that made THIS turn's classification call; null when none was made. */
  semantic_provider?: string | null;
  semantic_model?: string | null;
  semantic_confidence?: number;
  semantic_confidence_bucket?: string;
  fallback_used?: boolean;
  fallback_reason?: string | null;
  semantic_routing_available?: boolean;
  shadow_route?: ZacShadowRouteDetails | null;
}

export type ZacRoutingSourceKind =
  | 'semantic'
  | 'deterministic'
  | 'contextual'
  | 'fallback'
  | 'clarification'
  | 'unknown';

export interface ZacRoutingRow {
  key: string;
  label: string;
  /** Human-readable value. */
  value: string;
  /** The raw wire value, when it differs from `value`. UAT reads this one. */
  raw?: string;
}

export interface ZacShadowComparison {
  /** "QLOOQO Data · Business Priorities" — the route that actually served the turn. */
  production: string;
  /** The shadow router's route, or null when the shadow call failed. */
  shadow: string | null;
  agreement: boolean | null;
  providerLabel: string;
  model: string;
  failureLabel: string | null;
}

/** How a source should be toned: it is text-first, tone only reinforces it. */
export type ZacRoutingSourceTone = 'semantic' | 'neutral' | 'fallback' | 'unknown';

export interface ZacRoutingSource {
  kind: ZacRoutingSourceKind;
  /** The layer's own name ("OpenAI semantic router", "Deterministic rules (no model)"). */
  label: string;
  /**
   * THE string every surface renders after "Source:" — "OpenAI semantic
   * router", "Fallback (Provider timeout)", "Fallback (clarification)". One
   * place decides how a fallback and its reason read.
   */
  displayLabel: string;
  tone: ZacRoutingSourceTone;
}

export interface ZacRoutingDescription {
  requestMode: { value: string; label: string };
  analysisIntent: { value: string; label: string; origin: 'router' | 'planner' } | null;
  /** The compact indicator body: "QLOOQO Data" or "QLOOQO Data · Business Priorities". */
  summary: string;
  /**
   * Shown next to the summary when the intent in it is the PLANNER's decision
   * (the router made no intent reading), so a glance never over-credits the
   * router. Null when the router decided the intent or there is none.
   */
  intentNote: string | null;
  /** Which layer decided the mode, phrased for UAT. */
  source: ZacRoutingSource;
  fallback: { used: boolean; reasonLabel: string | null };
  /** Expanded rows, only for fields the API actually returned. */
  rows: ZacRoutingRow[];
  shadow: ZacShadowComparison | null;
}

/** Forward-compatible label lookup: a value the map does not know is humanised, never hidden. */
export function zacRoutingLabel(map: Readonly<Record<string, string>>, value: string): string {
  const known = map[value];
  if (known) return known;
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function zacProviderLabel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return ZAC_PROVIDER_LABELS[provider] ?? provider;
}

function hasIntent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value !== 'none';
}

function routeSummary(mode: string, intent: string | null | undefined): string {
  const modeLabel = zacRoutingLabel(ZAC_REQUEST_MODE_LABELS, mode);
  return hasIntent(intent)
    ? `${modeLabel} · ${zacRoutingLabel(ZAC_ANALYSIS_INTENT_LABELS, intent)}`
    : modeLabel;
}

/**
 * Name the model layer that classified a turn. Under `semantic` routing the
 * dedicated provider IS the router; under legacy/shadow the authoritative
 * Layer 2 is still the narration provider's classifier, and calling that
 * "the semantic router" would over-credit the migration.
 */
function semanticLayerLabel(details: ZacRoutingDetails): string {
  const provider = zacProviderLabel(details.semantic_provider);
  if (!provider) return 'Semantic router';
  return details.routing_mode && details.routing_mode !== 'semantic'
    ? `Legacy semantic classifier (${provider})`
    : `${provider} semantic router`;
}

function describeSource(
  details: ZacRoutingDetails,
): { kind: ZacRoutingSourceKind; label: string; tone: ZacRoutingSourceTone } {
  switch (details.classification_source) {
    case 'semantic_model':
      return { kind: 'semantic', label: semanticLayerLabel(details), tone: 'semantic' };
    case 'deterministic':
      return { kind: 'deterministic', label: 'Deterministic rules (no model)', tone: 'neutral' };
    case 'contextual_followup':
      // Only ever produced from an ACCEPTED semantic verdict — it is the
      // model's decision, carried by conversation context.
      return {
        kind: 'contextual',
        label: `${semanticLayerLabel(details)} (contextual follow-up)`,
        tone: 'semantic',
      };
    case 'fallback':
      return { kind: 'fallback', label: 'Fallback', tone: 'fallback' };
    case 'clarification':
      return { kind: 'clarification', label: 'Fallback (clarification)', tone: 'fallback' };
    default:
      return { kind: 'unknown', label: 'Not reported', tone: 'unknown' };
  }
}

function describeShadow(
  details: ZacRoutingDetails,
  production: string,
): ZacShadowComparison | null {
  const shadow = details.shadow_route;
  if (!shadow) return null;
  return {
    production,
    shadow: shadow.request_mode ? routeSummary(shadow.request_mode, shadow.analysis_intent) : null,
    agreement: shadow.mode_agreement,
    providerLabel: zacProviderLabel(shadow.provider) ?? shadow.provider,
    model: shadow.model,
    failureLabel: shadow.failure
      ? [
          zacRoutingLabel(ZAC_FALLBACK_REASON_LABELS, shadow.failure),
          shadow.failure_kind
            ? zacRoutingLabel(ZAC_SEMANTIC_FAILURE_KIND_LABELS, shadow.failure_kind)
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null,
  };
}

/**
 * Turn one answer's routing metadata into everything the inspector renders.
 * Returns null when the API reported no request mode — the caller shows no
 * routing label at all rather than guessing one.
 */
export function describeZacRouting(
  details: ZacRoutingDetails | null | undefined,
): ZacRoutingDescription | null {
  if (!details || typeof details.request_mode !== 'string' || !details.request_mode) return null;

  const mode = details.request_mode;
  // The router's own reading is the routing decision; the planner's decision is
  // the honest stand-in when the router made none (legacy contract, Layer 1).
  const analysisIntent = hasIntent(details.router_analysis_intent)
    ? { value: details.router_analysis_intent, origin: 'router' as const }
    : hasIntent(details.analysis_intent)
      ? { value: details.analysis_intent, origin: 'planner' as const }
      : null;

  const summary = routeSummary(mode, analysisIntent?.value);
  const layer = describeSource(details);
  // The server's `fallback_used` is authoritative; without it, the
  // classification source itself says whether the ladder decided.
  const fallbackUsed =
    typeof details.fallback_used === 'boolean'
      ? details.fallback_used
      : layer.kind === 'fallback' || layer.kind === 'clarification';
  const fallbackReason = details.fallback_reason
    ? zacRoutingLabel(ZAC_FALLBACK_REASON_LABELS, details.fallback_reason)
    : null;
  const source: ZacRoutingSource = fallbackUsed
    ? {
        kind: layer.kind,
        label: layer.label,
        tone: 'fallback',
        displayLabel: [
          layer.kind === 'clarification' ? 'Fallback (clarification)' : 'Fallback',
          fallbackReason ? `(${fallbackReason})` : null,
        ]
          .filter(Boolean)
          .join(' '),
      }
    : { ...layer, displayLabel: layer.label };

  const rows: ZacRoutingRow[] = [];
  const push = (key: string, label: string, raw: string | null | undefined, value?: string) => {
    if (raw === null || raw === undefined || raw === '') return;
    rows.push(value && value !== raw ? { key, label, value, raw } : { key, label, value: raw });
  };

  push(
    'routing_mode',
    'Routing mode',
    details.routing_mode,
    details.routing_mode ? zacRoutingLabel(ZAC_ROUTING_MODE_LABELS, details.routing_mode) : undefined,
  );
  push('request_mode', 'Request mode', mode, zacRoutingLabel(ZAC_REQUEST_MODE_LABELS, mode));
  if (hasIntent(details.router_analysis_intent)) {
    push(
      'router_analysis_intent',
      'Analysis intent (router)',
      details.router_analysis_intent,
      zacRoutingLabel(ZAC_ANALYSIS_INTENT_LABELS, details.router_analysis_intent),
    );
  }
  if (hasIntent(details.analysis_intent)) {
    push(
      'analysis_intent',
      'Analysis intent (planner)',
      details.analysis_intent,
      zacRoutingLabel(ZAC_ANALYSIS_INTENT_LABELS, details.analysis_intent),
    );
  }
  push(
    'information_source',
    'Information source',
    details.information_source,
    details.information_source
      ? zacRoutingLabel(ZAC_INFORMATION_SOURCE_LABELS, details.information_source)
      : undefined,
  );
  push(
    'classification_source',
    'Classification source',
    details.classification_source,
    details.classification_source
      ? zacRoutingLabel(ZAC_CLASSIFICATION_SOURCE_LABELS, details.classification_source)
      : undefined,
  );
  push(
    'ai_provider_profile',
    'AI profile',
    details.ai_provider_profile,
    details.ai_provider_profile
      ? zacRoutingLabel(ZAC_AI_PROFILE_LABELS, details.ai_provider_profile)
      : undefined,
  );
  push(
    'semantic_provider',
    'Semantic provider',
    details.semantic_provider,
    zacProviderLabel(details.semantic_provider) ?? undefined,
  );
  push('semantic_model', 'Semantic model', details.semantic_model);
  push(
    'reasoning_provider',
    'Reasoning provider',
    details.reasoning_provider,
    zacProviderLabel(details.reasoning_provider) ?? undefined,
  );
  push('reasoning_model', 'Reasoning model', details.reasoning_model);
  push(
    'synthesis_provider',
    'Synthesis provider',
    details.synthesis_provider,
    zacProviderLabel(details.synthesis_provider) ?? undefined,
  );
  push('synthesis_model', 'Synthesis model', details.synthesis_model);
  push('router_version', 'Router version', details.router_version);
  push('prompt_version', 'Prompt version', details.prompt_version);
  if (details.semantic_confidence_bucket || typeof details.semantic_confidence === 'number') {
    const bucket = details.semantic_confidence_bucket
      ? zacRoutingLabel(ZAC_CONFIDENCE_BUCKET_LABELS, details.semantic_confidence_bucket)
      : null;
    const score =
      typeof details.semantic_confidence === 'number' ? details.semantic_confidence.toFixed(2) : null;
    const value = bucket && score ? `${bucket} (${score})` : (bucket ?? score ?? '');
    push('confidence', 'Confidence', value);
  }
  // Only what the API said — never a client-side reading of the source.
  if (typeof details.fallback_used === 'boolean') {
    push('fallback_used', 'Fallback used', details.fallback_used ? 'yes' : 'no');
  }
  push('fallback_reason', 'Fallback reason', details.fallback_reason, fallbackReason ?? undefined);
  if (details.semantic_routing_available === false) {
    push('semantic_routing_available', 'Semantic routing', 'unavailable in this deployment');
  }

  return {
    requestMode: { value: mode, label: zacRoutingLabel(ZAC_REQUEST_MODE_LABELS, mode) },
    analysisIntent: analysisIntent
      ? {
          value: analysisIntent.value,
          label: zacRoutingLabel(ZAC_ANALYSIS_INTENT_LABELS, analysisIntent.value),
          origin: analysisIntent.origin,
        }
      : null,
    summary,
    intentNote: analysisIntent?.origin === 'planner' ? 'planner intent' : null,
    source,
    fallback: { used: fallbackUsed, reasonLabel: fallbackReason },
    rows,
    shadow: describeShadow(details, summary),
  };
}
