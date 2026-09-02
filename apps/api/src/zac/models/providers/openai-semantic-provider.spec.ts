/**
 * The OpenAI semantic provider contract: strict Structured Outputs on the
 * Responses API, question privacy (byte-identical in the user block, never in
 * instructions, never logged), usage → completion mapping including the
 * cached-token overlap, and the FULL failure taxonomy — a provider failure
 * must come back as a typed code, never as a throw and never as anything that
 * could be mistaken for "your business data is unavailable".
 * The SDK is mocked — no network, no key.
 */

import type { ConfigService } from '@nestjs/config';
import { OpenAiSemanticProvider } from './openai-semantic-provider';
import {
  ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA,
  ZAC_SEMANTIC_ROUTER_SYSTEM_PROMPT_V2,
  ZAC_SEMANTIC_ROUTER_V2_FORMAT_NAME,
} from '../../routing/zac-semantic-router.prompt';

const createMock = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ responses: { create: createMock } })),
}));

const ENV: Record<string, string | undefined> = {
  OPENAI_API_KEY: 'test-openai-key',
  ZAC_SEMANTIC_PRICE_INPUT_USD_PER_MTOK: '0.25',
  ZAC_SEMANTIC_PRICE_OUTPUT_USD_PER_MTOK: '2',
  ZAC_SEMANTIC_PRICE_CACHE_READ_USD_PER_MTOK: '0.025',
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

const VALID_ROUTE = {
  mode: 'qlooqo_data',
  analysis_intent: 'business_priorities',
  information_source: 'live_qlooqo',
  confidence: 'high',
  requires_live_business_data: true,
  reason_code: 'real_business_analysis',
  resource_category: 'live_business_metrics',
};

function apiResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5-mini-2025-08-07',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(VALID_ROUTE) }],
      },
    ],
    output_text: JSON.stringify(VALID_ROUTE),
    usage: {
      input_tokens: 3000,
      input_tokens_details: { cached_tokens: 2500 },
      output_tokens: 60,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3060,
    },
    ...overrides,
  };
}

