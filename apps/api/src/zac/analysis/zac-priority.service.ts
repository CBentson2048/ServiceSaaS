import { Injectable } from '@nestjs/common';
import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacEvidenceSignal } from './zac-analysis.types';
import {
  MAX_PRIORITY_COUNT,
  MIN_PRIORITY_COUNT,
  type ZacConsolidationResult,
  type ZacPriorityCandidate,
  type ZacPriorityDomain,
} from './zac-priority.types';

/** Issue key → the business domain a priority about it belongs to. */
const ISSUE_DOMAIN: Record<string, ZacPriorityDomain> = {
  rebooking: 'rebooking',
  utilisation: 'utilisation',
  revenue: 'revenue',
  cancellations: 'bookings',
  client_retention: 'bookings',
  team_kpi_standing: 'team_performance',
  team_consistency: 'team_performance',
  personal_performance: 'personal_performance',
};

/** Issue key → the title the owner sees. Never an internal identifier. */
const ISSUE_TITLE: Record<string, string> = {
  rebooking: 'Rebooking',
  utilisation: 'Utilisation and diary gaps',
  revenue: 'Revenue',
  cancellations: 'Cancellations',
  client_retention: 'Client retention',
  team_kpi_standing: 'Team KPI standing',
  team_consistency: 'Consistency across the team',
  personal_performance: 'Your own performance',
};

/**
 * Turns evidence signals into the small set of BUSINESS ISSUES worth acting on.
 *
 * This layer exists because ranking raw signals produced this, for a user who
 * asked for two things:
 *
 *   1. Rebooking rate — Rebooking is 0%, against your stated goal of 60%…
 *   2. Rebooking rate — Rebooking is 0%, against your stated goal of 60%…
 *   3. Stylists below their rebooking target — 6 of 6 stylists are below…
 *
 * Three slots, one problem, and one of them printed twice. Two tools measured
 * the same rate, a third measured the team's side of it, and nothing between
 * normalisation and narration knew that those were one issue rather than three.
 *
 * The order is the fix: dedupe identical readings → group by issue → score the
 * ISSUE once → rank → take N. A model is never asked to tidy up a bad list.
 */
@Injectable()
export class ZacPriorityService {
  /**
   * Extract how many priorities the user asked for.
   *
   * Deliberately parses the NUMBER and the noun it qualifies, never the
   * adjective between them — which is what makes "2 most importnat things"
   * work without a dictionary of misspellings.
   */
  requestedCount(question: string, fallback = 3): number {
    const q = question
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ');

    // "the single most important thing", "the one thing"
    if (/\b(?:the (?:single )?most \w+ thing|the one thing|one thing)\b/.test(q)) {
      return this.clamp(1, fallback);
    }

    // "top 2", "biggest three", "main 2"
    const qualified = /\b(?:top|best|biggest|main|key|first)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(q);
    if (qualified) return this.clamp(readNumber(qualified[1]), fallback);

    // "2 most importnat things", "three biggest issues", "5 priorities".
    // Up to three words of adjective are allowed between the number and the
    // noun, and none of them is inspected — typos cannot break this.
    const counted =
      /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[\w'-]+\s+){0,3}(?:things?|priorit\w*|areas?|issues?|items?|problems?|focus(?:es)?|actions?)\b/.exec(
        q,
      );
    if (counted) return this.clamp(readNumber(counted[1]), fallback);

    // "give me five", "just give me 2"
    const given = /\b(?:give me|just|only|show me)\s+(\d{1,2}|one|two|three|four|five)\b/.exec(q);
    if (given) return this.clamp(readNumber(given[1]), fallback);

    return this.clamp(fallback, fallback);
  }

  private clamp(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(MAX_PRIORITY_COUNT, Math.max(MIN_PRIORITY_COUNT, Math.round(value)));
  }

