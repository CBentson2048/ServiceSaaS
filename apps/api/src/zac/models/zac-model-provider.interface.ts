import type { ZacRoleContext } from '../context/zac-context.types';
import type {
  ZacClassifierFailure,
  ZacRequestMode,
} from '../routing/zac-request-mode.types';
import type { ZacSemanticFailureKind } from './zac-semantic-health.service';
import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacToolName } from '../tools/zac-tool.types';

/** Injection token for the active {@link ZacModelProvider} implementation. */
export const ZAC_MODEL_PROVIDER = 'ZAC_MODEL_PROVIDER';

/**
 * The model declined the request via its safety classifiers. Callers treat this
 * exactly like any other provider failure: fall back to the deterministic
 * tool-backed answer — never surface a raw refusal to the user. A refusal is
 * still a BILLED call: when usage is known, the completion (empty text) rides
 * on the error so the cost spine records it, mirroring ZacModelIncompleteError.
 */
export class ZacModelRefusedError extends Error {
  constructor(
    message: string,
    readonly completion?: ZacModelCompletion,
  ) {
    super(message);
  }
}

/**
 * The call completed but the narration is unusable (e.g. truncated at the
 * token cap mid-sentence). Unlike a transport failure, the call DID bill —
 * the completion rides on the error so the orchestrator can still record an
 * honest cost event while serving the deterministic answer.
 */
export class ZacModelIncompleteError extends Error {
  constructor(
    message: string,
    readonly completion: ZacModelCompletion,
  ) {
    super(message);
  }
}

/**
 * PII-safe material from ONE permission-checked tool dispatch — the only
 * numbers the model may narrate. All text is safe-handles-only by the tool
 * contract (client codes, never names/contact details).
 */
export interface ZacModelEvidencePack {
  toolName: ZacToolName;
  /** The tool's own deterministic answer text — verified figures. */
  toolAnswer: string;
  evidence: ZacEvidenceItem[];
  limitations: string[];
}

/**
 * Several permission-checked sources, plus the deterministic ranking, for ONE
 * synthesis. Kept distinct from `evidencePack` because the task is different:
 * narration restates one tool's answer, synthesis weighs several against each
 * other and returns a small number of priorities.
 */
export interface ZacModelSynthesisPack {
  strategy: string;
  /** Ranked, source-attributed one-liners — the only measurements available. */
  signals: Array<{
    sourceTool: ZacToolName;
    headline: string;
    severity: string;
    /** 'tool_threshold' | 'user_memory_goal' | null — provenance for any target. */
    targetSource: string | null;
  }>;
  /** Sources that could not contribute, stated honestly rather than hidden. */
  limitations: string[];
  /** How many priorities to return at most. */
  requestedCount: number;
  /** Domains that were NOT assessed, so coverage is not overstated. */
  unassessedDomains: string[];
}

/**
 * User-stated context memory entering one narration — clearly separated from
 * tool evidence so a remembered aspiration can never masquerade as a live
 * figure. Summaries are already redacted; providers must never log them.
 */
export interface ZacModelMemoryItem {
  /** e.g. 'business_goal' — lets the prompt label it honestly. */
  kind: string;
  /** The redacted safe summary, e.g. 'Increase rebooking to 60% this month.' */
  summary: string;
}

/** Continuity signals for one turn — safe metadata only, no transcript text. */
export interface ZacModelConversationState {
  /** False = a prior assistant turn exists; do not greet or reintroduce ZAC. */
  firstAssistantTurn: boolean;
  /** Structural summaries of recent turns (oldest first), e.g. 'Asked about business health (week)'. */
  recentTurnSummaries: string[];
}

/**
 * One model turn. The question text lives only in memory for the request —
 * providers must never log or persist it.
 */
export interface ZacModelRequest {
  question: string;
  roleContext: ZacRoleContext;
  systemPromptSeed: string;
  /** Tool names only — the provider layer never receives tool data it could leak. */
  availableToolNames: string[];
  /**
   * Present = narrate these verified figures. Absent = no dispatched evidence
   * (capability/foundation turns), answer honestly about capabilities only.
   */
  evidencePack?: ZacModelEvidencePack;
  /**
   * Present = synthesise across several sources instead of narrating one.
   * Mutually exclusive with `evidencePack` in practice; when both are present
   * the synthesis pack wins, because it already contains the same figures.
   */
  synthesisPack?: ZacModelSynthesisPack;
  /** User-stated memory relevant to this turn; NEVER merged into evidence. */
  memoryContext?: ZacModelMemoryItem[];
  /** Absent on legacy/stateless turns — providers then behave as before. */
  conversationState?: ZacModelConversationState;
  /**
   * How this turn is being answered. Advisory modes (general_advice,
   * hypothetical, conversational) carry no evidence pack: the provider must
   * instruct the model to reason without claiming live business figures.
   * Absent = narration behaviour (back-compat).
   */
  mode?: ZacRequestMode;
  /**
   * How many items the user asked for, when they asked for a number. Advisory
   * answers honour it too: "the 2 biggest things a salon owner should focus
   * on" is an instruction whether or not any data is read.
   */
  requestedCount?: number;
}

/**
 * Everything the semantic router is allowed to see. Deliberately tiny: the
 * question, the role LENS (not identity, business or permissions) and at most
 * a few structural turn summaries. No transcripts, no tool output, no client
 * PII, no business records, no credentials.
 */
export interface ZacSemanticRouterInput {
  question: string;
  roleContext: ZacRoleContext;
  /** Structural summaries only, e.g. 'Asked about business health (week)'. */
  recentTurnSummaries?: string[];
}

/**
 * Raw semantic-router output. Every field is `unknown` on purpose: this is
 * model-generated and therefore untrusted. The routing service validates each
 * field against the closed server-side enums before any of it can influence a
 * decision — a provider can never hand back a usable mode by itself.
 */