function apiError(status: number, message: string, code?: string) {
  const error = new Error(message) as Error & { status: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

const INPUT = {
  // Deliberately NOT one of the prompt's worked examples, so the
  // question-never-in-instructions assertion below is meaningful.
  question: 'giv me the three things that most need sorting before payday',
  roleContext: 'owner' as const,
};

describe('OpenAiSemanticProvider', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('identifies as the openai provider on the configured model', () => {
    const provider = new OpenAiSemanticProvider(makeConfig());
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('gpt-5-mini');
    expect(
      new OpenAiSemanticProvider(makeConfig({ ...ENV, ZAC_SEMANTIC_MODEL: 'gpt-5-nano' })).model,
    ).toBe('gpt-5-nano');
  });

  it('refuses to construct without a key — the factory owns that gate', () => {
    expect(() => new OpenAiSemanticProvider(makeConfig({}))).toThrow(/OPENAI_API_KEY/);
  });

  it('sends the strict v2 structured-output request with the question byte-identical', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new OpenAiSemanticProvider(makeConfig());
    const outcome = await provider.classify(INPUT);

    expect(outcome.failure).toBeNull();
    expect(outcome.raw).toEqual(VALID_ROUTE);

    const params = createMock.mock.calls[0][0];
    // Strict Structured Outputs, on the closed v2 schema, by name.
    expect(params.text.format).toEqual({
      type: 'json_schema',
      name: ZAC_SEMANTIC_ROUTER_V2_FORMAT_NAME,
      schema: ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA,
      strict: true,
    });
    // The stable prompt is the instructions block; the question rides ONLY in
    // the user block, byte-identical (the offline oracle keys on it).
    expect(params.instructions).toBe(ZAC_SEMANTIC_ROUTER_SYSTEM_PROMPT_V2);
    expect(params.instructions).not.toContain(INPUT.question);
    expect(params.input).toHaveLength(1);
    expect(params.input[0].content).toContain(INPUT.question);
    // The question must not persist server-side.
    expect(params.store).toBe(false);
    // gpt-5-mini is reasoning-capable: minimal effort, off the critical path.
    expect(params.reasoning).toEqual({ effort: 'minimal' });
  });

  it('omits the reasoning parameter for models that reject it', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new OpenAiSemanticProvider(
      makeConfig({ ...ENV, ZAC_SEMANTIC_MODEL: 'gpt-4.1-mini' }),
    );
    await provider.classify(INPUT);
    expect(createMock.mock.calls[0][0].reasoning).toBeUndefined();
  });

  it('maps usage honestly: cached tokens come OUT of input tokens, never doubled', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new OpenAiSemanticProvider(makeConfig());
    const outcome = await provider.classify(INPUT);

    const completion = outcome.completion!;
    expect(completion.provider).toBe('openai');
    expect(completion.model).toBe('gpt-5-mini-2025-08-07');
    // 3000 reported input, 2500 cached → 500 uncached + 2500 cache reads.
    expect(completion.inputTokens).toBe(500);
    expect(completion.cacheReadInputTokens).toBe(2500);
    expect(completion.outputTokens).toBe(60);
    // 500×0.25 + 60×2 + 2500×0.025 per MTok.
    expect(completion.estimatedCostUsd).toBeCloseTo(
      (500 * 0.25 + 60 * 2 + 2500 * 0.025) / 1_000_000,
      12,
    );
  });

  it('estimates $0 with a warning when unpriced, rather than borrowing Anthropic rates', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new OpenAiSemanticProvider(makeConfig({ OPENAI_API_KEY: 'k' }));
    const outcome = await provider.classify(INPUT);
    expect(outcome.completion!.estimatedCostUsd).toBe(0);
  });

  it('returns classification_refused on a refusal output item, with the billed usage', async () => {
    createMock.mockResolvedValue(
      apiResponse({
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'declined' }] },
        ],
        output_text: '',
      }),
    );
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.raw).toBeNull();
    expect(outcome.failure).toBe('classification_refused');
    expect(outcome.completion).not.toBeNull();
  });

  it('returns classification_invalid when the response is incomplete (token cap)', async () => {
    createMock.mockResolvedValue(
      apiResponse({ status: 'incomplete', output_text: '{"mode":"qlo' }),
    );
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.raw).toBeNull();
    expect(outcome.failure).toBe('classification_invalid');
    expect(outcome.completion).not.toBeNull();
  });

  it('returns classification_invalid on unparseable or non-object output', async () => {
    for (const text of ['not json at all', '"a string"', '[1,2]']) {
      createMock.mockResolvedValue(apiResponse({ output_text: text }));
      const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
      expect(outcome.raw).toBeNull();
      expect(outcome.failure).toBe('classification_invalid');
      expect(outcome.failureKind).toBe('invalid_output');
    }
  });

  it('never throws: 400 schema rejection → provider_unavailable with failureKind schema', async () => {
    createMock.mockRejectedValue(
      apiError(400, "Invalid schema for response_format 'zac_semantic_route'"),
    );
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.raw).toBeNull();
    expect(outcome.failure).toBe('provider_unavailable');
    expect(outcome.failureKind).toBe('schema');
    expect(outcome.completion).toBeNull();
  });

  it('classifies auth failure (401) so health can degrade hard', async () => {
    createMock.mockRejectedValue(apiError(401, 'Incorrect API key provided'));
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.failure).toBe('provider_unavailable');
    expect(outcome.failureKind).toBe('auth');
  });

  it('classifies quota exhaustion (429 insufficient_quota) as credit, NOT rate limit', async () => {
    createMock.mockRejectedValue(
      apiError(429, 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota'),
    );
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.failure).toBe('provider_unavailable');
    expect(outcome.failureKind).toBe('credit');
  });

  it('classifies a genuine rate limit (429) as rate_limit', async () => {
    createMock.mockRejectedValue(apiError(429, 'Rate limit reached for gpt-5-mini'));
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.failureKind).toBe('rate_limit');
  });

  it('reports a timeout as classification_timeout — a distinct, user-inducible failure', async () => {
    createMock.mockRejectedValue(new Error('Request timed out.'));
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.raw).toBeNull();
    expect(outcome.failure).toBe('classification_timeout');
    expect(outcome.failureKind).toBe('timeout');
  });

  it('reports a network fault as provider_unavailable/transport', async () => {
    createMock.mockRejectedValue(new Error('Connection error.'));
    const outcome = await new OpenAiSemanticProvider(makeConfig()).classify(INPUT);
    expect(outcome.failure).toBe('provider_unavailable');
    expect(outcome.failureKind).toBe('transport');
  });

  it('never logs the question or the key on failure', async () => {
    const warnings: string[] = [];
    createMock.mockRejectedValue(apiError(400, 'bad request'));
    const provider = new OpenAiSemanticProvider(makeConfig());
    const logger = (provider as unknown as { logger: { warn: (m: string) => void } }).logger;
    jest.spyOn(logger, 'warn').mockImplementation((message: string) => {
      warnings.push(message);
    });
    await provider.classify(INPUT);
    expect(warnings.length).toBeGreaterThan(0);
    for (const message of warnings) {
      expect(message).not.toContain(INPUT.question);
      expect(message).not.toContain('test-openai-key');
    }
  });
});
