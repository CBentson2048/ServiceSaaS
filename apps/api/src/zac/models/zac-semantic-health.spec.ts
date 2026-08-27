import {
  ZacSemanticHealthService,
  classifySemanticFailure,
} from './zac-semantic-health.service';

/**
 * Readiness reporting.
 *
 * The defect: `/zac/health` reported `semantic_routing: true` and
 * `uat_ready: true` while EVERY semantic request returned HTTP 400 for a tool
 * schema the API rejects. Both fields were derived from configuration — a flag
 * and a capability boolean — neither of which is evidence that a call has ever
 * worked. A deployment can now only claim readiness by having demonstrated it.
 */
describe('semantic health', () => {
  it('validates the strict tool schemas at boot', () => {
    const health = new ZacSemanticHealthService();

    expect(health.schemaValid).toBe(true);
    expect(health.schemaIssues).toEqual([]);
  });

  it('is not operational before anything has been attempted', () => {
    const health = new ZacSemanticHealthService();

    // Configuration is not evidence. A fresh boot has proved nothing.
    expect(health.operational('router')).toBe(false);
    expect(health.degradedReason('router')).toBe('never_attempted');
  });

  it('becomes operational once a call actually succeeds', () => {
    const health = new ZacSemanticHealthService();
    health.recordSuccess('router');

    expect(health.operational('router')).toBe(true);
    expect(health.degradedReason('router')).toBeNull();
  });

  it.each(['auth', 'credit', 'schema'] as const)(
    'withdraws readiness immediately on a %s failure — these do not self-heal',
    (kind) => {
      const health = new ZacSemanticHealthService();
      health.recordSuccess('router', new Date('2026-08-26T10:00:00Z'));
      health.recordFailure('router', kind, new Date('2026-08-26T10:05:00Z'));

      expect(health.operational('router')).toBe(false);
      expect(health.degradedReason('router')).toBe(`degraded:${kind}`);
    },
  );

  it('tolerates a transient blip but degrades on a run of them', () => {
    const health = new ZacSemanticHealthService();
    health.recordSuccess('router');

    health.recordFailure('router', 'timeout');
    expect(health.operational('router')).toBe(true);

    health.recordFailure('router', 'timeout');
    health.recordFailure('router', 'timeout');
    expect(health.operational('router')).toBe(false);
    expect(health.degradedReason('router')).toBe('degraded:timeout');
  });

  it('recovers when a call succeeds after a hard failure', () => {
    const health = new ZacSemanticHealthService();
    health.recordFailure('router', 'credit', new Date('2026-08-26T10:00:00Z'));
    expect(health.operational('router')).toBe(false);
    expect(health.degradedReason('router')).toBe('never_succeeded:credit');

    health.recordSuccess('router', new Date('2026-08-26T11:00:00Z'));
    expect(health.operational('router')).toBe(true);
  });

  it('tracks each capability separately', () => {
    const health = new ZacSemanticHealthService();
    health.recordSuccess('router');
    health.recordFailure('planner', 'credit');

    expect(health.operational('router')).toBe(true);
    expect(health.operational('planner')).toBe(false);
  });
});

describe('provider failure classification', () => {
  /**
   * These are the messages the API actually returns. Reducing them all to
   * `provider_unavailable` is what made an exhausted balance, bad credentials
   * and our own malformed schema indistinguishable from a network blip.
   */
  it.each([
    [{ status: 400, message: 'Your credit balance is too low to access the Anthropic API' }, 'credit'],
    [{ status: 401, message: 'invalid x-api-key' }, 'auth'],
    // Observed live on this account: a 400 whose remedy is a console action,
    // not a code change. Misreading it as 'schema' points the operator at the
    // one thing that is provably fine.
    [{ status: 400, message: 'Identity verification is required to continue.' }, 'auth'],
    [{ status: 400, message: 'Your organization has been disabled.' }, 'auth'],
    [
      { status: 400, message: "tools.0.custom: For 'number' type, properties maximum, minimum are not supported" },
      'schema',
    ],
    [{ status: 429, message: 'rate limit exceeded' }, 'rate_limit'],
    [{ status: 529, message: 'Overloaded' }, 'rate_limit'],
    [{ name: 'APIConnectionTimeoutError', message: 'Request timed out.' }, 'timeout'],
    [{ status: 500, message: 'internal server error' }, 'transport'],
    [{ message: 'socket hang up' }, 'transport'],
  ])('classifies %j', (error, expected) => {
    expect(classifySemanticFailure(error)).toBe(expected);
  });

  it('treats an unexplained 4xx as our own request bug', () => {
    // A 4xx is never transient and never the user's data — it is a request we
    // built wrongly, which is exactly the case that hid for weeks.
    expect(classifySemanticFailure({ status: 422, message: 'unprocessable' })).toBe('schema');
  });
});
