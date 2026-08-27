import { Injectable, Logger } from '@nestjs/common';
import { ZAC_ANALYSIS_PLANNER_SCHEMA } from '../analysis/zac-analysis-planner.prompt';
import { ZAC_PRIORITY_SYNTHESIS_SCHEMA } from '../analysis/zac-priority-synthesis.prompt';
import { ZAC_SEMANTIC_ROUTER_SCHEMA } from '../routing/zac-semantic-router.prompt';

/**
 * Why a semantic call failed, at the granularity an operator can act on.
 *
 * `provider_unavailable` was the only signal before, and it covered a network
 * blip, an exhausted balance and a tool schema the API rejects outright — three
 * things with completely different fixes, one of which was ours.
 */
export type ZacSemanticFailureKind =
  | 'auth'
  | 'credit'
  | 'schema'
  | 'rate_limit'
  | 'timeout'
  | 'refusal'
  | 'invalid_output'
  | 'transport';

/** Which semantic capability produced the outcome. */
export type ZacSemanticCapability = 'router' | 'planner' | 'synthesis';

interface CapabilityState {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureKind: ZacSemanticFailureKind | null;
  consecutiveFailures: number;
  successes: number;
  failures: number;
}

/** Keywords the API rejects inside a `strict: true` tool schema. */
const UNSUPPORTED_SCHEMA_KEYWORDS = ['minimum', 'maximum', 'maxItems', 'minItems', 'multipleOf'];

/**
 * Runtime truth about the semantic layer.
 *
 * This exists because `/zac/health` reported `semantic_routing: true` and
 * `uat_ready: true` while every semantic request was returning HTTP 400. Both
 * fields were derived from configuration flags — whether a provider class
 * implements a method and whether an env var is set — neither of which says
 * anything about whether a call has ever worked.
 *
 * Readiness is now evidence-based: a deployment is UAT-ready when a semantic
 * call has actually SUCCEEDED and nothing has hard-failed since. Configuration
 * is necessary and no longer sufficient.
 *
 * Deliberately cheap: recording is two field writes on a path that already ran,
 * and reading is a property access. Health never makes a model call.
 */
@Injectable()
export class ZacSemanticHealthService {
  private readonly logger = new Logger(ZacSemanticHealthService.name);
  private readonly state = new Map<ZacSemanticCapability, CapabilityState>();
  private readonly schemaProblems: string[];

  constructor() {
    // Validated at BOOT, not on first traffic: a schema the API will reject is
    // a deploy-time defect, and finding it in a user's turn is how it stayed
    // invisible for weeks.
    this.schemaProblems = [
      ...findUnsupportedKeywords('semantic router', ZAC_SEMANTIC_ROUTER_SCHEMA),
      ...findUnsupportedKeywords('analysis planner', ZAC_ANALYSIS_PLANNER_SCHEMA),
      ...findUnsupportedKeywords('priority synthesis', ZAC_PRIORITY_SYNTHESIS_SCHEMA),
    ];
    if (this.schemaProblems.length > 0) {
      // Loud on purpose. Every semantic call will 400 until this is fixed.
      this.logger.error(
        `zac semantic tool schemas are invalid and WILL be rejected by the API: ${this.schemaProblems.join('; ')}`,
      );
    }
  }

  /** True when every strict tool schema uses only keywords the API accepts. */
  get schemaValid(): boolean {
    return this.schemaProblems.length === 0;
  }

  get schemaIssues(): readonly string[] {
    return this.schemaProblems;
  }

  recordSuccess(capability: ZacSemanticCapability, at = new Date()): void {
    const state = this.stateFor(capability);
    state.lastSuccessAt = at.toISOString();
    state.consecutiveFailures = 0;
    state.successes += 1;
  }

  recordFailure(
    capability: ZacSemanticCapability,
    kind: ZacSemanticFailureKind,
    at = new Date(),
  ): void {
    const state = this.stateFor(capability);
    state.lastFailureAt = at.toISOString();
    state.lastFailureKind = kind;
    state.consecutiveFailures += 1;
    state.failures += 1;
  }

  snapshot(capability: ZacSemanticCapability): CapabilityState {
    return { ...this.stateFor(capability) };
  }

