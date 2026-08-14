import type { ZacRoleContext } from '../context/zac-context.types';
import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacToolName } from '../tools/zac-tool.types';

/** Injection token for the active {@link ZacModelProvider} implementation. */
export const ZAC_MODEL_PROVIDER = 'ZAC_MODEL_PROVIDER';

/**
 * The model declined the request via its safety classifiers. Callers treat this
 * exactly like any other provider failure: fall back to the deterministic
 * tool-backed answer — never surface a raw refusal to the user.
 */
export class ZacModelRefusedError extends Error {}

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
}
