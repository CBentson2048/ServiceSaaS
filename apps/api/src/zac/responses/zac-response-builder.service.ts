import { Injectable } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacMemoryItem, ZacMemoryRecallSubject } from '../memory/zac-memory.types';
import { ZAC_MEMORY_KIND_LABELS } from '../memory/zac-memory.types';
import type { ZacModelCompletion } from '../models/zac-model-provider.interface';
import type { ZacRoleProfile } from '../roles/zac-role-profile.types';
import type {
  ZacReadOnlyTool,
  ZacToolDispatchTrace,
  ZacToolResult,
} from '../tools/zac-tool.types';
import type { ZacEvidenceItem, ZacResponse, ZacTechnicalDetails } from './zac-response.types';

interface ControlledTestResponseInput {
  context: ZacActingContext;
  profile: ZacRoleProfile;
  visibleTools: ZacReadOnlyTool[];
  completion: ZacModelCompletion;
  toolCalls: ZacToolDispatchTrace[];
  traceId: string;
  conversationId: string | null;
}

interface ToolBackedResponseInput {
  context: ZacActingContext;
  profile: ZacRoleProfile;
  visibleTools: ZacReadOnlyTool[];
  completion: ZacModelCompletion;
  result: ZacToolResult;
  trace: ZacToolDispatchTrace;
  traceId: string;
  conversationId: string | null;
}

