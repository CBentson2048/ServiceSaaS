/**
 * The OpenAI reasoning + synthesis adapter contract.
 *
 * These are the two capabilities OpenAI had no implementation for, which is
 * what made `ZAC_AI_PROVIDER=openai` — and therefore a like-for-like provider
 * benchmark — impossible. The cases mirror the Anthropic adapter's, because the
 * point of the port is that both vendors answer the SAME contract: structured
 * output, usage/cost normalisation, the full failure taxonomy, and a refusal or
 * truncation that still bills.
 *
 * The SDK is mocked — no network, no key.
 */

import type { ConfigService } from '@nestjs/config';
import { OpenAiZacProvider } from './openai-zac-provider';
import {
  ZAC_ANALYSIS_PLANNER_FORMAT_NAME,
  ZAC_ANALYSIS_PLANNER_OPENAI_SCHEMA,
} from '../../analysis/zac-analysis-planner.prompt';
import {
  ZAC_PRIORITY_SYNTHESIS_FORMAT_NAME,
  ZAC_PRIORITY_SYNTHESIS_OPENAI_SCHEMA,
} from '../../analysis/zac-priority-synthesis.prompt';
import { findStrictSchemaViolations } from '../zac-semantic-health.service';
import { ZacModelIncompleteError, ZacModelRefusedError } from '../zac-model-provider.interface';
import type {
  ZacAnalysisPlanInput,
  ZacModelRequest,
  ZacPrioritySynthesisInput,
} from '../zac-model-provider.interface';

const createMock = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ responses: { create: createMock } })),
}));

const ENV: Record<string, string | undefined> = {
  OPENAI_API_KEY: 'test-openai-key',
  ZAC_PRICE_INPUT_USD_PER_MTOK: '1.25',
  ZAC_PRICE_OUTPUT_USD_PER_MTOK: '10',
  ZAC_SEMANTIC_PRICE_INPUT_USD_PER_MTOK: '0.25',
  ZAC_SEMANTIC_PRICE_OUTPUT_USD_PER_MTOK: '2',
};

