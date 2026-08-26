import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacEvidenceSignal } from './zac-analysis.types';

/**
 * The closed set of business ISSUES a priority can be about.
 *
 * Deliberately coarser than the evidence domains. "6 of 6 stylists are below
 * the rebooking target" is a KPI reading, but it is not a separate thing for
 * the owner to work on — it is the same rebooking problem seen from the team's
 * side. Grouping on the issue rather than the source is what stops one problem
 * occupying every slot in a top-3.
 */
export type ZacPriorityDomain =
  | 'revenue'
  | 'bookings'
  | 'rebooking'
  | 'utilisation'
  | 'team_performance'
  | 'personal_performance'
  | 'appointment_capacity'
  | 'business_health'
  | 'other';

export const ZAC_PRIORITY_DOMAINS: readonly ZacPriorityDomain[] = [
  'revenue',
  'bookings',
  'rebooking',
  'utilisation',
  'team_performance',
  'personal_performance',
  'appointment_capacity',
  'business_health',
  'other',
];

/**
 * One business issue, assembled from every signal that speaks to it.
 *
 * `primarySignal` carries the headline measurement; `supportingSignals` are
 * corroboration from other sources. Supporting evidence makes a candidate
 * better EVIDENCED, not more important — see the capped confidence bonus in
 * the scorer — because otherwise the most heavily instrumented metric would
 * win every slot regardless of what actually matters.
 */
export interface ZacPriorityCandidate {
  /** Stable within one turn; the only handle the model may refer to. */
  id: string;
  domain: ZacPriorityDomain;
  title: string;
  primarySignal: ZacEvidenceSignal;
  supportingSignals: ZacEvidenceSignal[];
  evidenceRefs: ZacEvidenceItem[];
  severity: ZacEvidenceSignal['severity'];
  confidence: number;
  /** 1 when a threshold or stated goal is actually being missed, else 0. */
  materiality: number;
  /** Raised when the issue touches something the user said they care about. */
  relevance: number;
  priorityScore: number;
  limitations: string[];
}

/** What consolidation did, for observability and for the tests to assert on. */
export interface ZacConsolidationResult {
  candidates: ZacPriorityCandidate[];
  rawSignalCount: number;
  duplicateSignalsRemoved: number;
  signalsMerged: number;
}

/** One validated priority to render. */
export interface ZacResolvedPriority {
  candidate: ZacPriorityCandidate;
  /** Model prose when a synthesis was accepted; null for the deterministic path. */
  explanation: string | null;
  action: string | null;
}

/**
 * Server-side bounds on how many priorities an answer may contain. The model
 * is told the number but never sets it: a request for two things that returns
 * three has ignored the only instruction the user actually gave.
 */
export const MIN_PRIORITY_COUNT = 1;
export const MAX_PRIORITY_COUNT = 5;

export function isZacPriorityDomain(candidate: unknown): candidate is ZacPriorityDomain {
  return (
    typeof candidate === 'string' && (ZAC_PRIORITY_DOMAINS as readonly string[]).includes(candidate)
  );
}
