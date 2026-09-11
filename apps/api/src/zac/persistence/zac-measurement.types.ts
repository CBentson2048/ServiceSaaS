import type { ZacRoleContext } from '../context/zac-context.types';
import type { ZacRequestMode } from '../routing/zac-request-mode.types';
import type {
  ZacEvidenceItem,
  ZacMemoryScope,
  ZacResponseType,
} from '../responses/zac-response.types';

/**
 * The closed Phase 1 attribution vocabulary (Day 4 concepts). Conservative by
 * contract: nothing in the codebase upgrades attribution automatically — a
 * "useful" click is feedback, never an influenced outcome, and a KPI movement
 * after a recommendation is never directly attributable by itself. `null`
 * attribution means unattributed.
 */
export type ZacAttributionType = 'observed' | 'influenced' | 'directly_attributable';

export const ZAC_ATTRIBUTION_TYPES: readonly ZacAttributionType[] = [
  'observed',
  'influenced',
  'directly_attributable',
];

/** One persisted-output insert — pre-redacted safe content only. */
export interface ZacOutputInsert {
  businessId: string;
  locationId: string | null;
  actorUserId: string;
  roleContext: ZacRoleContext;
  visibilityScope: ZacMemoryScope;
  responseType: ZacResponseType;
  requestMode: ZacRequestMode;
  title: string | null;
  bodyRedacted: string;
  evidence: ZacEvidenceItem[];
  limitations: string[];
  confidence: string;
  conversationId: string | null;
  traceId: string;
}

/** Safe projection of a zac.outputs row used for access checks. */
export interface ZacOutputRecord {
  id: string;
  business_id: string;
  actor_user_id: string | null;
  /** Needed to scope a manager to their own sites; null when business-wide. */
  location_id: string | null;
  visibility_scope: string;
  response_type: string;
  request_mode: string | null;
}

/** One persisted tool dispatch — names/status/latency, never payloads. */
export interface ZacToolCallInsert {
  businessId: string;
  locationId: string | null;
  conversationId: string | null;
  actorUserId: string;
  roleContext: ZacRoleContext;
  toolName: string;
  argsMeta: Record<string, unknown>;
  resultStatus: string;
  resultRowCount: number | null;
  latencyMs: number;
  traceId: string;
}

/** The actor's single active vote on an output. */
export interface ZacFeedbackRecord {
  businessId: string;
  actorUserId: string;
  roleContext: ZacRoleContext;
  outputId: string;
  /** Storage vocabulary from 0077: up = useful, down = not useful. */
  rating: 'up' | 'down';
  commentRedacted: string | null;
}

/** One explicit outcome event — recorded on evidence, never inferred. */
export interface ZacOutcomeInsert {
  businessId: string;
  locationId: string | null;
  actorUserId: string;
  roleContext: ZacRoleContext;
  outputId: string;
  /** Snapshot of the source output's visibility — outcome rows inherit its privacy. */
  visibilityScope: string;
  outcomeType: string;
  summaryRedacted: string;
  observedValue: number | null;
  estimatedFinancialValueCents: number | null;
  confidence: string | null;
  /** Null = unattributed. Callers must not default upward. */
  attributionType: ZacAttributionType | null;
  evidence: Record<string, unknown>[];
}