  /**
   * Signals → candidates. Exact duplicates are removed first (their evidence is
   * kept), then everything about one issue becomes one candidate.
   */
  consolidate(signals: ZacEvidenceSignal[]): ZacConsolidationResult {
    const rawSignalCount = signals.length;

    // 1. Exact duplicates: the same reading, of the same thing, for the same
    //    scope and period. Two tools reporting it is corroboration, not two
    //    problems — so the second one's references are merged into the first.
    const byIdentity = new Map<string, ZacEvidenceSignal>();
    let duplicateSignalsRemoved = 0;
    for (const signal of signals) {
      const key = identityKey(signal);
      const existing = byIdentity.get(key);
      if (!existing) {
        byIdentity.set(key, { ...signal, evidenceRefs: [...signal.evidenceRefs] });
        continue;
      }
      duplicateSignalsRemoved += 1;
      existing.evidenceRefs = dedupeEvidence([...existing.evidenceRefs, ...signal.evidenceRefs]);
      existing.limitations = [...new Set([...existing.limitations, ...signal.limitations])];
      // A duplicate confirmed by a second source is better evidenced, but only
      // slightly — see the cap in scoreCandidate for why this stays small.
      existing.confidence = Math.min(0.95, existing.confidence + 0.03);
    }

    // 2. Group what remains by ISSUE, not by source or by metric name.
    const byIssue = new Map<string, ZacEvidenceSignal[]>();
    for (const signal of byIdentity.values()) {
      const group = byIssue.get(signal.issueKey) ?? [];
      group.push(signal);
      byIssue.set(signal.issueKey, group);
    }

    let signalsMerged = 0;
    const candidates: ZacPriorityCandidate[] = [];
    for (const [issueKey, group] of byIssue) {
      // The primary is the reading that best states the issue: most severe,
      // then best evidenced, then the business-wide view over a team view.
      const ordered = [...group].sort((a, b) => {
        const bySeverity = severityRank(b.severity) - severityRank(a.severity);
        if (bySeverity !== 0) return bySeverity;
        const byScope = scopeRank(a.scope) - scopeRank(b.scope);
        if (byScope !== 0) return byScope;
        return b.confidence - a.confidence;
      });
      const [primary, ...supporting] = ordered;
      signalsMerged += supporting.length;

      candidates.push(
        this.buildCandidate(issueKey, primary, supporting),
      );
    }

    return {
      candidates: this.rank(candidates),
      rawSignalCount,
      duplicateSignalsRemoved,
      signalsMerged,
    };
  }

  private buildCandidate(
    issueKey: string,
    primary: ZacEvidenceSignal,
    supporting: ZacEvidenceSignal[],
  ): ZacPriorityCandidate {
    // Materiality is HOW BADLY a target is missed, not whether it is missed.
    // Binary materiality made a two-point shortfall against a stated goal
    // outrank utilisation at a third of its threshold — both "missed", scored
    // identically, and the wrong one led the answer.
    const materiality = shortfallOf(primary);

    // A stated goal is the user telling us what they care about. It raises
    // RELEVANCE — how much this matters to them — without touching how bad the
    // number is, which is severity's job.
    const touchesStatedGoal =
      primary.targetSource === 'user_memory_goal' ||
      supporting.some((signal) => signal.targetSource === 'user_memory_goal');

    const candidate: ZacPriorityCandidate = {
      id: `cand_${issueKey}`,
      domain: ISSUE_DOMAIN[issueKey] ?? 'other',
      title: ISSUE_TITLE[issueKey] ?? primary.metric,
      primarySignal: primary,
      supportingSignals: supporting,
      evidenceRefs: dedupeEvidence([
        ...primary.evidenceRefs,
        ...supporting.flatMap((signal) => signal.evidenceRefs),
      ]),
      severity: primary.severity,
      confidence: primary.confidence,
      materiality,
      relevance: touchesStatedGoal ? 1 : 0,
      priorityScore: 0,
      limitations: [
        ...new Set([...primary.limitations, ...supporting.flatMap((s) => s.limitations)]),
      ],
    };
    candidate.priorityScore = scoreCandidate(candidate);
    return candidate;
  }

