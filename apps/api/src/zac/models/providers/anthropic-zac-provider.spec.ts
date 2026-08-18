/**
 * The Anthropic provider contract: prompt assembly (question NEVER in the
 * cached system prefix), usage → completion mapping, config-driven pricing
 * (D33), and the refusal path. The SDK is mocked — no network, no key.
 */

import type { ConfigService } from '@nestjs/config';
import { AnthropicZacModelProvider } from './anthropic-zac-provider';
import {
  ZacModelIncompleteError,
  ZacModelRefusedError,
} from '../zac-model-provider.interface';
import type { ZacModelRequest } from '../zac-model-provider.interface';

const createMock = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: createMock } })),
}));

const ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: 'test-key',
  ZAC_PRICE_INPUT_USD_PER_MTOK: '5',
  ZAC_PRICE_OUTPUT_USD_PER_MTOK: '25',
  ZAC_PRICE_CACHE_READ_USD_PER_MTOK: '0.5',
  ZAC_PRICE_CACHE_WRITE_USD_PER_MTOK: '6.25',
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

function makeRequest(overrides: Partial<ZacModelRequest> = {}): ZacModelRequest {
  return {
    question: 'How is my business doing?',
    roleContext: 'owner',
    systemPromptSeed: 'You are ZAC, answering for the business owner.',
    availableToolNames: ['report.business_health', 'context.capabilities'],
    evidencePack: {
      toolName: 'report.business_health',
      toolAnswer: 'This week the salon took £1250.00 with a 39% rebooking rate.',
      evidence: [
        {
          source_type: 'report.dashboard',
          source_ref: 'dashboard.kpis',
          as_of: '2026-07-28T00:00:00.000Z',
          entities_used: [],
        },
      ],
      limitations: ['Revenue and activity health only — not a profit view.'],
    },
    ...overrides,
  };
}

function apiResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Your salon took £1250.00 this week.' }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    },
    ...overrides,
  };
}

