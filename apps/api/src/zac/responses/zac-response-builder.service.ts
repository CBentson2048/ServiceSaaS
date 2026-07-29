import { Injectable } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacModelCompletion } from '../models/zac-model-provider.interface';
import type { ZacRoleProfile } from '../roles/zac-role-profile.types';
import type { ZacReadOnlyTool, ZacToolDispatchTrace } from '../tools/zac-tool.types';
import type { ZacResponse } from './zac-response.types';

interface ControlledTestResponseInput {
  context: ZacActingContext;
  profile: ZacRoleProfile;
  visibleTools: ZacReadOnlyTool[];
  completion: ZacModelCompletion;
  toolCalls: ZacToolDispatchTrace[];
  traceId: string;
}

@Injectable()
export class ZacResponseBuilderService {
  /**
   * Week 1 controlled foundation response. The `answer` is user-facing product
   * copy — it answers "what can you do for me?", not "how is the backend built" —
   * while backend state lives in `technical_details`. Contract-complete, honest
   * about foundation mode, zero live business data; missing data is stated in
   * `limitations`, never invented.
   */
  buildControlledTestResponse(input: ControlledTestResponseInput): ZacResponse {
    const { context, profile, visibleTools, completion, toolCalls, traceId } = input;
    const plannedTools = visibleTools.length;
    const connectedTools = visibleTools.filter((tool) => tool.enabled).map((tool) => tool.name);
    const disabledTools = visibleTools.filter((tool) => !tool.enabled).map((tool) => tool.name);

    return {
      answer: this.composeFoundationAnswer(context),
      role_context: context.roleContext,
      response_type: 'Explanation',
      evidence: [
        {
          source_type: 'zac.foundation',
          source_ref: 'controlled-test-response',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'Foundation mode: no live reporting, QLAB or stock data is connected yet.',
        plannedTools === 0
          ? 'No data sources are planned for your role yet.'
          : `${plannedTools} data source${plannedTools === 1 ? ' is' : 's are'} planned for your role; none return live data yet.`,
        `Data scope once tools are connected: ${profile.scopeDescription}`,
        'Nothing in this answer comes from your salon records, and nothing was written to them.',
      ],
      suggested_next_step:
        'Check back as data sources come online — or ask what I will be able to tell you about rebooking, revenue or team productivity.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: toolCalls,
      cost_metadata: {
        provider: completion.provider,
        model: completion.model,
        input_tokens: completion.inputTokens,
        output_tokens: completion.outputTokens,
        reasoning_tokens: completion.reasoningTokens,
        estimated_cost_usd: completion.estimatedCostUsd,
        cache_hit: false,
      },
      technical_details: {
        foundation_mode: true,
        feature_flag_state: 'enabled',
        connected_tools: connectedTools,
        disabled_tools: disabledTools,
        provider: completion.provider,
        model: completion.model,
      },
      trace_id: traceId,
    };
  }

  /**
   * Deterministic user-facing foundation copy (Luke's Week 1 product feedback):
   * greet, say what ZAC will help with, be honest about foundation mode, reassure
   * that live salon data is untouched, and point at what comes next. Greeting uses
   * the acting user's first name when safely available, else stays neutral.
   */
  private composeFoundationAnswer(context: ZacActingContext): string {
    const greeting = context.actorFirstName ? `Hi ${context.actorFirstName} 👋` : 'Hi 👋';

    return [
      greeting,
      "I'm ZAC, your AI business assistant for QLOOQO.",
      "As I continue to develop, I'll help you understand and grow your business by analysing the information you already have.",
      "I'll be able to help with revenue, team productivity, appointments, utilisation, retention, rebooking, retail performance, QLAB colour usage and costs, stock, inventory, trends and growth opportunities.",
      "At the moment I'm running in foundation mode, so I don't yet have access to your live business data. That means I can explain what I'll eventually be able to do, but I can't yet answer questions using your salon's information.",
      'As more tools are connected, my answers will become increasingly personalised and evidence-based.',
    ].join('\n\n');
  }
}
