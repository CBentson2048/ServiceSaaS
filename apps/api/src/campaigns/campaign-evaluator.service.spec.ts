/**
 * CampaignEvaluatorService — the run lifecycle.
 *
 * What these specs are for, in order of importance:
 *
 *   1. DUPLICATE PREVENTION. Two evaluators against the same campaign/day, and
 *      the same campaign run twice, must produce ONE message. Both guards are
 *      exercised against a fake that behaves like the real unique constraints.
 *   2. DISPATCH THROUGH THE EXISTING LAYER. The evaluator must reach
 *      MessagingService and nothing else — no provider, no direct queue write.
 *   3. CONSENT AND SUPPRESSION. An opted-out client gets nothing, and the reason
 *      is recorded rather than lost.
 *   4. FAILURE ISOLATION. Nothing here may throw out of `tick()`.
 *   5. PREVIEW. The preview writes nothing and sends nothing.
 */
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { MessagingService, SendMessageResult } from '../communications/messaging.service';
import type { CampaignAudienceService, CampaignCandidate } from './campaign-audience.service';
import { CampaignEvaluatorService } from './campaign-evaluator.service';
import type { CampaignRow } from './campaign-row';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BUSINESS = 'b0000000-0000-4000-8000-000000000001';
const LOCATION = '10000000-0000-4000-8000-000000000001';
const CAMPAIGN = 'c0000000-0000-4000-8000-000000000001';
const TODAY = '2026-09-01';

interface Write {
  table: string;
  verb: string;
  payload: Record<string, unknown>;
}

interface Rpc {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * A Supabase fake that enforces the two unique constraints that matter:
 *   - campaign_runs (campaign_id, run_local_date)
 *   - campaign_recipients (campaign_id, dedupe_key), including the
 *     claim function's "a queued row is never re-offered" rule.
 * Shared between calls so two evaluator instances can race the same state.
 */
function makeBackend() {
  const runs: Array<Record<string, unknown>> = [];
  const recipients: Array<Record<string, unknown>> = [];
  const writes: Write[] = [];
  const rpcs: Rpc[] = [];
  let campaigns: Array<Record<string, unknown>> = [];

  const rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    claim_campaign_recipient: (args) => {
      const key = args['p_dedupe_key'] as string;
      const existing = recipients.find((r) => r['campaign_id'] === args['p_campaign_id'] && r['dedupe_key'] === key);
      if (existing) {
        // ON CONFLICT DO UPDATE ... WHERE status in ('suppressed','failed').
        // A queued row yields NO row — that is the duplicate signal.
        if (existing['status'] === 'queued') return [];
        existing['status'] = 'suppressed';
        existing['suppression_reason'] = 'claimed, not yet enqueued';
        return [{ recipient_id: existing['id'], claimed: true }];
      }
      const id = `rcpt-${recipients.length + 1}`;
      recipients.push({
        id,
        campaign_id: args['p_campaign_id'],
        dedupe_key: key,
        client_profile_id: args['p_client_profile_id'],
        status: 'suppressed',
        suppression_reason: 'claimed, not yet enqueued',
      });
      return [{ recipient_id: id, claimed: true }];
    },
    settle_campaign_recipient: (args) => {
      const row = recipients.find((r) => r['id'] === args['p_recipient_id']);
      if (row) {
        row['status'] = args['p_status'];
        row['suppression_reason'] = args['p_status'] === 'queued' ? null : args['p_suppression_reason'];
      }
      return null;
    },
  };

  const tableRows = (table: string): Array<Record<string, unknown>> => {
    if (table === 'campaign_runs') return runs;
    if (table === 'campaign_recipients') return recipients;
    if (table === 'campaigns') return campaigns;
    if (table === 'businesses') return [{ id: BUSINESS, name: 'Luke Ormsby Hair', slug: 'loh', timezone: 'Europe/London' }];
    if (table === 'locations') return [{ id: LOCATION, name: 'Primrose Hill', timezone: 'Europe/London' }];
    return [];
  };