  /** Rank ISSUES against each other — the comparison the user actually asked for. */
  rank(candidates: ZacPriorityCandidate[]): ZacPriorityCandidate[] {
    return [...candidates].sort((a, b) => {
      const byScore = b.priorityScore - a.priorityScore;
      if (byScore !== 0) return byScore;
      // Stable and explainable when scores tie.
      return a.title.localeCompare(b.title);
    });
  }

  /**
   * The candidates worth putting in front of the user, capped at what they
   * asked for. Nothing is invented to fill a slot: if only one issue is
   * materially supported, one is returned.
   */
  selectTop(candidates: ZacPriorityCandidate[], requestedCount: number): ZacPriorityCandidate[] {
    const worthRaising = candidates.filter((candidate) => candidate.severity !== 'positive');
    const pool = worthRaising.length > 0 ? worthRaising : candidates;
    return pool.slice(0, requestedCount);
  }
}

/**
 * Two readings are the same reading when they are about the same issue, measure
 * the same thing, over the same scope and period, and agree on the numbers.
 */
function identityKey(signal: ZacEvidenceSignal): string {
  return [
    signal.issueKey,
    signal.metric,
    signal.scope,
    signal.period ?? '-',
    String(signal.currentValue ?? '-'),
    String(signal.targetValue ?? '-'),
  ].join('|');
}

/**
 * One score per ISSUE.
 *
 *   severity     how far outside acceptable the headline reading is
 *   confidence   how much the data supports saying so
 *   materiality  whether a threshold or stated goal is actually missed
 *   relevance    whether the user has told us they care about this
 *
 * Supporting signals contribute a small, CAPPED bonus. Without the cap the most
 * heavily instrumented metric would win every slot: rebooking is measured by
 * three tools and utilisation by one, which says nothing about which matters
 * more to the business.
 */
function scoreCandidate(candidate: ZacPriorityCandidate): number {
  const severityWeight =
    candidate.severity === 'attention' ? 1 : candidate.severity === 'watch' ? 0.55 : 0.15;
  const materialityWeight = 1 + candidate.materiality * 0.6;
  const relevanceWeight = 1 + candidate.relevance * 0.15;
  const corroboration = 1 + Math.min(candidate.supportingSignals.length, 2) * 0.04;
  const directionWeight = candidate.primarySignal.direction === 'declining' ? 1.15 : 1;
  return Number(
    (
      severityWeight *
      candidate.confidence *
      materialityWeight *
      relevanceWeight *
      corroboration *
      directionWeight
    ).toFixed(4),
  );
}

/**
 * How far short of its target a reading falls, as a fraction of the target and
 * capped at 1. Zero when there is no target, or none is being missed.
 */
function shortfallOf(signal: ZacEvidenceSignal): number {
  if (typeof signal.currentValue !== 'number' || typeof signal.targetValue !== 'number') return 0;
  if (signal.targetValue <= 0 || signal.currentValue >= signal.targetValue) return 0;
  return Math.min(1, (signal.targetValue - signal.currentValue) / signal.targetValue);
}

function severityRank(severity: ZacEvidenceSignal['severity']): number {
  return severity === 'attention' ? 2 : severity === 'watch' ? 1 : 0;
}

/** Business-wide readings state an issue better than a team or personal slice. */
function scopeRank(scope: string): number {
  return scope === 'business' ? 0 : scope === 'team' ? 1 : 2;
}

function dedupeEvidence(items: ZacEvidenceItem[]): ZacEvidenceItem[] {
  const seen = new Set<string>();
  const out: ZacEvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.source_type}|${item.source_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function readNumber(token: string): number {
  return NUMBER_WORDS[token] ?? Number(token);
}
