import type { ZacRoleContext } from '../context/zac-context.types';

/** Injection token for the active {@link ZacModelProvider} implementation. */
export const ZAC_MODEL_PROVIDER = 'ZAC_MODEL_PROVIDER';

/**
 * One model turn. The question text lives only in memory for the request —
 * providers must never log or persist it. Week 1 binds the stub provider only;
 * a live provider joins behind this same interface later.
 */
export interface ZacModelRequest {
  question: string;
  roleContext: ZacRoleContext;
  systemPromptSeed: string;
  /** Tool names only — the provider layer never receives tool data it could leak. */
  availableToolNames: string[];
}

export interface ZacModelCompletion {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
}

export interface ZacModelProvider {
  readonly name: string;
  readonly model: string;
  complete(request: ZacModelRequest): Promise<ZacModelCompletion>;
}