/** Shared input for the deterministic memory responses (no tool, no model). */
interface MemoryResponseBaseInput {
  context: ZacActingContext;
  profile: ZacRoleProfile;
  visibleTools: ZacReadOnlyTool[];
  completion: ZacModelCompletion;
  traceId: string;
  conversationId: string | null;
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
      conversation_id: input.conversationId,
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
      cost_metadata: this.costMetadata(completion),
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
      conversation_id: input.conversationId,
      role_context: context.roleContext,
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [trace],
      cost_metadata: this.costMetadata(completion),
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
  buildStaffMembersUnavailableResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
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
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'staff.members',
      },
      trace_id: traceId,
    };
  }

  /**
   * A stylist asked for owner/manager/business-wide data (revenue, payroll,
   * team, other stylists, client lists). Acknowledge the intent, state the
   * access boundary plainly, redirect to what IS in scope. Nothing is
   * dispatched for this answer and no restricted data of any kind exists in it;
   * the evidence references the permission boundary, never live data.
   */
  buildStylistRestrictedResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I understand what you're asking, but that information is not available at your access level.",
        'Business reports, pay information, team data and client lists belong to owner and manager roles. I can help with your own work context and coaching where permitted.',
        'Try asking "What should I focus on today?" or "What can you help me with?" to see what is available for your role.',
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.access_boundary',
          source_ref: 'stylist-role-scope',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'This area is outside the stylist access level — no restricted data was read or shown.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Ask "What can you help me with?" to see what ZAC offers for your role.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'stylist.restricted',
      },
      trace_id: traceId,
    };
  }

  /**
   * A stylist asked about their OWN work (schedule, focus, improvement,
   * performance) before the stylist-safe tools are connected. Recognised as a
   * personal intent — not a generic fallback — and answered honestly.
   */
  buildStylistPersonalUnavailableResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I understand you're asking about your own stylist work context.",
        "That read-only stylist data is not connected to ZAC yet, so I can't answer from live QLOOQO data right now.",
        "Once the stylist-safe tools are connected, I'll be able to help with your own schedule, personal coaching and improvement opportunities where permitted.",
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.intent',
          source_ref: 'stylist-personal-intent:not-connected',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'Your own schedule, coaching and performance data is not connected to ZAC yet.',
        'Nothing was read from your salon records for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Ask "What can you help me with?" — or check back once stylist tools come online.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'stylist.personal',
      },
      trace_id: traceId,
    };
  }

  /**
   * A live narration replaces ONLY the prose. Evidence, confidence,
   * limitations and next step still come from the tool's presentation —
   * confidence stays derived, never model-guessed — and `foundation_mode`
   * flips false because the answer text is now live.
   */
  buildNarratedResponse(input: ToolBackedResponseInput & { narratedAnswer: string }): ZacResponse {
    const response = this.buildToolBackedResponse(input);
    return {
      ...response,
      answer: input.narratedAnswer,
      technical_details: { ...response.technical_details, foundation_mode: false },
    };
  }

  private costMetadata(completion: ZacModelCompletion): ZacResponse['cost_metadata'] {
    return {
      provider: completion.provider,
      model: completion.model,
      input_tokens: completion.inputTokens,
      output_tokens: completion.outputTokens,
      reasoning_tokens: completion.reasoningTokens,
      estimated_cost_usd: completion.estimatedCostUsd,
      cache_hit: completion.cacheReadInputTokens > 0,
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
   * Greeting + self-introduction appear on the FIRST assistant turn of a
   * conversation only — a continuing conversation answers without reintroducing.
   */
  private composeFoundationAnswer(context: ZacActingContext): string {
    const greeting = context.actorFirstName ? `Hi ${context.actorFirstName} 👋` : 'Hi 👋';

    const intro = context.firstAssistantTurn
      ? [greeting, "I'm ZAC, your AI business assistant for QLOOQO."]
      : [];

    return [
      ...intro,
      "As I continue to develop, I'll help you understand and grow your business by analysing the information you already have.",
      "I'll be able to help with revenue, team productivity, appointments, utilisation, retention, rebooking, retail performance, QLAB colour usage and costs, stock, inventory, trends and growth opportunities.",
      "At the moment I'm running in foundation mode, so I don't yet have access to your live business data. That means I can explain what I'll eventually be able to do, but I can't yet answer questions using your salon's information.",
      'As more tools are connected, my answers will become increasingly personalised and evidence-based.',
    ].join('\n\n');
  }

  /**
   * Acknowledge a stored memory. The answer restates the saved summary and is
   * transparent about who can see it; `memory_updates` carries the contract
   * fields so clients can render what was remembered.
   */
  buildMemoryStoredResponse(
    input: MemoryResponseBaseInput & { item: ZacMemoryItem; supersededCount: number },
  ): ZacResponse {
    const { context, visibleTools, completion, traceId, item, supersededCount } = input;

    const scopeLine = {
      user_private: 'Saved privately to you.',
      stylist_private:
        "Saved privately to you — your coaching notes are never visible to owners or managers.",
      business_owner: 'Saved for your business — visible to owners and managers.',
      manager_team_theme: 'Saved as a team theme for your team scope.',
      system_safe_summary: 'Saved.',
    }[item.visibilityScope];

    return {
      conversation_id: input.conversationId,
      answer: [
        `Got it — I'll remember that. ${scopeLine}`,
        `“${item.content}”`,
        supersededCount > 0
          ? `This replaces what you'd previously asked me to remember about ${item.topic.replace(/_/g, ' ')}.`
          : `You can update it any time — for example, "update that ${ZAC_MEMORY_KIND_LABELS[item.kind].toLowerCase()} to…".`,
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Explanation',
      evidence: [this.memoryEvidence(item)],
      confidence: 'high',
      limitations: [
        'This is user-stated context you asked me to remember — not live QLOOQO data.',
        scopeLine,
      ],
      suggested_next_step:
        item.kind === 'business_goal' || item.kind === 'business_priority'
          ? 'Ask "How is my business doing?" to see where you stand against it.'
          : 'Ask "What do you remember about me?" to review what I\'m holding.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [
        { scope: item.visibilityScope, kind: item.kind, summary: item.content },
      ],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'memory.capture',
      },
      trace_id: traceId,
    };
  }

  /**
   * Answer a memory question from persisted memory — never from a report tool
   * and never from imagination. An empty result is stated honestly.
   */
  buildMemoryRecallResponse(
    input: MemoryResponseBaseInput & {
      subject: ZacMemoryRecallSubject;
      items: ZacMemoryItem[];
      /** True when storage could not be read — "can't check" is NOT "nothing saved". */
      storageUnavailable?: boolean;
    },
  ): ZacResponse {
    const { context, visibleTools, completion, traceId, subject, items } = input;

    const subjectLabel: Record<ZacMemoryRecallSubject, string> = {
      about_me: 'about you',
      about_business: 'about your business',
      about_team: 'about your team',
      goals: 'as your current goals',
      preferences: 'as your preferences',
    };

    const answer = input.storageUnavailable
      ? "I can't reach my memory just now, so I can't tell you what's saved. Please try again in a moment — nothing has been lost."
      : items.length === 0
        ? [
            `I don't have anything saved ${subjectLabel[subject]} yet.`,
            'You can ask me to remember things — for example, "My main goal this month is to increase rebooking to 60%. Please remember that."',
          ].join('\n\n')
        : [
            `Here's what I have ${subjectLabel[subject]}:`,
            items
              .map((item) => `• ${ZAC_MEMORY_KIND_LABELS[item.kind]}: ${item.content}`)
              .join('\n'),
          ].join('\n\n');

    return {
      conversation_id: input.conversationId,
      answer,
      role_context: context.roleContext,
      response_type: items.length === 0 ? 'Refusal / Insufficient Data' : 'Explanation',
      evidence:
        items.length === 0
          ? [
              {
                source_type: 'zac.memory',
                source_ref: 'memory:none',
                as_of: null,
                entities_used: [],
              },
            ]
          : items.map((item) => this.memoryEvidence(item)),
      confidence: 'high',
      limitations: [
        'These are things you or your team asked me to remember — user-stated context, not live QLOOQO data.',
        'Private memories belonging to other people are never included.',
      ],
      suggested_next_step:
        items.length === 0
          ? 'Tell me a goal or preference to remember, and I\'ll hold onto it.'
          : 'Ask a business question and I\'ll keep these in mind where relevant.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'memory.recall',
      },
      trace_id: traceId,
    };
  }

  /** Refuse to store credentials/payment/client-contact content — plainly and safely. */
  buildMemoryDeclinedResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I can't remember that — it looks like it contains sensitive details (passwords, keys, payment details or personal contact information), which I never store.",
        'I can remember goals, priorities, preferences and coaching focuses instead.',
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.memory',
          source_ref: 'memory:declined-sensitive',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: ['Nothing from this request was stored.'],
      suggested_next_step: 'Rephrase without the sensitive detail and I\'ll happily remember it.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'memory.declined',
      },
      trace_id: traceId,
    };
  }

  /** Storage failed: say so honestly — never claim something was remembered. */
  buildMemoryUnavailableResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer:
        "I couldn't save that just now — my memory storage is temporarily unavailable, so I haven't remembered it. Please try again in a moment.",
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.memory',
          source_ref: 'memory:store-unavailable',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: ['Nothing was stored; this request had no lasting effect.'],
      suggested_next_step: 'Try asking me to remember it again shortly.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'memory.capture',
      },
      trace_id: traceId,
    };
  }

  /** Safe evidence reference for a memory item — kind + timestamps, never ids of people. */
  private memoryEvidence(item: ZacMemoryItem): ZacEvidenceItem {
    return {
      source_type: 'zac.memory',
      source_ref: `memory:${item.kind}:${item.topic}`,
      as_of: item.updatedAt,
      entities_used: [],
    };
  }
}