  /**
   * Has the semantic layer demonstrably worked, and not hard-failed since?
   *
   * A hard failure — bad credentials, an exhausted balance, a rejected schema —
   * will not fix itself, so one is enough to withdraw readiness. A timeout or
   * a transport blip is transient and does not, unless they are piling up.
   */
  operational(capability: ZacSemanticCapability = 'router'): boolean {
    const state = this.stateFor(capability);
    if (state.lastSuccessAt === null) return false;
    if (state.lastFailureKind && HARD_FAILURES.has(state.lastFailureKind)) {
      // A hard failure after the last success means the last success is stale.
      return (
        state.lastFailureAt !== null &&
        state.lastSuccessAt !== null &&
        state.lastSuccessAt > state.lastFailureAt
      );
    }
    return state.consecutiveFailures < CONSECUTIVE_FAILURE_LIMIT;
  }

  /**
   * Why the semantic layer is not fully operational, in words an operator can
   * act on — or null when it is.
   */
  degradedReason(capability: ZacSemanticCapability = 'router'): string | null {
    if (!this.schemaValid) return 'semantic_schema_invalid';
    const state = this.stateFor(capability);
    if (state.lastSuccessAt === null) {
      return state.lastFailureKind ? `never_succeeded:${state.lastFailureKind}` : 'never_attempted';
    }
    if (this.operational(capability)) return null;
    return state.lastFailureKind ? `degraded:${state.lastFailureKind}` : 'degraded';
  }

  private stateFor(capability: ZacSemanticCapability): CapabilityState {
    const existing = this.state.get(capability);
    if (existing) return existing;
    const created: CapabilityState = {
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureKind: null,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
    };
    this.state.set(capability, created);
    return created;
  }
}

/** Failures that will not resolve on their own. */
const HARD_FAILURES: ReadonlySet<ZacSemanticFailureKind> = new Set(['auth', 'credit', 'schema']);

/** Transient failures tolerated up to this many in a row before degrading. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

function findUnsupportedKeywords(label: string, schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => findUnsupportedKeywords(label, item, `${path}[${index}]`));
  }
  if (schema === null || typeof schema !== 'object') return [];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.includes(key)) {
      problems.push(`${label}${path}.${key}`);
    }
    problems.push(...findUnsupportedKeywords(label, value, `${path}.${key}`));
  }
  return problems;
}

/**
 * Classify a provider error into something actionable. The API states the
 * cause plainly in its message; the old code kept only `error.name`, which
 * reduced "your balance is empty" and "your schema is wrong" to "Error".
 */
export function classifySemanticFailure(error: unknown): ZacSemanticFailureKind {
  const candidate = error as { status?: number; message?: string; name?: string } | null;
  const message = String(candidate?.message ?? '');
  const status = candidate?.status;

  if (status === 401 || status === 403 || /authentication|api key|unauthorized/i.test(message)) {
    return 'auth';
  }
  // Account-state rejections arrive as a 400 with no schema content: identity
  // verification pending, an organisation disabled or suspended, access not
  // granted. The remedy is in the provider console, so they belong with auth —
  // and without this they fell through to the 4xx catch-all below and were
  // reported as a schema defect, sending an operator to audit tool schemas
  // that the boot-time validator had already proved correct.
  if (
    /identity verification|organization (?:has been )?(?:disabled|suspended)|account (?:has been )?(?:disabled|suspended)|not (?:been )?(?:granted|allowed) access|verify your identity/i.test(
      message,
    )
  ) {
    return 'auth';
  }
  if (/credit balance|insufficient (?:credit|funds)|billing/i.test(message)) return 'credit';
  if (/not supported|invalid_request_error.*schema|tools\.\d+\./i.test(message)) return 'schema';
  if (status === 429 || /rate limit|overloaded/i.test(message)) return 'rate_limit';
  if (status === 408 || /timeout|timed out|aborted/i.test(`${candidate?.name ?? ''} ${message}`)) {
    return 'timeout';
  }
  // A 400 that is not credit or auth is almost always the request we built.
  if (typeof status === 'number' && status >= 400 && status < 500) return 'schema';
  return 'transport';
}
