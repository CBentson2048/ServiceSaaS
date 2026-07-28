import type { ZacRoleContext } from '../context/zac-context.types';
import type { ZacResponseType } from '../responses/zac-response.types';

/**
 * A role profile shapes how ZAC frames an answer for a role lens: the data scope
 * it may talk about, the response types it leads with, and the seed for the
 * eventual system prompt. It never grants data access — that stays with the
 * per-tool permission checks in the registry and dispatcher.
 */
export interface ZacRoleProfile {
  key: ZacRoleContext;
  displayName: string;
  dataScope: 'business' | 'locations' | 'self';
  scopeDescription: string;
  leadResponseTypes: ZacResponseType[];
  /** Short, PII-free prompt seed. Never logged alongside user content. */
  systemPromptSeed: string;
}
