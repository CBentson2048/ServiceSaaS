import { Injectable } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacMemoryItem, ZacMemoryRecallSubject } from '../memory/zac-memory.types';
import { ZAC_MEMORY_KIND_LABELS } from '../memory/zac-memory.types';
import type { ZacModelCompletion } from '../models/zac-model-provider.interface';
import type { ZacRoleProfile } from '../roles/zac-role-profile.types';
import type { ZacRequestMode } from '../routing/zac-request-mode.types';
import type {
  ZacReadOnlyTool,
  ZacToolDispatchTrace,
  ZacToolName,
  ZacToolResult,
} from '../tools/zac-tool.types';
import type { ZacEvidenceItem, ZacResponse, ZacTechnicalDetails } from './zac-response.types';

/** Advisory modes: answered by reasoning, never by an operational tool. */
type ZacAdvisoryMode = Extract<ZacRequestMode, 'general_advice' | 'hypothetical' | 'conversational'>;

/** Human labels for permission explainability — categories, never record details. */
const TOOL_AREA_LABELS: Partial<Record<ZacToolName, string>> = {
  'context.business_summary': 'your business context — name, locations and what your role covers',
  'context.location_summary': 'the locations you can see',
  'report.business_health': 'business health snapshots — bookings, revenue and rebooking activity',
  'report.kpi_summary': 'team KPI standing against targets',
  'report.rebooking_summary': 'rebooking rates and sources',
  'report.stylist_performance': 'stylist performance summaries',
  'report.utilisation_summary': 'utilisation reporting',
  'qlab.colour_analytics': 'QLAB colour usage and waste analytics',
  'inventory.stock_status': 'stock levels and low-stock alerts',
  'schedule.my_appointments': 'your own diary (today and tomorrow)',
  'kpi.personal_coaching': 'your own KPIs and personal coaching',
};

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

  /**
   * A model-reasoned answer for an advisory mode (general advice, hypothetical,
   * conversational). No tool ran, and the response says so structurally: the
   * evidence is a zac.reasoning marker, never QLOOQO evidence, and the
   * limitations state exactly where the figures may come from.
   */
  buildAdvisoryResponse(
    input: MemoryResponseBaseInput & { mode: ZacAdvisoryMode; narratedAnswer: string },
  ): ZacResponse {
    const { context, visibleTools, completion, traceId, mode, narratedAnswer } = input;

    const limitations: Record<ZacAdvisoryMode, string[]> = {
      general_advice: [
        'This is general guidance — no QLOOQO business data was read for this answer.',
        'Ask about your own figures (e.g. "How is my business doing?") for a data-backed view.',
      ],
      hypothetical: [
        'This answers the scenario you supplied — the figures come from your question (and your stated goals), not from live QLOOQO data.',
        'No QLOOQO business data was read for this answer.',
      ],
      conversational: [
        'This continues our conversation — no fresh QLOOQO business data was read for this answer.',
      ],
    };

    return {
      conversation_id: input.conversationId,
      answer: narratedAnswer,
      role_context: context.roleContext,
      response_type: mode === 'hypothetical' ? 'Coaching Point' : 'Explanation',
      evidence: [
        {
          source_type: 'zac.reasoning',
          source_ref: `advisory:${mode}`,
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'medium',
      limitations: limitations[mode],
      suggested_next_step:
        mode === 'conversational'
          ? null
          : 'Want this grounded in your own numbers? Ask me about your live figures.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        foundation_mode: false,
      },
      trace_id: traceId,
    };
  }

  /**
   * Honest fallback when an advisory mode cannot run (no narrating provider,
   * or the call failed): say what ZAC can't do right now instead of forcing an
   * unrelated tool or inventing advice.
   */
  buildAdvisoryUnavailableResponse(
    input: MemoryResponseBaseInput & { mode: ZacAdvisoryMode },
  ): ZacResponse {
    const { context, profile, visibleTools, completion, traceId, mode } = input;

    // Accurate for every arrival path: provider absent, call failed, OR the
    // answer was rejected by a safety check — in all cases no reliable
    // reasoned answer exists right now, and ZAC won't guess.
    const answer =
      mode === 'conversational'
        ? 'Happy to keep chatting — I can\'t go deeper on that right now, but for anything detailed, ask me about your business data directly (for example "How is my business doing?").'
        : [
            mode === 'hypothetical'
              ? "I can't give you a reliable answer to your scenario just now, and I won't guess."
              : "I can't give you reliable general advice just now, and I won't guess.",
            'I can still answer from your connected business data — try "How is my business doing?" or "What can you help me with?".',
          ].join('\n\n');

    return {
      conversation_id: input.conversationId,
      answer,
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.reasoning',
          source_ref: `advisory:${mode}:unavailable`,
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'No QLOOQO business data was read for this answer.',
        `Data scope for live questions: ${profile.scopeDescription}`,
      ],
      suggested_next_step: 'Ask a question about your live business data instead.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: this.technicalDetails(visibleTools, completion),
      trace_id: traceId,
    };
  }

  /** Deterministic reply to a bare acknowledgement — no model, no tool, no cost. */
  buildAcknowledgementResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: "You're welcome! Anything else about your business I can help with?",
      role_context: context.roleContext,
      response_type: 'Explanation',
      evidence: [
        {
          source_type: 'zac.reasoning',
          source_ref: 'advisory:conversational',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: ['No QLOOQO business data was read for this answer.'],
      suggested_next_step: null,
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: this.technicalDetails(visibleTools, completion),
      trace_id: traceId,
    };
  }

  /**
   * Permission explainability, generated from the EFFECTIVE capability state
   * of this exact request: the actor's resolved permissions filter the
   * accessible tool set, permission gaps are computed against their role (not
   * hardcoded per role name), and the privacy + read-only boundaries are the
   * ones the code actually enforces. Descriptive only — nothing here grants,
   * and dispatch re-checks everything regardless of what this answer says.
   */
  buildPermissionExplanationResponse(
    input: MemoryResponseBaseInput & { gapTools: ZacReadOnlyTool[] },
  ): ZacResponse {
    const { context, profile, visibleTools, completion, traceId, gapTools } = input;

    const label = (tool: ZacReadOnlyTool): string => TOOL_AREA_LABELS[tool.name] ?? tool.description;
    const accessible = visibleTools.filter((tool) => tool.enabled && tool.name !== 'context.capabilities');
    const comingSoon = visibleTools.filter((tool) => !tool.enabled);

    const lines: string[] = [];
    lines.push(
      `Here's your current ZAC access as ${profile.displayName.toLowerCase()}${context.businessName ? ` at ${context.businessName}` : ''} — based on your effective permissions right now, not just your role name.`,
    );
    lines.push(
      `Scope: ${profile.scopeDescription}${
        context.accessibleLocations.length > 0
          ? ` You can see ${context.accessibleLocations.length} location${context.accessibleLocations.length === 1 ? '' : 's'}.`
          : ''
      }`,
    );

    lines.push(
      accessible.length > 0
        ? `You CAN access, through me:\n${accessible.map((tool) => `• ${label(tool)}`).join('\n')}`
        : 'Right now no live data areas are open to you through me — your capability questions and saved memories still work.',
    );
    if (comingSoon.length > 0) {
      lines.push(
        `Planned for your access, not connected yet:\n${comingSoon.map((tool) => `• ${label(tool)}`).join('\n')}`,
      );
    }

    const boundaries: string[] = [];
    // Unconnected skeletons are "coming soon" for everyone — only a CONNECTED
    // tool the actor's permissions block is honestly a permission boundary.
    for (const tool of gapTools.filter((tool) => tool.enabled)) {
      boundaries.push(
        `${label(tool)} — your role could hold this, but your current security level doesn't include the permission it needs.`,
      );
    }
    if (context.roleContext === 'stylist') {
      boundaries.push(
        'business-wide reports, financials, other team members’ performance and client lists — owner and manager territory.',
      );
    }
    if (context.roleContext === 'manager') {
      boundaries.push('anything outside your assigned locations.');
    }
    boundaries.push('data belonging to other businesses — never, under any phrasing.');
    lines.push(`You CANNOT access:\n${boundaries.map((boundary) => `• ${boundary}`).join('\n')}`);

    lines.push(
      context.roleContext === 'stylist'
        ? 'Privacy: your coaching notes and preferences are saved privately to you — owners and managers can never read them through ZAC. In turn, colleagues’ private notes are never visible to you.'
        : 'Privacy: stylists’ private coaching notes are never visible to you through ZAC, whatever your permissions — that boundary is fixed. Business goals and team themes saved for your scope are shared as designed.',
    );

    lines.push(
      'And whatever your permissions, ZAC itself is read-only in Phase 1: I cannot create or change bookings, edit clients, change staff or stock, alter prices, take payments, or send messages.',
    );

    return {
      conversation_id: input.conversationId,
      answer: lines.join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Explanation',
      evidence: [
        {
          source_type: 'zac.permissions',
          source_ref: 'effective-permission-context',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'This reflects your effective permissions at this moment — security-level changes apply from your next question.',
        'Describing an area never grants it: every data request is permission-checked again when it runs.',
      ],
      suggested_next_step:
        accessible.length > 0
          ? 'Ask about any of the areas above — or ask an owner to adjust your security level if something you need is missing.'
          : 'Ask an owner to review your security level if you need data access through ZAC.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: this.technicalDetails(visibleTools, completion),
      trace_id: traceId,
    };
  }
}
