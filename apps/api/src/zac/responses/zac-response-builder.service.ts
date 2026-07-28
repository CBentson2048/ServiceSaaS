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
   * Week 1 controlled test response: contract-complete, honest about being a
   * foundation answer, zero live business data. Every factual gap is stated in
   * `limitations` rather than papered over — missing data is never invented.
   */
  buildControlledTestResponse(input: ControlledTestResponseInput): ZacResponse {
    const { context, profile, visibleTools, completion, toolCalls, traceId } = input;
    const plannedTools = visibleTools.length;

    return {
      answer: completion.text,
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
        'ZAC is running in foundation mode: no live reporting, QLAB or stock tools are connected yet.',
        plannedTools === 0
          ? 'No data tool contracts are visible to your role yet.'
          : `Your role can see ${plannedTools} planned tool contract${plannedTools === 1 ? '' : 's'}; none return live data yet.`,
        `Data scope once tools go live: ${profile.scopeDescription}`,
        'No figure in this answer comes from your salon data; nothing was read from or written to business records.',
      ],
      suggested_next_step: null,
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
      trace_id: traceId,
    };
  }
}
