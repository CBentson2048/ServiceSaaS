import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AnthropicZacModelProvider } from '../models/providers/anthropic-zac-provider';
import {
  ModelProviderReasoningAdapter,
  ModelProviderSemanticAdapter,
  ModelProviderSynthesisAdapter,
} from '../models/providers/capability.adapters';
import { OpenAiSemanticProvider } from '../models/providers/openai-semantic-provider';
import { OpenAiZacProvider } from '../models/providers/openai-zac-provider';
import { StubZacModelProvider } from '../models/providers/stub-zac-provider';
import type { ZacSemanticProvider } from '../models/zac-semantic-provider.interface';
import type { ZacReasoningProvider, ZacSynthesisProvider } from './zac-ai-ports';
import {
  ZacAiConfigurationError,
  ignoredCapabilityOverrides,
  resolveZacAiProfile,
  type ZacAiProfileResolution,
} from './zac-ai-profile.config';
import type {
  ZacAiCapability,
  ZacAiCapabilityBinding,
  ZacAiProviderId,
  ZacAiProviderProfile,
} from './zac-ai.types';

/**
 * THE PROVIDER RESOLVER — the single place that answers "which vendor performs
 * which capability", and the only place allowed to construct a vendor adapter.
 *
 * Everything downstream depends on the PORTS this returns, never on a vendor.
 * That is what makes `if (provider === 'openai')` absent from ZAC orchestration
 * and what makes a fair benchmark possible: the workload cannot branch on the
 * thing being measured.
 *
 * Construction is lazy-but-once per vendor, because a vendor client is a
 * connection pool and a hybrid profile legitimately wants one Anthropic client
 * shared by reasoning and synthesis rather than two.
 *
 * KEYS ARE NOT A PROFILE. A missing key does not silently move a capability to
 * the other vendor — that would make a benchmark measure something other than
 * what it claims, which is the failure mode this whole design is built to
 * prevent. A missing key degrades to the shipped safe behaviour instead: no
 * semantic provider (the router's fallback ladder handles it, exactly as a
 * keyless build always did) and the deterministic stub for synthesis.
 */
export class ZacAiProviderResolver {
  private readonly logger = new Logger(ZacAiProviderResolver.name);
  private readonly resolution: ZacAiProfileResolution;

  private anthropic: AnthropicZacModelProvider | null = null;
  private openaiReasoning: OpenAiZacProvider | null = null;
  private openaiSemantic: OpenAiSemanticProvider | null = null;
  private stub: StubZacModelProvider | null = null;

  private readonly semanticProvider: ZacSemanticProvider | null;
  private readonly reasoningProvider: ZacReasoningProvider | null;
  private readonly synthesisProvider: ZacSynthesisProvider;
  private readonly degraded: string[] = [];

  constructor(private readonly config: ConfigService) {
    // Throws on an unsupported profile or capability provider. Boot is the
    // right place to fail: a typo that silently ran the other vendor would
    // invalidate every number a benchmark produced from it.
    this.resolution = resolveZacAiProfile(config);

    const ignored = ignoredCapabilityOverrides(config, this.resolution);
    if (ignored.length > 0) {
      this.logger.warn(
        `ZAC_AI_PROVIDER=${this.resolution.profile} is a single-vendor profile — ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} ignored. Use ZAC_AI_PROVIDER=hybrid for per-capability providers.`,
      );
    }

    this.semanticProvider = this.buildSemantic();
    this.reasoningProvider = this.buildReasoning();
    this.synthesisProvider = this.buildSynthesis();

    this.logger.log(
      `ZAC AI profile '${this.resolution.profile}': ${this.bindings()
        .map((b) => `${b.capability}=${b.provider ?? 'none'}/${b.model ?? '-'}`)
        .join(' ')}`,
    );
  }

  get profile(): ZacAiProviderProfile {
    return this.resolution.profile;
  }

  /** The vendor ASSIGNED to each capability, before key availability. */
  get assignment(): ZacAiProfileResolution {
    return this.resolution;
  }

  /** Capabilities that could not be bound as configured, and why. */
  get degradations(): readonly string[] {
    return this.degraded;
  }

  /** Null when no dedicated semantic provider is available (safe fallback path). */
  semantic(): ZacSemanticProvider | null {
    return this.semanticProvider;
  }

  /** Null when no reasoning provider is available (deterministic plan applies). */
  reasoning(): ZacReasoningProvider | null {
    return this.reasoningProvider;
  }

  /** Never null: with no key this is the deterministic stub, which is a real deployment. */
  synthesis(): ZacSynthesisProvider {
    return this.synthesisProvider;
  }