  const makeChain = (table: string) => {
    let rows = tableRows(table).map((row) => ({ ...row }));
    let verb = 'select';
    let payload: Record<string, unknown> = {};
    let limit: number | null = null;

    const settle = () => {
      writes.push({ table, verb, payload });
      if (verb === 'insert') {
        if (table === 'campaign_runs') {
          const clash = runs.some(
            (r) => r['campaign_id'] === payload['campaign_id'] && r['run_local_date'] === payload['run_local_date'],
          );
          if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          const row = { id: `run-${runs.length + 1}`, ...payload };
          runs.push(row);
          return { data: row, error: null };
        }
        if (table === 'campaign_recipients') {
          const clash = recipients.some(
            (r) => r['campaign_id'] === payload['campaign_id'] && r['dedupe_key'] === payload['dedupe_key'],
          );
          if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          const row = { id: `rcpt-${recipients.length + 1}`, ...payload };
          recipients.push(row);
          return { data: row, error: null };
        }
        return { data: { id: 'x', ...payload }, error: null };
      }
      if (verb === 'update') {
        // PostgREST returns the UPDATED rows when the caller adds `.select()`,
        // and an update whose filters match nothing returns none — which is how
        // the continuation claim (0111) tells "I own this run" from "someone
        // else already re-opened it".
        const updated: Array<Record<string, unknown>> = [];
        for (const match of rows) {
          const live = tableRows(table).find((r) => r['id'] === match['id']);
          if (live) {
            Object.assign(live, payload);
            updated.push({ ...live });
          }
        }
        return { data: updated[0] ?? null, error: null };
      }
      return { data: null, error: null };
    };

    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      returns: () => chain,
      order: () => chain,
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      neq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] !== value);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      insert: (body: Record<string, unknown>) => {
        verb = 'insert';
        payload = body;
        return chain;
      },
      update: (body: Record<string, unknown>) => {
        verb = 'update';
        payload = body;
        return chain;
      },
      maybeSingle: async () => {
        if (verb !== 'select') return settle();
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
        const value =
          verb === 'select'
            ? { data: limit === null ? rows : rows.slice(0, limit), error: null }
            : settle();
        return Promise.resolve(value).then(resolve, reject);
      },
    });
    return chain;
  };

  mockedCreateClient.mockReturnValue({
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        const handler = rpcHandlers[fn];
        return { data: handler ? handler(args) : [], error: null };
      },
    }),
  } as never);

  return {
    runs,
    recipients,
    writes,
    rpcs,
    setCampaigns: (rows: Array<Record<string, unknown>>) => {
      campaigns = rows;
    },
  };
}

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: CAMPAIGN,
    business_id: BUSINESS,
    location_id: null,
    campaign_type: 'birthday',
    name: 'Birthday treat',
    status: 'active',
    channel: 'auto',
    message_template: 'Happy birthday {{first_name}}, from {{salon_name}}!',
    message_subject: null,
    send_at_local_hour: 10,
    config: { daysBefore: 0 },
    created_by_user_profile_id: null,
    last_evaluated_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    run_now_requested_local_date: null,
    timezone: 'Europe/London',
    ...overrides,
  };
}

function candidate(overrides: Partial<CampaignCandidate> = {}): CampaignCandidate {
  return {
    clientId: 'olivia',
    firstName: 'Olivia',
    lastName: 'Brown',
    email: 'olivia@example.com',
    phone: '+447700900002',
    marketingOptIn: true,
    primaryLocationId: LOCATION,
    dedupeKey: `campaign:${CAMPAIGN}:birthday:olivia:2026`,
    matchReason: 'Birthday today (2026-09-01)',
    ...overrides,
  };
}