function makeConfig(env: Record<string, string | undefined> = ENV): ConfigService {
  return {
    get: jest.fn((key: string) => env[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = env[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
}

function apiResponse(text: string, overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5.6-luna-2026-08-01',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    output_text: text,
    usage: {
      input_tokens: 1200,
      output_tokens: 90,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens_details: { reasoning_tokens: 40 },
    },
    ...overrides,
  };
}

const PLAN_INPUT: ZacAnalysisPlanInput = {
  question: 'What are my two biggest problems?',
  roleContext: 'owner',
  catalogue: [
    { name: 'report.business_health', purpose: 'Overall trading', domains: ['business_health'] },
    { name: 'report.rebooking_summary', purpose: 'Rebooking', domains: ['rebooking'] },
  ],
};

const VALID_PLAN = JSON.stringify({
  analysis_intent: 'business_priorities',
  reason_code: 'business_priority_request',
  confidence: 'high',
  synthesis_strategy: 'rank_business_priorities',
  tools: [{ tool_name: 'report.business_health', purpose: 'baseline' }],
});

const SYNTHESIS_INPUT: ZacPrioritySynthesisInput = {
  question: 'What are my two biggest problems?',
  roleContext: 'owner',
  requestedCount: 2,
  candidates: [
    {
      id: 'cand_rebooking',
      title: 'Rebooking',
      headline: 'Rebooking is 34%.',
      severity: 'attention',
      supporting: [],
      targetSource: null,
    },
  ],
  limitations: [],
  unassessedAreas: [],
};

const NARRATION_REQUEST: ZacModelRequest = {
  question: 'How is my rebooking?',
  roleContext: 'owner',
  systemPromptSeed: 'You are speaking to the salon owner.',
  availableToolNames: ['report.rebooking_summary'],
  evidencePack: {
    toolName: 'report.rebooking_summary',
    toolAnswer: 'Your rebooking rate over the last 7 days was 34%.',
    evidence: [
      {
        source_type: 'report.dashboard',
        source_ref: 'DashboardService.kpis',
        as_of: null,
        entities_used: [],
      },
    ],
    limitations: ['Rebooking is a lower bound.'],
  },
};

beforeEach(() => createMock.mockReset());

// ===========================================================================

describe('the strict schemas this adapter sends', () => {
  it('pass the same boot-time allowlist the router schema does', () => {
    // The last silent 400 ran for weeks because a schema carried a keyword the
    // API rejects. Both new schemas are held to the same allowlist.
    expect(findStrictSchemaViolations('planner', ZAC_ANALYSIS_PLANNER_OPENAI_SCHEMA)).toEqual([]);
    expect(findStrictSchemaViolations('synthesis', ZAC_PRIORITY_SYNTHESIS_OPENAI_SCHEMA)).toEqual(
      [],
    );
  });

  it('carry no numeric type — strict mode rejects them outright', () => {
    const json = JSON.stringify([
      ZAC_ANALYSIS_PLANNER_OPENAI_SCHEMA,
      ZAC_PRIORITY_SYNTHESIS_OPENAI_SCHEMA,
    ]);
    expect(json).not.toContain('"number"');
    expect(json).not.toContain('"integer"');
  });
});

describe('tool planning', () => {
  it('sends the ZAC-owned schema through the Responses structured-output format', async () => {
    createMock.mockResolvedValue(apiResponse(VALID_PLAN));
    const provider = new OpenAiZacProvider(makeConfig());

    const outcome = await provider.planAnalysis(PLAN_INPUT);

    const call = createMock.mock.calls[0][0];
    expect(call.text.format.type).toBe('json_schema');
    expect(call.text.format.name).toBe(ZAC_ANALYSIS_PLANNER_FORMAT_NAME);
    expect(call.text.format.strict).toBe(true);
    // The question must not persist in the provider's stored-response surface.
    expect(call.store).toBe(false);
    expect(outcome.failure).toBeNull();
    expect(outcome.raw).toMatchObject({ analysis_intent: 'business_priorities' });
  });

  it('maps the confidence BUCKET back to the number the server contract expects', async () => {
    // Strict mode cannot express a number, so the wire carries a bucket. If the
    // adapter did not map it back, every plan would arrive with a non-numeric
    // confidence and the planner's confidence policy would silently stop working.
    createMock.mockResolvedValue(apiResponse(VALID_PLAN));
    const provider = new OpenAiZacProvider(makeConfig());

    const outcome = await provider.planAnalysis(PLAN_INPUT);
    expect(typeof outcome.raw?.confidence).toBe('number');
    expect(outcome.raw?.confidence).toBeGreaterThan(0.5);
  });

  it('never leaks identity, scope or the key into the request', async () => {
    createMock.mockResolvedValue(apiResponse(VALID_PLAN));
    const provider = new OpenAiZacProvider(makeConfig());
    await provider.planAnalysis(PLAN_INPUT);

    const call = createMock.mock.calls[0][0];
    const sent = JSON.stringify(call);
    expect(sent).not.toContain('test-openai-key');

    // The planner's user block is the ROLE LENS, the permitted source list and
    // the question — nothing else. Asserting its exact shape is stronger than
    // grepping for forbidden words: the shared prompt legitimately mentions
    // permissions ("the server applies permissions..."), and a substring test
    // would either fail on that or be satisfied by a leak that used a different
    // word for the same thing.
    const userBlock: string = call.input[0].content;
    expect(userBlock.startsWith('Role lens: owner')).toBe(true);
    expect(userBlock).toContain('<request>What are my two biggest problems?</request>');
    for (const line of userBlock.split('\n')) {
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // no uuid of any kind
    }
    // The catalogue is names and purposes; no actor, business or location id.
    expect(userBlock).not.toMatch(/user|actor|business id|location id|staff_profile/i);
  });
});

describe('priority synthesis', () => {
  it('returns validated raw output against the ZAC synthesis format', async () => {
    const body = JSON.stringify({
      preamble: 'Two things stand out.',
      priorities: [{ candidate_id: 'cand_rebooking', explanation: 'It is 34%.', action: 'Coach.' }],
    });
    createMock.mockResolvedValue(apiResponse(body));
    const provider = new OpenAiZacProvider(makeConfig());

    const outcome = await provider.synthesisePriorities(SYNTHESIS_INPUT);

    expect(createMock.mock.calls[0][0].text.format.name).toBe(ZAC_PRIORITY_SYNTHESIS_FORMAT_NAME);
    expect(outcome.failure).toBeNull();
    expect(outcome.raw).toMatchObject({ preamble: 'Two things stand out.' });
  });
});

describe('the failure taxonomy — a reasoning failure is never a data failure', () => {
  const cases: Array<[string, unknown, string]> = [
    ['a timeout', { name: 'APIConnectionTimeoutError' }, 'classification_timeout'],
    ['auth', { name: 'AuthenticationError', status: 401 }, 'provider_unavailable'],
    ['quota', { name: 'RateLimitError', status: 429, message: 'insufficient_quota' }, 'provider_unavailable'],
    ['a rejected schema', { name: 'BadRequestError', status: 400 }, 'provider_unavailable'],
    ['transport', { name: 'APIConnectionError' }, 'provider_unavailable'],
  ];

  it.each(cases)('returns a typed outcome for %s rather than throwing', async (_l, error, failure) => {
    createMock.mockRejectedValue(error);
    const provider = new OpenAiZacProvider(makeConfig());

    const outcome = await provider.planAnalysis(PLAN_INPUT);
    expect(outcome.failure).toBe(failure);
    expect(outcome.raw).toBeNull();
    // The deterministic plan is the degradation mode; nothing here may throw,
    // because a thrown reasoning failure would surface as a broken turn.
    expect(outcome.failureKind).toBeDefined();
  });

  it('reports malformed structured output as invalid, not unavailable', async () => {
    // Different facts: the provider answered, and its answer was unusable.
    createMock.mockResolvedValue(apiResponse('{"analysis_intent": '));
    const provider = new OpenAiZacProvider(makeConfig());

    const outcome = await provider.planAnalysis(PLAN_INPUT);
    expect(outcome.failure).toBe('classification_invalid');
    expect(outcome.failureKind).toBe('invalid_output');
  });

  it('treats a refusal and a truncation as failures that still BILLED', async () => {
    createMock.mockResolvedValue(
      apiResponse('', { output: [{ type: 'message', content: [{ type: 'refusal' }] }] }),
    );
    const provider = new OpenAiZacProvider(makeConfig());
    const refused = await provider.planAnalysis(PLAN_INPUT);
    expect(refused.failure).toBe('classification_refused');
    expect(refused.completion?.inputTokens).toBeGreaterThan(0);

    createMock.mockResolvedValue(apiResponse('{"partial":', { status: 'incomplete' }));
    const truncated = await provider.planAnalysis(PLAN_INPUT);
    expect(truncated.failure).toBe('classification_invalid');
    expect(truncated.completion?.outputTokens).toBeGreaterThan(0);
  });
});

describe('answer synthesis', () => {
  it('sends the SHARED ZAC constitution as instructions and the evidence as input', async () => {
    createMock.mockResolvedValue(apiResponse('Your rebooking rate was 34% over the last 7 days.'));
    const provider = new OpenAiZacProvider(makeConfig());

    const completion = await provider.generate(NARRATION_REQUEST);

    const call = createMock.mock.calls[0][0];
    // The same task semantics both vendors get — not an OpenAI-specific
    // constitution, which would make a provider comparison meaningless.
    expect(call.instructions).toContain('You narrate verified figures');
    expect(call.instructions).toContain('You are speaking to the salon owner.');
    expect(call.input[0].content).toContain('Your rebooking rate over the last 7 days was 34%.');
    // The question rides fenced as data, exactly as the Anthropic adapter sends it.
    expect(call.input[0].content).toContain('<question>How is my rebooking?</question>');
    expect(completion.text).toContain('34%');
  });

  it('normalises usage, separating cached reads from fresh input tokens', async () => {
    createMock.mockResolvedValue(apiResponse('Answer.'));
    const provider = new OpenAiZacProvider(makeConfig());

    const completion = await provider.generate(NARRATION_REQUEST);

    // input_tokens is the TOTAL including cached reads; reporting it whole
    // would bill 1200 tokens at the full rate when 1000 were cache reads.
    expect(completion.inputTokens).toBe(200);
    expect(completion.cacheReadInputTokens).toBe(1000);
    expect(completion.outputTokens).toBe(90);
    expect(completion.reasoningTokens).toBe(40);
    expect(completion.provider).toBe('openai');
    expect(completion.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('throws a refusal that still carries its billed usage', async () => {
    createMock.mockResolvedValue(
      apiResponse('', { output: [{ type: 'message', content: [{ type: 'refusal' }] }] }),
    );
    const provider = new OpenAiZacProvider(makeConfig());

    // The orchestrator serves the deterministic answer AND records the cost —
    // a refusal is billed, so swallowing it would under-report spend.
    await expect(provider.generate(NARRATION_REQUEST)).rejects.toBeInstanceOf(ZacModelRefusedError);
  });

  it('throws an incomplete error on a truncated narration', async () => {
    createMock.mockResolvedValue(apiResponse('Your rebooking rate was', { status: 'incomplete' }));
    const provider = new OpenAiZacProvider(makeConfig());
    await expect(provider.generate(NARRATION_REQUEST)).rejects.toBeInstanceOf(
      ZacModelIncompleteError,
    );
  });

  it('treats an empty answer as unusable rather than serving silence', async () => {
    createMock.mockResolvedValue(apiResponse(''));
    const provider = new OpenAiZacProvider(makeConfig());
    await expect(provider.generate(NARRATION_REQUEST)).rejects.toBeInstanceOf(
      ZacModelIncompleteError,
    );
  });
});

describe('capability declaration', () => {
  it('declares exactly the capabilities it implements', () => {
    const provider = new OpenAiZacProvider(makeConfig());
    expect([...provider.capabilities].sort()).toEqual([
      'answer_synthesis',
      'structured_reasoning',
      'tool_planning',
    ]);
    expect(provider.providerId).toBe('openai');
    // Semantic routing is deliberately absent: it lives in the dedicated
    // OpenAiSemanticProvider, which is a separate, already-benchmarked path.
    expect(provider.capabilities).not.toContain('semantic_routing');
  });

  it('keeps reasoning and synthesis models independently configurable', () => {
    const provider = new OpenAiZacProvider(
      makeConfig({
        ...ENV,
        ZAC_OPENAI_REASONING_MODEL: 'gpt-5-mini',
        ZAC_OPENAI_SYNTHESIS_MODEL: 'gpt-5.6-luna',
      }),
    );
    expect(provider.reasoningModel).toBe('gpt-5-mini');
    expect(provider.model).toBe('gpt-5.6-luna');
  });
});