describe('AnthropicZacModelProvider', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('is a narrating provider with the default model', () => {
    const provider = new AnthropicZacModelProvider(makeConfig());
    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-opus-5');
    expect(provider.narrates).toBe(true);
  });

  it('honours a ZAC_MODEL_ID override', () => {
    const provider = new AnthropicZacModelProvider(
      makeConfig({ ...ENV, ZAC_MODEL_ID: 'claude-sonnet-5' }),
    );
    expect(provider.model).toBe('claude-sonnet-5');
  });

  it('maps usage and configured prices into the completion', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new AnthropicZacModelProvider(makeConfig());

    const completion = await provider.complete(makeRequest());

    expect(completion).toMatchObject({
      text: 'Your salon took £1250.00 this week.',
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 10,
    });
    // (100×5 + 50×25 + 40×0.5 + 10×6.25) / 1M
    expect(completion.estimatedCostUsd).toBeCloseTo(0.0018325, 10);
  });

  it('derives cache prices from the input price when unset', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new AnthropicZacModelProvider(
      makeConfig({
        ANTHROPIC_API_KEY: 'test-key',
        ZAC_PRICE_INPUT_USD_PER_MTOK: '5',
        ZAC_PRICE_OUTPUT_USD_PER_MTOK: '25',
      }),
    );

    const completion = await provider.complete(makeRequest());
    // read = 0.1×5, write = 1.25×5 — same totals as the explicit config above.
    expect(completion.estimatedCostUsd).toBeCloseTo(0.0018325, 10);
  });

  it('keeps the question OUT of the cached system prefix and IN the user turn', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new AnthropicZacModelProvider(makeConfig());
    const request = makeRequest();

    await provider.complete(request);

    const params = createMock.mock.calls[0][0];
    const systemBlock = params.system[0];
    expect(systemBlock.cache_control).toEqual({ type: 'ephemeral' });
    expect(systemBlock.text).toContain(request.systemPromptSeed);
    expect(systemBlock.text).toContain('report.business_health');
    expect(systemBlock.text).not.toContain(request.question);

    const userMessage = params.messages[0];
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toContain(request.question);
    expect(userMessage.content).toContain('£1250.00');
    expect(userMessage.content).toContain('not a profit view');
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(8192);
    expect(params.output_config).toEqual({ effort: 'medium' });
  });

  it('states the no-evidence case honestly instead of inventing a block', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new AnthropicZacModelProvider(makeConfig());

    await provider.complete(makeRequest({ evidencePack: undefined }));

    const userMessage = createMock.mock.calls[0][0].messages[0];
    expect(userMessage.content).toContain('No live data source matched this question');
    expect(userMessage.content).not.toContain('Verified figures');
  });

  it('joins multiple text blocks and ignores non-text blocks', async () => {
    createMock.mockResolvedValue(
      apiResponse({
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: 'Part one.' },
          { type: 'text', text: 'Part two.' },
        ],
      }),
    );
    const provider = new AnthropicZacModelProvider(makeConfig());

    const completion = await provider.complete(makeRequest());
    expect(completion.text).toBe('Part one.\nPart two.');
  });

  it('throws ZacModelRefusedError on a safety refusal instead of reading content', async () => {
    createMock.mockResolvedValue(apiResponse({ stop_reason: 'refusal', content: [] }));
    const provider = new AnthropicZacModelProvider(makeConfig());

    await expect(provider.complete(makeRequest())).rejects.toBeInstanceOf(ZacModelRefusedError);
  });

  it('throws ZacModelIncompleteError on max_tokens truncation, carrying the billed usage', async () => {
    createMock.mockResolvedValue(
      apiResponse({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'This week the salon took £1,2' }],
      }),
    );
    const provider = new AnthropicZacModelProvider(makeConfig());

    const rejection = await provider.complete(makeRequest()).catch((error) => error);
    expect(rejection).toBeInstanceOf(ZacModelIncompleteError);
    // The truncated call billed — usage rides on the error for cost telemetry.
    expect((rejection as ZacModelIncompleteError).completion).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 40,
    });
  });

  it('places the evidence BEFORE the fenced question so a question cannot spoof it', async () => {
    createMock.mockResolvedValue(apiResponse());
    const provider = new AnthropicZacModelProvider(makeConfig());
    const request = makeRequest();

    await provider.complete(request);

    const content: string = createMock.mock.calls[0][0].messages[0].content;
    expect(content.indexOf('Verified figures')).toBeGreaterThanOrEqual(0);
    expect(content.indexOf('Verified figures')).toBeLessThan(content.indexOf('<question>'));
    expect(content).toContain(`<question>${request.question}</question>`);
  });

  it('rejects a max-tokens override below the safe floor', () => {
    const provider = new AnthropicZacModelProvider(
      makeConfig({ ...ENV, ZAC_MODEL_MAX_TOKENS: '10' }),
    );
    expect(provider).toBeDefined();
    // Constructor clamps to the default rather than a truncation-guaranteed cap.
    createMock.mockResolvedValue(apiResponse());
    return provider.complete(makeRequest()).then(() => {
      expect(createMock.mock.calls[0][0].max_tokens).toBe(8192);
    });
  });

  it('propagates transport errors untouched (the orchestrator owns the fallback)', async () => {
    createMock.mockRejectedValue(new Error('529 overloaded'));
    const provider = new AnthropicZacModelProvider(makeConfig());

    await expect(provider.complete(makeRequest())).rejects.toThrow('529 overloaded');
  });

  it('treats missing cache usage fields as zero', async () => {
    createMock.mockResolvedValue(
      apiResponse({ usage: { input_tokens: 10, output_tokens: 5 } }),
    );
    const provider = new AnthropicZacModelProvider(makeConfig());

    const completion = await provider.complete(makeRequest());
    expect(completion.cacheReadInputTokens).toBe(0);
    expect(completion.cacheCreationInputTokens).toBe(0);
  });

  describe('advisory (no-evidence) prompt assembly', () => {
    it.each([
      ['general_advice', 'GENERAL salon/business guidance'],
      ['hypothetical', 'HYPOTHETICAL scenario'],
      ['conversational', 'conversational follow-up'],
    ] as const)('mode %s instructions ride in the user message, never the system prefix', async (mode, marker) => {
      createMock.mockResolvedValue(apiResponse());
      const provider = new AnthropicZacModelProvider(makeConfig());

      await provider.complete(makeRequest({ evidencePack: undefined, mode }));

      const params = createMock.mock.calls[0][0];
      const userMessage = params.messages[0].content as string;
      const systemText = params.system[0].text as string;
      expect(userMessage).toContain(marker);
      expect(systemText).not.toContain(marker);
      // The untrusted question is fenced AND followed by a re-anchor line.
      const questionEnd = userMessage.indexOf('</question>');
      expect(questionEnd).toBeGreaterThan(-1);
      expect(userMessage.slice(questionEnd)).toContain(
        "never present any number as the user's real, current business figure",
      );
    });
  });

  it('carries billed usage on refusals — the completion rides the error with text cleared', async () => {
    createMock.mockResolvedValue(
      apiResponse({
        stop_reason: 'refusal',
        content: [{ type: 'text', text: 'partial content that must not leak' }],
      }),
    );
    const provider = new AnthropicZacModelProvider(makeConfig());

    const rejection = await provider.complete(makeRequest()).catch((error) => error);
    expect(rejection).toBeInstanceOf(ZacModelRefusedError);
    expect(rejection.completion).toMatchObject({ inputTokens: 100, text: '' });
  });

  describe('classifyMode', () => {
    it('returns the lowercased token plus honest usage on a clean call', async () => {
      createMock.mockResolvedValue(
        apiResponse({ content: [{ type: 'text', text: ' General_Advice ' }] }),
      );
      const provider = new AnthropicZacModelProvider(makeConfig());

      const result = await provider.classifyMode('Thoughts on things lately?', 'owner');

      expect(result.mode).toBe('general_advice');
      expect(result.completion).toMatchObject({ provider: 'anthropic', inputTokens: 100 });
      // Tight per-request budget: a blocking pre-step must fail fast.
      expect(createMock.mock.calls[0][1]).toMatchObject({ timeout: 10_000, maxRetries: 1 });
      // The question is data inside <request> in the USER turn, never system.
      const params = createMock.mock.calls[0][0];
      expect(params.messages[0].content).toContain('<request>Thoughts on things lately?</request>');
      expect(String(params.system)).not.toContain('Thoughts on things lately');
    });

    it('discards the token (but keeps the usage) when the call did not end cleanly', async () => {
      createMock.mockResolvedValue(
        apiResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'qlooqo' }] }),
      );
      const provider = new AnthropicZacModelProvider(makeConfig());

      const result = await provider.classifyMode('Anything?', 'owner');

      expect(result.mode).toBeNull();
      expect(result.completion).not.toBeNull();
    });

    it('never throws — transport failures degrade to the deterministic fallback', async () => {
      createMock.mockRejectedValue(new Error('529 overloaded'));
      const provider = new AnthropicZacModelProvider(makeConfig());

      await expect(provider.classifyMode('Anything?', 'owner')).resolves.toEqual({
        mode: null,
        completion: null,
      });
    });
  });
});