export interface ZacSemanticRouterRawOutput {
  mode?: unknown;
  confidence?: unknown;
  requires_live_business_data?: unknown;
  reason_code?: unknown;
  /**
   * WHAT the request reaches for, so the server can apply fixed policy before
   * anything is dispatched. Untrusted like every other field: validated against
   * the closed category enum, and never an authorisation claim — the model is
   * never asked, and may never state, whether access is allowed.
   */
  resource_category?: unknown;
}

/** Outcome of one semantic classification call. */
export interface ZacSemanticRouterOutcome {
  /** Untrusted model output; null when nothing usable came back. */
  raw: ZacSemanticRouterRawOutput | null;
  /** Why it failed, when it did — kept distinct from data-availability failures. */
  failure: ZacClassifierFailure | null;
  /** Usage/cost of the call, for honest telemetry. Null if the call never billed. */
  completion: ZacModelCompletion | null;
  /**
   * The actionable cause when the call failed: bad credentials, an exhausted
   * balance, a rejected schema, a rate limit, a timeout. The closed
   * `ZacClassifierFailure` above drives ROUTING (it must stay small and
   * behavioural); this drives OBSERVABILITY, and conflating them is how a 400
   * for our own schema looked like a network blip for weeks.
   */
  failureKind?: ZacSemanticFailureKind;
}

export interface ZacModelCompletion {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Prompt-cache activity for honest cost telemetry; 0 on the stub. */
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedCostUsd: number;
}

export interface ZacModelProvider {
  readonly name: string;
  readonly model: string;
  /**
   * True when completions carry user-facing narration. The stub is false: its
   * text is trace plumbing, and the orchestrator skips the call entirely so
   * deterministic answers stay byte-identical without a live provider.
   */
  readonly narrates: boolean;
  /**
   * True when this provider can perform Layer 2 semantic intent
   * classification. False means ZAC is running on deterministic rules alone —
   * a materially reduced product, so /zac/health reports it and the hosted
   * smoke test fails readiness on it.
   */
  readonly semanticRouting: boolean;
  complete(request: ZacModelRequest): Promise<ZacModelCompletion>;
  /**
   * Optional: semantic intent classification for a request the deterministic
   * layer could not resolve with certainty. Output is UNTRUSTED — callers
   * validate every field against the closed enums and fall back safely on
   * anything else. Providers must treat the question with the same privacy
   * contract as complete() (never logged or persisted), must never throw
   * (failures come back as a `failure` code), and must never receive or return
   * tool names, permissions, actor identity or scope.
   */
  classifyRequestMode?(input: ZacSemanticRouterInput): Promise<ZacSemanticRouterOutcome>;
  /**
   * Optional: decide WHAT KIND of analysis a live-data question needs, and
   * which of the supplied evidence sources would answer it.
   *
   * The catalogue it receives has already been filtered to tools this actor
   * may use right now, so the model cannot propose anything it was not shown —
   * and everything it returns is re-validated server-side anyway. It is never
   * told who the actor is, what permissions they hold, or any business data.
   */
  planAnalysis?(input: ZacAnalysisPlanInput): Promise<ZacAnalysisPlanOutcome>;
  /**
   * Optional: choose and explain priorities from a supplied candidate list.
   *
   * Structured on purpose. Free prose let the model return four priorities for
   * a request for two, repeat one, and split a single issue across slots —
   * because nothing downstream could tell which sentence was which priority.
   * Selecting by candidate id makes every one of those a validation failure
   * instead of a user-visible defect: the model cannot invent a candidate, and
   * the server does the counting.
   */
  synthesisePriorities?(input: ZacPrioritySynthesisInput): Promise<ZacPrioritySynthesisOutcome>;
}

/** What the priority synthesiser may see. Candidates only — no raw payloads. */
export interface ZacPrioritySynthesisInput {
  question: string;
  roleContext: ZacRoleContext;
  requestedCount: number;
  candidates: Array<{
    id: string;
    title: string;
    headline: string;
    severity: string;
    supporting: string[];
    /** 'user_memory_goal' when a target came from what the user told ZAC. */
    targetSource: string | null;
  }>;
  limitations: string[];
  unassessedAreas: string[];
}

/** Untrusted synthesis output. Every id is validated against the candidates. */
export interface ZacPrioritySynthesisRawOutput {
  priorities?: unknown;
  /** Optional one-line framing; validated for grounding like any other prose. */
  preamble?: unknown;
}

export interface ZacPrioritySynthesisOutcome {
  raw: ZacPrioritySynthesisRawOutput | null;
  failure: ZacClassifierFailure | null;
  completion: ZacModelCompletion | null;
  failureKind?: ZacSemanticFailureKind;
}

/** Everything the planner is allowed to see. No identity, no data, no scope. */
export interface ZacAnalysisPlanInput {
  question: string;
  roleContext: ZacRoleContext;
  /** Permitted, enabled sources only — name + purpose, nothing more. */
  catalogue: Array<{ name: string; purpose: string; domains: string[] }>;
  recentTurnSummaries?: string[];
  /** Kinds only ('business_goal'), never the remembered text. */
  memoryKinds?: string[];
}

/** Untrusted planner output. Every field is validated before it is used. */
export interface ZacAnalysisPlanRawOutput {
  analysis_intent?: unknown;
  reason_code?: unknown;
  confidence?: unknown;
  tools?: unknown;
  synthesis_strategy?: unknown;
}

export interface ZacAnalysisPlanOutcome {
  raw: ZacAnalysisPlanRawOutput | null;
  failure: ZacClassifierFailure | null;
  completion: ZacModelCompletion | null;
  failureKind?: ZacSemanticFailureKind;
}