  /**
   * The narration vendor's OWN request-mode classifier — what
   * `ZacModelProvider.classifyRequestMode` has always been, and what `legacy`
   * and `shadow` routing modes call.
   *
   * Deliberately not the dedicated semantic port: shadow mode exists to compare
   * the dedicated router against the pre-migration classifier, and returning the
   * same object for both would make it compare a provider with itself and report
   * perfect agreement forever.
   *
   * Null when the synthesis vendor has no classifier of its own (OpenAI, whose
   * routing lives in the dedicated semantic provider) — the router then treats
   * legacy classification as unavailable and uses its safe fallback ladder.
   */
  legacyClassifier(): ZacSemanticProvider | null {
    if (this.resolution.synthesis !== 'anthropic') return null;
    const anthropic = this.getAnthropic();
    if (!anthropic) return null;
    return new ModelProviderSemanticAdapter(anthropic, anthropic.routerModel);
  }

  /** What actually resolved, for `/zac/health` and benchmark run metadata. */
  bindings(): ZacAiCapabilityBinding[] {
    const semantic = this.semanticProvider;
    const reasoning = this.reasoningProvider;
    const synthesis = this.synthesisProvider;
    const binding = (
      capability: ZacAiCapability,
      provider: string | null,
      model: string | null,
    ): ZacAiCapabilityBinding => ({
      capability,
      provider: (provider as ZacAiProviderId | null) ?? null,
      model,
    });
    return [
      binding('semantic_routing', semantic?.name ?? null, semantic?.model ?? null),
      binding('tool_planning', reasoning?.providerId ?? null, reasoning?.model ?? null),
      binding('structured_reasoning', reasoning?.providerId ?? null, reasoning?.model ?? null),
      binding('answer_synthesis', synthesis.providerId, synthesis.model),
    ];
  }

  // ---------------------------------------------------------------------------

  private buildSemantic(): ZacSemanticProvider | null {
    const vendor = this.resolution.semantic;
    if (vendor === 'openai') {
      const provider = this.getOpenAiSemantic();
      if (!provider) {
        this.degrade('semantic_routing', 'openai', 'OPENAI_API_KEY');
        return null;
      }
      return provider;
    }
    const anthropic = this.getAnthropic();
    if (!anthropic) {
      this.degrade('semantic_routing', 'anthropic', 'ANTHROPIC_API_KEY');
      return null;
    }
    // The Anthropic semantic capability lives on the whole-vendor provider and
    // runs on its own smaller router model — the adapter carries that identity
    // so health and telemetry report the model that actually classified.
    return new ModelProviderSemanticAdapter(anthropic, anthropic.routerModel);
  }

  private buildReasoning(): ZacReasoningProvider | null {
    const vendor = this.resolution.reasoning;
    if (vendor === 'openai') {
      const provider = this.getOpenAiZac();
      if (!provider) {
        this.degrade('structured_reasoning', 'openai', 'OPENAI_API_KEY');
        return null;
      }
      return provider;
    }
    const anthropic = this.getAnthropic();
    if (!anthropic) {
      this.degrade('structured_reasoning', 'anthropic', 'ANTHROPIC_API_KEY');
      return null;
    }
    return new ModelProviderReasoningAdapter(anthropic, 'anthropic');
  }

  private buildSynthesis(): ZacSynthesisProvider {
    const vendor = this.resolution.synthesis;
    if (vendor === 'openai') {
      const provider = this.getOpenAiZac();
      if (provider) return provider;
      this.degrade('answer_synthesis', 'openai', 'OPENAI_API_KEY');
    } else {
      const anthropic = this.getAnthropic();
      if (anthropic) return new ModelProviderSynthesisAdapter(anthropic, 'anthropic');
      this.degrade('answer_synthesis', 'anthropic', 'ANTHROPIC_API_KEY');
    }
    // No key: the deterministic stub. Local dev, CI and dark builds need
    // neither a secret nor network access, and ZAC still answers — from its
    // deterministic tool-backed path, byte-identically.
    this.stub ??= new StubZacModelProvider();
    return new ModelProviderSynthesisAdapter(this.stub, vendor);
  }

  private degrade(capability: ZacAiCapability, vendor: ZacAiProviderId, key: string): void {
    const message = `${capability} is assigned to ${vendor} but ${key} is not set`;
    this.degraded.push(message);
    this.logger.warn(
      `${message} — ZAC degrades to its safe deterministic path for that capability rather than silently switching provider.`,
    );
  }

  private getAnthropic(): AnthropicZacModelProvider | null {
    if (this.anthropic) return this.anthropic;
    if (!this.config.get<string>('ANTHROPIC_API_KEY')) return null;
    this.anthropic = new AnthropicZacModelProvider(this.config);
    return this.anthropic;
  }

  private getOpenAiZac(): OpenAiZacProvider | null {
    if (this.openaiReasoning) return this.openaiReasoning;
    if (!this.config.get<string>('OPENAI_API_KEY')) return null;
    this.openaiReasoning = new OpenAiZacProvider(this.config);
    return this.openaiReasoning;
  }

  private getOpenAiSemantic(): OpenAiSemanticProvider | null {
    if (this.openaiSemantic) return this.openaiSemantic;
    if (!this.config.get<string>('OPENAI_API_KEY')) return null;
    this.openaiSemantic = new OpenAiSemanticProvider(this.config);
    return this.openaiSemantic;
  }
}

export { ZacAiConfigurationError };
