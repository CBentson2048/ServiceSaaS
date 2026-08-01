import { Injectable } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacModelCompletion } from '../models/zac-model-provider.interface';
import type { ZacRoleProfile } from '../roles/zac-role-profile.types';
import type {
  ZacReadOnlyTool,
  ZacToolDispatchTrace,
  ZacToolResult,
} from '../tools/zac-tool.types';
import type { ZacResponse, ZacTechnicalDetails } from './zac-response.types';

interface ControlledTestResponseInput {
  context: ZacActingContext;
  profile: ZacRoleProfile;
  visibleTools: ZacReadOnlyTool[];
  completion: ZacModelCompletion;
  toolCalls: ZacToolDispatchTrace[];
  traceId: string;
}

interface ToolBackedResponseInput {
  context: ZacActingContext;
  profile: ZacRoleProfile;
  visibleTools: ZacReadOnlyTool[];
  completion: ZacModelCompletion;
  result: ZacToolResult;
  trace: ZacToolDispatchTrace;
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
      technical_details: this.technicalDetails(visibleTools, completion),
      trace_id: traceId,
    };
  }

  /**
   * Response for a dispatched tool. Answer-first: a successful tool supplies its
   * own user-facing answer, evidence, confidence, limitations and next step via
   * its presentation block; a denied/disabled/failed dispatch becomes an honest
   * Refusal / Insufficient Data answer — never a raw error, never invented data.
   */
  buildToolBackedResponse(input: ToolBackedResponseInput): ZacResponse {
    const { context, profile, visibleTools, completion, result, trace, traceId } = input;
    const presentation = result.status === 'ok' ? result.presentation : undefined;

    const base = {
      role_context: context.roleContext,
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [trace],
      cost_metadata: {
        provider: completion.provider,
        model: completion.model,
        input_tokens: completion.inputTokens,
        output_tokens: completion.outputTokens,
        reasoning_tokens: completion.reasoningTokens,
        estimated_cost_usd: completion.estimatedCostUsd,
        cache_hit: false,
      },
      technical_details: this.technicalDetails(visibleTools, completion),
      trace_id: traceId,
    } satisfies Partial<ZacResponse>;

    if (presentation) {
      return {
        ...base,
        answer: presentation.answer,
        response_type: presentation.responseType,
        evidence: presentation.evidence,
        confidence: presentation.confidence,
        limitations: presentation.limitations,
        suggested_next_step: presentation.suggestedNextStep,
      };
    }

    return {
      ...base,
      answer: `I can't answer that with your data right now. ${result.explanation}`,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.foundation',
          source_ref: 'safe-unavailable-response',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [result.explanation, `Data scope: ${profile.scopeDescription}`],
      suggested_next_step: 'Ask "What can you help me with?" to see what I can answer today.',
    };
  }

  /**
   * Honest answer for staff/team/member questions while no read-only staff tool
   * is connected (Luke's product direction): acknowledge the intent first, state
   * the limitation plainly, never guess, and say what comes next. No staff
   * service is called and no staff data of any kind exists in this response.
   */
  buildStaffMembersUnavailableResponse(input: {
    context: ZacActingContext;
    profile: ZacRoleProfile;
    visibleTools: ZacReadOnlyTool[];
    completion: ZacModelCompletion;
    traceId: string;
  }): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      answer: [
        "I understand you're asking about your business members or team.",
        "Staff and team member data isn't connected to ZAC yet, so I can't list or analyse your team using live QLOOQO data — and I won't guess.",
        'Once read-only staff tools are connected, I will be able to help owners and managers understand team members, their locations and performance context, always within your permissions.',
        'In the meantime, try "How is my business doing?" for a live health snapshot.',
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.intent',
          source_ref: 'staff-members-intent:not-connected',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'Staff and team member data is not connected to ZAC yet.',
        'No staff names, roles, performance or pay details were read or included.',
        `Data scope once staff tools are connected: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Try "How is my business doing?" for a live snapshot, or ask about your team again once read-only staff tools are connected.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
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
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'staff.members',
      },
      trace_id: traceId,
    };
  }

  private technicalDetails(
    visibleTools: ZacReadOnlyTool[],
    completion: ZacModelCompletion,
  ): ZacTechnicalDetails {
    return {
      foundation_mode: true,
      feature_flag_state: 'enabled',
      connected_tools: visibleTools.filter((tool) => tool.enabled).map((tool) => tool.name),
      disabled_tools: visibleTools.filter((tool) => !tool.enabled).map((tool) => tool.name),
      provider: completion.provider,
      model: completion.model,
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
