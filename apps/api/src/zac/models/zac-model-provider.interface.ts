import type { ZacRoleContext } from '../context/zac-context.types';
import type { ZacRequestMode } from '../routing/zac-request-mode.types';
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
}

/** Outcome of one model classification call — mode may be null (unusable output). */
export interface ZacModeClassification {
  mode: string | null;
  /** Usage/cost of the call, for honest telemetry. Null if the call never billed. */
  completion: ZacModelCompletion | null;
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
  complete(request: ZacModelRequest): Promise<ZacModelCompletion>;
  /**
   * Optional: classify an AMBIGUOUS question into the closed request-mode
   * enum. The returned string is untrusted — callers validate it against the
   * enum and fall back deterministically on anything else. Providers must
   * treat the question with the same privacy contract as complete() (never
   * logged or persisted). Absent on the stub: no key, no classification.
   */
  classifyMode?(question: string, roleContext: ZacRoleContext): Promise<ZacModeClassification>;
}