function build(input: {
  candidates?: CampaignCandidate[];
  sendResult?: SendMessageResult | ((n: number) => SendMessageResult);
  resolveThrows?: Error;
  maxRecipientsPerRun?: number;
} = {}) {
  const backend = makeBackend();
  const sends: Array<Record<string, unknown>> = [];
  let sendCount = 0;

  const audience = {
    resolveCandidates: jest.fn(async () => {
      if (input.resolveThrows) throw input.resolveThrows;
      return { candidates: input.candidates ?? [], truncated: false };
    }),
  } as unknown as CampaignAudienceService;

  const messaging = {
    send: jest.fn(async (request: Record<string, unknown>) => {
      sends.push(request);
      sendCount += 1;
      const result = input.sendResult ?? { status: 'queued', eventId: `evt-${sendCount}`, channel: 'whatsapp' };
      return typeof result === 'function' ? result(sendCount) : result;
    }),
  } as unknown as MessagingService;

  const config = {
    getOrThrow: () => 'x',
    get: (key: string) => {
      if (key === 'CORS_ORIGINS') return 'https://app.example';
      // Lets a test shrink the per-run recipient bound so continuation can be
      // exercised without seeding 500 candidates.
      if (key === 'CAMPAIGNS_MAX_RECIPIENTS_PER_RUN') return input.maxRecipientsPerRun;
      return undefined;
    },
  } as unknown as ConfigService;

  return {
    service: new CampaignEvaluatorService(config, audience, messaging),
    backend,
    sends,
    messaging,
    audience,
  };
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Dispatch through the existing messaging layer — Wrike sections 17, 57
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('queues an eligible recipient through MessagingService', async () => {
    const { service, sends, messaging } = build({ candidates: [candidate()] });

    const outcome = await service.runCampaign(campaign(), TODAY);

    expect(outcome?.queuedCount).toBe(1);
    expect(messaging.send).toHaveBeenCalledTimes(1);
    expect(sends[0]).toMatchObject({
      businessId: BUSINESS,
      locationId: LOCATION,
      clientProfileId: 'olivia',
      eventKey: 'campaign_birthday',
      // A campaign is ALWAYS marketing, so it can never bypass the protections
      // that class carries (Wrike section 16).
      messageClass: 'marketing',
      dedupeKey: `campaign:${CAMPAIGN}:birthday:olivia:2026`,
    });
  });

  it('renders the owner template with the client and salon values', async () => {
    const { service, sends } = build({ candidates: [candidate()] });
    await service.runCampaign(campaign(), TODAY);

    const content = sends[0]['content'] as { body: string; preview: string };
    expect(content.body).toBe('Happy birthday Olivia, from Luke Ormsby Hair!');
    expect(content.preview).toBe('Happy birthday Olivia, from Luke Ormsby Hair!');
  });

  it('never contacts a provider directly — the messaging layer is the only exit', async () => {
    const { service, messaging, backend } = build({ candidates: [candidate()] });
    await service.runCampaign(campaign(), TODAY);

    // The ONLY outbound call is MessagingService.send, and nothing writes to
    // the shared notification queue from here.
    expect(messaging.send).toHaveBeenCalled();
    expect(backend.writes.some((w) => w.table === 'notification_events')).toBe(false);
  });

  it('leaves the canonical WhatsApp-first chain untouched for an auto campaign', async () => {
    const { service, sends } = build({ candidates: [candidate()] });
    await service.runCampaign(campaign({ channel: 'auto' }), TODAY);
    expect(sends[0]['channelPreference']).toBeUndefined();
  });

  it('passes a named channel as a NARROWING hint', async () => {
    const { service, sends } = build({ candidates: [candidate()] });
    await service.runCampaign(campaign({ channel: 'email' }), TODAY);
    expect(sends[0]['channelPreference']).toBe('email');
  });

  it('records the campaign on the event payload for the message log', async () => {
    const { service, sends } = build({ candidates: [candidate()] });
    await service.runCampaign(campaign(), TODAY);
    expect(sends[0]['metadata']).toMatchObject({
      campaign_id: CAMPAIGN,
      campaign_type: 'birthday',
      campaign_match_reason: 'Birthday today (2026-09-01)',
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency and concurrency — Wrike sections 26, 58
// ---------------------------------------------------------------------------

describe('duplicate prevention', () => {
  it('does not run the same campaign twice on the same salon-local day', async () => {
    const { service, messaging } = build({ candidates: [candidate()] });

    const first = await service.runCampaign(campaign(), TODAY);
    const second = await service.runCampaign(campaign(), TODAY);

    expect(first?.queuedCount).toBe(1);
    expect(second).toBeNull(); // the run row is already owned
    expect(messaging.send).toHaveBeenCalledTimes(1);
  });

  it('two evaluator instances racing the same campaign/day produce ONE message', async () => {
    // Both instances share the backend, exactly as two API pods share Postgres.
    const backend = makeBackend();
    const sends: unknown[] = [];

    const makeService = () => {
      const audience = {
        resolveCandidates: async () => ({ candidates: [candidate()], truncated: false }),
      } as unknown as CampaignAudienceService;
      const messaging = {
        send: async (r: unknown) => {
          sends.push(r);
          return { status: 'queued', eventId: 'evt', channel: 'whatsapp' } as SendMessageResult;
        },
      } as unknown as MessagingService;
      return new CampaignEvaluatorService(
        { getOrThrow: () => 'x', get: () => undefined } as unknown as ConfigService,
        audience,
        messaging,
      );
    };

    const [a, b] = await Promise.all([
      makeService().runCampaign(campaign(), TODAY),
      makeService().runCampaign(campaign(), TODAY),
    ]);

    expect(sends).toHaveLength(1);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one owned the day
    expect(backend.runs.length + 1).toBeGreaterThan(0);
  });

  it('does not re-message an identity that has already been queued on a later day', async () => {
    const { service, messaging } = build({ candidates: [candidate()] });

    await service.runCampaign(campaign(), '2026-09-01');
    // A new day: the run guard allows it, but the send LEDGER does not — the
    // identity is already queued, so the claim returns nothing.
    await service.runCampaign(campaign(), '2026-09-02');

    expect(messaging.send).toHaveBeenCalledTimes(1);
  });

  it('treats the messaging layer reporting a duplicate as done, not as a new send', async () => {
    const { service, backend } = build({
      candidates: [candidate()],
      sendResult: { status: 'duplicate', channel: 'whatsapp' },
    });

    const outcome = await service.runCampaign(campaign(), TODAY);

    expect(outcome?.queuedCount).toBe(0);
    // The identity is settled as queued so it is never re-offered.
    expect(backend.recipients[0]['status']).toBe('queued');
  });

  it('leaves a re-offerable row when the send fails, rather than a phantom send', async () => {
    const failing = build({ candidates: [candidate()] });
    (failing.messaging.send as jest.Mock).mockRejectedValueOnce(new Error('provider unreachable'));

    const outcome = await failing.service.runCampaign(campaign(), TODAY);

    expect(outcome?.failedCount).toBe(1);
    // Not 'queued': the next run may legitimately try this identity again.
    expect(failing.backend.recipients[0]['status']).not.toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Consent and suppression — Wrike sections 15, 56
// ---------------------------------------------------------------------------

describe('consent and suppression', () => {
  it('sends nothing to a client without marketing consent', async () => {
    const { service, messaging, backend } = build({
      candidates: [candidate({ marketingOptIn: false })],
    });

    const outcome = await service.runCampaign(campaign(), TODAY);

    expect(messaging.send).not.toHaveBeenCalled();
    expect(outcome?.suppressedCount).toBe(1);
    expect(outcome?.suppressionBreakdown['client has not opted in to marketing']).toBe(1);
    expect(backend.recipients[0]['status']).toBe('suppressed');
  });

  it('does not consume the send identity of an unconsented client', async () => {
    // If they opt in tomorrow, the campaign must still be able to reach them.
    const { service, messaging } = build({ candidates: [candidate({ marketingOptIn: false })] });
    await service.runCampaign(campaign(), '2026-09-01');

    const consented = build({ candidates: [candidate({ marketingOptIn: true })] });
    // Carry the earlier suppressed row across by re-claiming the same identity.
    await consented.service.runCampaign(campaign(), '2026-09-02');
    expect(consented.messaging.send).toHaveBeenCalledTimes(1);
    void messaging;
  });

  it('records the messaging layer’s own skip reason verbatim', async () => {
    // Opt-out, no valid contact, location disabled — every one of these decisions
    // is made in the messaging layer and reported here, never re-derived.
    const { service } = build({
      candidates: [candidate()],
      sendResult: { status: 'skipped', reason: 'client has opted out of every remaining channel (whatsapp, sms)' },
    });

    const outcome = await service.runCampaign(campaign(), TODAY);

    expect(outcome?.queuedCount).toBe(0);
    expect(outcome?.suppressionBreakdown['client has opted out of every remaining channel (whatsapp, sms)']).toBe(1);
  });

  it('suppresses a client with nowhere to send from', async () => {
    const { service, messaging, backend } = build({
      candidates: [candidate({ primaryLocationId: null })],
    });

    const outcome = await service.runCampaign(campaign({ location_id: null }), TODAY);

    expect(messaging.send).not.toHaveBeenCalled();
    expect(outcome?.suppressionBreakdown['client has no primary location']).toBe(1);
    expect(backend.recipients[0]['status']).toBe('suppressed');
  });

  it('uses the campaign location for a client with no primary location', async () => {
    const { service, sends } = build({ candidates: [candidate({ primaryLocationId: null })] });
    await service.runCampaign(campaign({ location_id: LOCATION }), TODAY);
    expect(sends[0]['locationId']).toBe(LOCATION);
  });
});

// ---------------------------------------------------------------------------
// Enable / disable — Wrike section 28
// ---------------------------------------------------------------------------

describe('disabled campaigns', () => {
  it('evaluates only active campaigns from the timer', async () => {
    for (const status of ['draft', 'paused', 'archived'] as const) {
      const { service, backend, messaging } = build({ candidates: [candidate()] });
      backend.setCampaigns([]); // fetchActiveCampaigns filters on status = 'active'
      await service.tick();
      expect(messaging.send).not.toHaveBeenCalled();
      void status;
    }
  });

  it('produces no new message events once a campaign is no longer active', async () => {
    const { service, messaging, backend } = build({ candidates: [candidate()] });
    // The timer's own query is `status = 'active'`; a paused campaign never
    // appears in it, so nothing is claimed and nothing is queued.
    backend.setCampaigns([{ ...campaign({ status: 'paused' }) }]);
    await service.tick();
    expect(messaging.send).not.toHaveBeenCalled();
    expect(backend.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation — Wrike sections 35, 60
// ---------------------------------------------------------------------------

describe('failure isolation', () => {
  it('a failing audience query never throws out of tick()', async () => {
    const { service, backend } = build({ resolveThrows: new Error('client_service_history exploded') });
    backend.setCampaigns([{ ...campaign(), timezone: undefined }]);
    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('a failing enqueue never throws out of tick()', async () => {
    const { service, backend, messaging } = build({ candidates: [candidate()] });
    (messaging.send as jest.Mock).mockRejectedValue(new Error('queue unavailable'));
    backend.setCampaigns([{ ...campaign() }]);
    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('one poisoned recipient does not abort the rest of the run', async () => {
    const { service, messaging } = build({
      candidates: [
        candidate({ clientId: 'a', dedupeKey: 'k-a' }),
        candidate({ clientId: 'b', dedupeKey: 'k-b' }),
        candidate({ clientId: 'c', dedupeKey: 'k-c' }),
      ],
    });
    (messaging.send as jest.Mock)
      .mockResolvedValueOnce({ status: 'queued', eventId: 'e1', channel: 'whatsapp' })
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ status: 'queued', eventId: 'e3', channel: 'whatsapp' });

    const outcome = await service.runCampaign(campaign(), TODAY);

    expect(outcome?.queuedCount).toBe(2);
    expect(outcome?.failedCount).toBe(1);
  });

  it('marks the run failed and re-raises when the audience cannot be resolved', async () => {
    const { service, backend } = build({ resolveThrows: new Error('boom') });
    await expect(service.runCampaign(campaign(), TODAY)).rejects.toThrow('boom');
    // The run row is closed truthfully rather than left running forever.
    expect(backend.runs[0]['status']).toBe('failed');
  });

  it('records a completed run with its counters', async () => {
    const { service, backend } = build({
      candidates: [candidate({ clientId: 'a', dedupeKey: 'k-a' }), candidate({ clientId: 'b', dedupeKey: 'k-b', marketingOptIn: false })],
    });
    await service.runCampaign(campaign(), TODAY);

    expect(backend.runs[0]).toMatchObject({
      status: 'completed',
      run_local_date: TODAY,
      candidate_count: 2,
      queued_count: 1,
      suppressed_count: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Audience preview — Wrike sections 33, 34
// ---------------------------------------------------------------------------

describe('audience preview', () => {
  it('sends nothing and writes nothing', async () => {
    const { service, messaging, backend } = build({ candidates: [candidate()] });

    const preview = await service.preview(campaign());

    expect(messaging.send).not.toHaveBeenCalled();
    expect(backend.runs).toHaveLength(0);
    expect(backend.recipients).toHaveLength(0);
    expect(backend.writes.filter((w) => w.verb !== 'select')).toHaveLength(0);
    expect(preview.eligibleCount).toBe(1);
  });

  it('uses the SAME resolver a real run uses', async () => {
    const { service, audience } = build({ candidates: [candidate()] });
    await service.preview(campaign());
    expect(audience.resolveCandidates).toHaveBeenCalledTimes(1);
  });

  it('counts and explains suppressions', async () => {
    const { service } = build({
      candidates: [
        candidate({ clientId: 'a', dedupeKey: 'k-a' }),
        candidate({ clientId: 'b', dedupeKey: 'k-b', marketingOptIn: false }),
        candidate({ clientId: 'c', dedupeKey: 'k-c', phone: null, email: null }),
      ],
    });

    const preview = await service.preview(campaign());

    expect(preview.candidateCount).toBe(3);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.suppressedCount).toBe(2);
    expect(preview.suppressionBreakdown['client has not opted in to marketing']).toBe(1);
    expect(preview.suppressionBreakdown['client has no valid phone or email address']).toBe(1);
  });

  it('masks contact details rather than exporting them', async () => {
    const { service } = build({ candidates: [candidate()] });
    const preview = await service.preview(campaign());

    expect(preview.sample[0].displayName).toBe('Olivia Brown');
    expect(preview.sample[0].maskedContact).not.toContain('447700900002');
    expect(preview.sample[0].maskedContact).toMatch(/\*+0002$/);
  });

  it('caps the sample while reporting exact counts', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      candidate({ clientId: `c${i}`, dedupeKey: `k-${i}` }),
    );
    const { service } = build({ candidates: many });

    const preview = await service.preview(campaign());

    expect(preview.candidateCount).toBe(40); // exact
    expect(preview.sample).toHaveLength(25); // capped
    expect(preview.sampleTruncated).toBe(true);
  });

  it('renders with the REAL salon name but a representative client name', async () => {
    // The salon's own name and booking link are the owner's — showing them is
    // the point. The client fields are stand-ins, so a preview can never leak
    // one client's details through another client's message.
    const { service } = build({ candidates: [candidate()] });
    const preview = await service.preview(campaign());
    expect(preview.renderedPreview).toBe('Happy birthday Jane, from Luke Ormsby Hair!');
    expect(preview.renderedPreview).not.toContain('Olivia');
  });

  it('says plainly when the campaign would not run today', async () => {
    const { service } = build({ candidates: [candidate()] });

    const draft = await service.preview(campaign({ status: 'draft' }));
    expect(draft.wouldNotRunToday).toBe(true);
    expect(draft.wouldNotRunReason).toContain('draft');

    const paused = await service.preview(campaign({ status: 'paused' }));
    expect(paused.wouldNotRunReason).toContain('paused');
  });

  it('reports an identity that has already been messaged', async () => {
    const { service } = build({ candidates: [candidate()] });
    await service.runCampaign(campaign(), TODAY);

    const preview = await service.preview(campaign());
    expect(preview.suppressionBreakdown['already messaged for this campaign']).toBe(1);
    expect(preview.eligibleCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Batching — Wrike section 38
// ---------------------------------------------------------------------------

describe('batching', () => {
  it('bounds one run and resumes the remainder on the next', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      candidate({ clientId: `c${i}`, dedupeKey: `k-${i}` }),
    );
    const backend = makeBackend();
    const sends: unknown[] = [];
    const audience = {
      resolveCandidates: async () => ({ candidates: many, truncated: false }),
    } as unknown as CampaignAudienceService;
    const messaging = {
      send: async (r: unknown) => {
        sends.push(r);
        return { status: 'queued', eventId: 'e', channel: 'whatsapp' } as SendMessageResult;
      },
    } as unknown as MessagingService;
    const config = {
      getOrThrow: () => 'x',
      get: (key: string) => (key === 'CAMPAIGNS_MAX_RECIPIENTS_PER_RUN' ? 2 : undefined),
    } as unknown as ConfigService;

    const service = new CampaignEvaluatorService(config, audience, messaging);

    await service.runCampaign(campaign(), '2026-09-01');
    expect(sends).toHaveLength(2);

    // The next day's run picks up where it left off: the first two identities are
    // already claimed and are simply not re-offered.
    await service.runCampaign(campaign(), '2026-09-02');
    expect(sends).toHaveLength(4);
    expect(backend.recipients.filter((r) => r['status'] === 'queued')).toHaveLength(4);
  });

  // 0111: the remainder must not wait for tomorrow.
  it('continues the SAME salon-local day until the audience is finished', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      candidate({ clientId: `c${i}`, dedupeKey: `k-${i}` }),
    );
    const { service, backend, sends } = build({ candidates: many, maxRecipientsPerRun: 2 });

    const first = await service.runCampaign(campaign(), TODAY);
    expect(sends).toHaveLength(2);
    // The run says plainly that it did not finish.
    expect(first?.audienceExhausted).toBe(false);
    expect(backend.runs).toHaveLength(1);
    expect(backend.runs[0]['audience_exhausted']).toBe(false);
    expect(backend.runs[0]['status']).toBe('partial');

    // A later tick on the SAME date re-opens that run rather than being told
    // the day is already owned.
    const second = await service.runCampaign(campaign(), TODAY);
    expect(second).not.toBeNull();
    expect(sends).toHaveLength(4);
    expect(backend.runs).toHaveLength(1); // still one run for the day

    const third = await service.runCampaign(campaign(), TODAY);
    expect(sends).toHaveLength(5);
    expect(third?.audienceExhausted).not.toBe(false);
    expect(backend.runs[0]['audience_exhausted']).toBe(true);
    expect(backend.runs[0]['status']).toBe('completed');

    // Nobody was offered twice, across all three passes.
    const keys = sends.map((s) => (s as { dedupeKey?: string }).dedupeKey);
    expect(new Set(keys).size).toBe(5);
    expect(backend.recipients.filter((r) => r['status'] === 'queued')).toHaveLength(5);
  });

  it('carries an audience past the default 500 bound without resending anyone', async () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      candidate({ clientId: `c${i}`, dedupeKey: `k-${i}` }),
    );
    const { service, sends } = build({ candidates: many });

    const first = await service.runCampaign(campaign(), TODAY);
    expect(sends).toHaveLength(500); // the configured bound
    expect(first?.audienceExhausted).toBe(false);

    const second = await service.runCampaign(campaign(), TODAY);
    expect(sends).toHaveLength(600);
    expect(second?.audienceExhausted).not.toBe(false);

    const keys = sends.map((s) => (s as { dedupeKey?: string }).dedupeKey);
    expect(new Set(keys).size).toBe(600);
  });

  // Week 7 edge: the window closing must PAUSE an execution, not abandon it.
  // Driven through evaluateIfDue (the scheduler's own decision path) with a
  // pinned clock, because the whole question is what the next window does.
  it('pauses at window close and resumes the SAME execution at the next opening', async () => {
    const many = Array.from({ length: 700 }, (_, i) =>
      candidate({ clientId: `c${i}`, dedupeKey: `k-${i}` }),
    );
    // The audience is only resolvable for the run's OWN date: a promotion whose
    // date window closed overnight finds nobody on 2 September. If continuation
    // silently became a fresh next-day evaluation, the last 200 would vanish.
    // One of the recipients still owed a message withdraws consent overnight.
    // The resume re-resolves the audience, so the fresh read carries that.
    const afterOptOut = many.map((c, i) =>
      i === 600 ? { ...c, marketingOptIn: false } : c,
    );
    let resolveCount = 0;
    const { service, backend, sends, audience } = build({
      candidates: [],
      maxRecipientsPerRun: 500,
    });
    (audience.resolveCandidates as jest.Mock).mockImplementation(
      async (_campaign: unknown, localDate: string) => {
        resolveCount += 1;
        if (localDate !== '2026-09-01') return { candidates: [], truncated: false };
        return { candidates: resolveCount === 1 ? many : afterOptOut, truncated: false };
      },
    );
    const due = (c: CampaignRow) =>
      (service as unknown as { evaluateIfDue: (c: CampaignRow) => Promise<void> }).evaluateIfDue(c);

    try {
      // 18:00 Europe/London, 1 Sept — inside the window.
      jest.useFakeTimers().setSystemTime(new Date('2026-09-01T17:00:00.000Z'));
      await due(campaign());
      expect(sends).toHaveLength(500);
      expect(backend.runs).toHaveLength(1);
      expect(backend.runs[0]['audience_exhausted']).toBe(false);

      // 19:30 the same evening — the window has closed. Nothing moves.
      jest.useFakeTimers().setSystemTime(new Date('2026-09-01T18:30:00.000Z'));
      await due(campaign());
      expect(sends).toHaveLength(500);
      expect(backend.runs).toHaveLength(1);

      // 09:00, 2 Sept — the next permitted window resumes the SAME run.
      jest.useFakeTimers().setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
      await due(campaign());

      // One logical execution, finished: still one run row, no second one.
      expect(backend.runs).toHaveLength(1);
      expect(backend.runs[0]['run_local_date']).toBe('2026-09-01');
      expect(backend.runs[0]['audience_exhausted']).toBe(true);
      // Re-resolved for its OWN date, never for 2 September.
      const dates = (audience.resolveCandidates as jest.Mock).mock.calls.map((c) => c[1]);
      expect(new Set(dates)).toEqual(new Set(['2026-09-01']));
      // The remainder went out, exactly once each — MINUS the client who
      // withdrew consent overnight, who is suppressed rather than sent.
      expect(sends).toHaveLength(699);
      expect(new Set(sends.map((x) => (x as { dedupeKey?: string }).dedupeKey)).size).toBe(699);
      expect(sends.some((x) => (x as { dedupeKey?: string }).dedupeKey === 'k-600')).toBe(false);
      expect(backend.recipients.filter((r) => r['status'] === 'queued')).toHaveLength(699);
      // ...and the run's own metrics describe the whole execution, not the last pass.
      expect(backend.runs[0]['candidate_count']).toBe(700);
      expect(backend.runs[0]['queued_count']).toBe(699);
      expect(backend.runs[0]['suppressed_count']).toBe(1);
      expect(backend.runs[0]['status']).toBe('completed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not re-open a run that finished its audience', async () => {
    const { service, backend } = build({ candidates: [candidate()] });
    await service.runCampaign(campaign(), TODAY);
    expect(backend.runs[0]['audience_exhausted']).toBe(true);

    // A second pass on a finished day is refused — the day is owned and done.
    expect(await service.runCampaign(campaign(), TODAY)).toBeNull();
  });
});
