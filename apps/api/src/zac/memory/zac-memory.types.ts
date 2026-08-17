import type { ZacRoleContext } from '../context/zac-context.types';
import type { ZacMemoryScope } from '../responses/zac-response.types';

/**
 * The Phase 1 context-memory vocabulary. Deliberately closed: every kind here
 * has a concrete Phase 1 use case, and the capture path refuses to invent new
 * ones. Stored in zac.memory_items.kind.
 */
export type ZacMemoryKind =
  | 'business_goal'
  | 'user_preference'
  | 'business_priority'
  | 'recurring_problem'
  | 'prior_decision'
  | 'coaching_focus'
  | 'manager_team_theme';

export const ZAC_MEMORY_KINDS: readonly ZacMemoryKind[] = [
  'business_goal',
  'user_preference',
  'business_priority',
  'recurring_problem',
  'prior_decision',
  'coaching_focus',
  'manager_team_theme',
];

/** User-facing label for a memory kind, used in recall/acknowledgement copy. */
export const ZAC_MEMORY_KIND_LABELS: Record<ZacMemoryKind, string> = {
  business_goal: 'Business goal',
  user_preference: 'Preference',
  business_priority: 'Business priority',
  recurring_problem: 'Recurring problem',
  prior_decision: 'Decision',
  coaching_focus: 'Coaching focus',
  manager_team_theme: 'Team theme',
};

/**
 * One persisted memory as the API works with it (a safe projection of a
 * zac.memory_items row). content is redacted summary text by construction.
 */
export interface ZacMemoryItem {
  id: string;
  businessId: string;
  locationId: string | null;
  actorUserId: string;
  roleContext: ZacRoleContext;
  visibilityScope: ZacMemoryScope;
  kind: ZacMemoryKind;
  topic: string;
  content: string;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A deterministic extraction result from one explicit user message. The
 * extractor NEVER chooses visibility — scope is resolved server-side from the
 * acting role and kind (ZacMemoryService.resolveScope), so model or user text
 * can never widen who sees a memory.
 */
export interface ZacMemoryCommand {
  kind: ZacMemoryKind;
  /** Server-derived subject slug ('rebooking', 'communication_style', ...). */
  topic: string;
  /** Redacted, capped safe summary ready for storage. */
  content: string;
  /**
   * True when the message updates an existing memory ("update that goal to
   * 60%") rather than stating a new one — the capture path then resolves the
   * predecessor even when the topic could not be inferred from this message.
   */
  updateIntent: boolean;
  /** Raw numeric/percentage token in the clause (e.g. '60%'), for update synthesis. */
  statedValue: string | null;
}

/** What a memory-recall question asks about; drives retrieval + answer framing. */
export type ZacMemoryRecallSubject =
  | 'about_me'
  | 'about_business'
  | 'about_team'
  | 'goals'
  | 'preferences';
