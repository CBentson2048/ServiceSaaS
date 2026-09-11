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
import type { ZacEvidenceSignal, ZacOrchestrationResult } from '../analysis/zac-analysis.types';
import type { ZacResolvedPriority } from '../analysis/zac-priority.types';
import type { ZacBlockingReason } from '../policy/zac-policy.types';
import type { ZacEvidenceItem, ZacResponse, ZacTechnicalDetails } from './zac-response.types';

/** Advisory modes: answered by reasoning, never by an operational tool. */
type ZacAdvisoryMode = Extract<ZacRequestMode, 'general_advice' | 'hypothetical' | 'conversational'>;

/**
 * Why an advisory turn produced no answer. Kept distinct from
 * operational-data failures on purpose: "my reasoning is unavailable" and
 * "your business data is unavailable" are different facts, and reporting the
 * second when the first happened is what made ZAC look like it could only
 * ever talk about QLOOQO data.
 */
export type ZacAdvisoryFailureReason = 'provider_unavailable' | 'advisory_generation_failed';

/** Human labels for permission explainability — categories, never record details. */
const TOOL_AREA_LABELS: Partial<Record<ZacToolName, string>> = {
  'context.business_summary': 'your business context — name, locations and what your role covers',
  'context.location_summary': 'the locations you can see',
  'report.business_health': 'business health snapshots — bookings, revenue and rebooking activity',
  'report.kpi_summary': 'team KPI standing against targets',
  'report.rebooking_summary': 'rebooking rates and sources',
  'report.stylist_performance': 'stylist performance summaries',
  'report.utilisation_summary': 'utilisation reporting',
  'report.appointment_summary': 'appointment volume, cancellations and recorded no-shows',
  'report.service_mix': 'which services earn the most, and how concentrated that is',
  'report.retail_performance': 'retail sales, leading products and retail attachment per visit',
  'report.client_retention': 'how many clients are active, overdue or lapsed',
  'report.client_lapse_list': 'which specific clients have lapsed, by name',
  'report.profitability': 'profit and margin reporting',
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
  /**
   * The TRUE reason a non-ok dispatch failed, resolved by policy from the tool
   * status. Without it every failure read as the same "can't answer with your
   * data" sentence, which conflated a permission the actor could be granted,
   * a capability that does not exist, and data that simply is not there.
   */
  blockingReason?: ZacBlockingReason;
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
      // DELIVERY vs RETENTION. When a tool discloses client identities, the
      // wire answer carries them and the STORAGE form does not. Both are set
      // here, together, so the pair can never drift apart: a second place that
      // set only `answer` would silently persist the names.
      const disclosure = presentation.identityDisclosure;
      return {
        ...base,
        answer: disclosure
          ? [presentation.answer, disclosure.block].join('\n\n')
          : presentation.answer,
        ...(disclosure ? { answer_storage_form: presentation.answer } : {}),
        response_type: presentation.responseType,
        evidence: presentation.evidence,
        confidence: presentation.confidence,
        limitations: presentation.limitations,
        suggested_next_step: presentation.suggestedNextStep,
      };
    }

    // A failed dispatch is explained by its REAL blocking reason. The trace is
    // carried over so the turn still reports which tool was attempted.
    const reasonInput = {
      context,
      profile,
      visibleTools,
      completion,
      traceId,
      conversationId: input.conversationId,
      explanation: result.explanation,
    };
    const reason: ZacBlockingReason = input.blockingReason ?? 'data_unavailable';
    const delegated =
      reason === 'permission_denied'
        ? this.buildPermissionDeniedResponse(reasonInput)
        : reason === 'unsupported_capability'
          ? this.buildUnsupportedCapabilityResponse(reasonInput)
          : this.buildDataUnavailableResponse(reasonInput);
    return { ...delegated, tool_calls: [trace] };
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
        "Listing your team isn't something ZAC can do in this phase — that capability hasn't been built yet, so I can't list or analyse your team, and I won't guess.",
        'It is planned: once read-only staff tools ship, I will be able to help owners and managers understand team members, their locations and performance context, always within your permissions.',
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
        'Listing team members is not a capability ZAC has in Phase 1 — this is not a permission boundary and not a temporary data outage.',
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
   * An owner or manager asked to READ stylists' private coaching notes — or to
   * have the privacy restriction protecting them overridden. This is the one
   * boundary that never moves: coaching notes are `stylist_private` by design
   * and no role or permission level — the account owner included — can reach
   * them through ZAC. The answer must assert exactly that. It must NOT fall
   * back to "not connected yet": that is true of staff data generally, but it
   * implies these notes would become visible once staff tools connect, and
   * they never will. Nothing is dispatched for this answer and no
   * stylist-private data of any kind exists in it.
   */
  buildCoachingNotesBoundaryResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I can't show you stylists' private coaching notes — and this isn't a data-connection gap or a permission setting. It's a fixed privacy boundary.",
        'Private coaching notes belong to each stylist alone. They are never visible to owners or managers through ZAC, whatever permissions you hold, and there is no override — not for the account owner, and not by asking me to lift the restriction.',
        "Nothing was read or shared for this answer, and I can't tell you whether any such notes exist either way — that would leak the same privacy.",
        this.safeAlternativeSentence(visibleTools),
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.access_boundary',
          source_ref: 'stylist-private-coaching:fixed-boundary',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'Stylist private coaching notes are excluded from owner and manager access by design — a fixed rule, not a permission that can be granted or overridden.',
        'No stylist-private data of any kind was read for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Ask "What am I allowed to see?" for your full access picture, or ask about team KPIs and targets for performance context within your permissions.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'privacy.stylist_coaching_notes',
      },
      trace_id: traceId,
    };
  }

  /**
   * An owner or manager asked to read ANOTHER user's conversations with ZAC
   * ("show me the chat history between you and stylist"). Two truths, both
   * fixed: each person's conversations with ZAC are private to them — never
   * visible to owners or managers, no override for any role — and per D32 the
   * platform persists structural turn summaries only, never the words of
   * either side, so readable transcripts do not exist for ANY role. As with
   * coaching notes, the answer must assert the boundary, never "not connected
   * yet". Nothing is dispatched for this answer and no conversation data of
   * any kind exists in it.
   */
  buildConversationPrivacyBoundaryResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I can't show you anyone else's conversations with me — and like private coaching notes, this isn't a data-connection gap. It's a fixed privacy boundary.",
        "Each person's conversations with ZAC are private to them. A stylist's chats with me are never visible to owners or managers, whatever permissions you hold, and there is no override — not for the account owner, and not by asking me to lift the restriction.",
        "There is also nothing readable to show: I don't keep transcripts. The platform stores only structural summaries of each turn — the kind of thing that was asked, never the words — so a conversation can continue across sessions. Nothing was read or shared for this answer.",
        this.safeAlternativeSentence(visibleTools),
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.access_boundary',
          source_ref: 'user-conversations:fixed-boundary',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        "Other users' conversations with ZAC are excluded from owner and manager access by design — a fixed rule, not a permission that can be granted or overridden.",
        'ZAC persists structural conversation summaries only — the words of a chat are never stored for anyone to read.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Ask "What am I allowed to see?" for your full access picture, or "How is my business doing?" for a live snapshot.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'privacy.user_conversations',
      },
      trace_id: traceId,
    };
  }

  /**
   * The generic fixed-privacy-boundary refusal — the catch-all behind the
   * semantic `privacy_boundary` mode. Served when the semantic layer
   * recognised an attempt to reach someone else's private data but the
   * deterministic guards did not recognise the specific target (novel
   * phrasing, a named person, a data kind we have no tailored copy for).
   * Role-neutral by construction: correct for owners, managers and stylists
   * alike, and self-correcting if a user's OWN data ever misclassifies here —
   * the answer tells them their own data remains available on a direct ask.
   * Nothing is dispatched for this answer and no private data of any kind
   * exists in it.
   */
  buildGenericPrivacyBoundaryResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I can't share that — it's private to the person it belongs to, and that's a fixed privacy boundary, not a data-connection gap or a permission setting.",
        'Through ZAC, private information — someone\'s private notes, their conversations with me, anything saved privately to them — is visible only to that person. No role or permission level changes that, the account owner included, and asking me to override or lift the restriction doesn\'t either.',
        "Nothing was read or shared for this answer, and I can't confirm whether anything of the kind exists — that would leak the same privacy. Anything that's genuinely yours — your own data, your own saved notes, your own chats with me — stays available to you: just ask for it directly.",
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.access_boundary',
          source_ref: 'private-data:fixed-boundary',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        "Private data belonging to another person is excluded from every other user's access by design — a fixed rule, not a permission that can be granted or overridden.",
        'No private data of any kind was read for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Ask "What am I allowed to see?" for your full access picture, or ask about your own data directly.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'privacy.boundary',
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
  /**
   * A stylist asked about their OWN pay — earnings, commission, wages.
   *
   * The restricted answer was wrong for this: it tells them pay information
   * "belongs to owner and manager roles", which is false about their own
   * money and reads as stonewalling. Their pay IS theirs; ZAC simply is not
   * the place it is published.
   *
   * ZAC deliberately does not repeat pay figures (see
   * PersonalStylistCoachingTool: commission and hourly rate are excluded, and
   * anything ZAC says could later flow into its own persistence). So this
   * points at the screen that owns the number instead of quoting it.
   */
  buildStylistOwnPayResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "Your own pay is yours to see — but I'm not where it's published.",
        'Your pay detail, including commission, is on your Performance screen in QLOOQO. I deliberately do not repeat pay figures, so I will not quote or estimate a number here.',
        'I can help with the things that move it: your rebooking and retail habits, your targets, and where your best opportunity is this week.',
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Explanation',
      evidence: [
        {
          source_type: 'zac.access_boundary',
          source_ref: 'stylist-own-pay:not-published-here',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'ZAC does not report pay figures for any role — this is a product decision, not a permission problem and not a data gap.',
        'No pay, commission or payroll data was read for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step: 'Ask "What should I focus on today?" for coaching from your own numbers.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'stylist.own_pay',
      },
      trace_id: traceId,
    };
  }

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
    // The narration replaces the prose, so the identity block has to be
    // re-appended and the storage form re-derived from the NARRATED text —
    // otherwise this overwrite would drop the names from the wire, or worse,
    // leave a storage form that no longer matches what was said.
    const disclosure = input.result.status === 'ok' ? input.result.presentation?.identityDisclosure : undefined;
    return {
      ...response,
      answer: disclosure
        ? [input.narratedAnswer, disclosure.block].join('\n\n')
        : input.narratedAnswer,
      ...(disclosure ? { answer_storage_form: input.narratedAnswer } : {}),
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
    input: MemoryResponseBaseInput & {
      mode: ZacAdvisoryMode;
      narratedAnswer: string;
      /**
       * True when the user explicitly excluded their own data this turn. ZAC
       * then states the provenance but must NOT offer to look at their live
       * figures: they just said not to, and answering their question with a
       * nudge back to the data is the behaviour that failed acceptance.
       */
      dataExcluded?: boolean;
    },
  ): ZacResponse {
    const { context, visibleTools, completion, traceId, mode, narratedAnswer } = input;
    const dataExcluded = input.dataExcluded === true;

    const limitations: Record<ZacAdvisoryMode, string[]> = {
      general_advice: [
        'This is general guidance — no QLOOQO business data was read for this answer.',
        ...(dataExcluded
          ? []
          : ['Ask about your own figures (e.g. "How is my business doing?") for a data-backed view.']),
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
        mode === 'conversational' || dataExcluded
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
  /**
   * An advisory turn that could not be reasoned. The copy is chosen by WHY it
   * failed, because those are different truths and ZAC must tell the right one.
   *
   * In particular: a general or hypothetical question does not need QLOOQO
   * data, so its failure must never be reported as missing business data or
   * redirect the user to ask about their live figures. Doing that is the exact
   * behaviour that failed the hosted acceptance test — the user asked ZAC to
   * set the data aside, and ZAC replied that the data was unavailable.
   */
  buildAdvisoryUnavailableResponse(
    input: MemoryResponseBaseInput & { mode: ZacAdvisoryMode; failure: ZacAdvisoryFailureReason },
  ): ZacResponse {
    const { context, visibleTools, completion, traceId, mode, failure } = input;

    const subject =
      mode === 'hypothetical'
        ? 'your scenario'
        : mode === 'conversational'
          ? 'that'
          : 'that question';

    const answer =
      failure === 'provider_unavailable'
        ? `I can't reason about ${subject} at the moment — my language model isn't available in this environment. This isn't about your business data; it's my own reasoning that's offline. Please try again shortly.`
        : `I can't give you a reliable answer to ${subject} just now, and I won't guess. Please try again, or rephrase it for me.`;

    return {
      conversation_id: input.conversationId,
      answer,
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.reasoning',
          source_ref: `advisory:${mode}:${failure}`,
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        // Deliberately NOT "no QLOOQO data was read": for an advisory turn
        // that is true but irrelevant, and reads as an excuse about data.
        failure === 'provider_unavailable'
          ? "ZAC's reasoning model is not configured in this environment."
          : 'ZAC could not produce a reliable answer for this request.',
      ],
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
   * The router could not tell whether the user wanted a general answer or
   * their live figures, so ZAC asks. Deterministic text, zero tool calls,
   * zero model cost.
   */
  buildRoutingClarificationResponse(
    input: MemoryResponseBaseInput & { clarificationPrompt: string },
  ): ZacResponse {
    const { context, visibleTools, completion, traceId, clarificationPrompt } = input;

    return {
      conversation_id: input.conversationId,
      answer: clarificationPrompt,
      role_context: context.roleContext,
      response_type: 'Explanation',
      evidence: [
        {
          source_type: 'zac.reasoning',
          source_ref: 'routing:clarification',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: ['No QLOOQO business data was read — I have not answered yet.'],
      suggested_next_step: 'Tell me which you would like and I will answer straight away.',
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

  /**
   * What this actor CAN ask instead, derived from their EFFECTIVE permissions —
   * enabled, visible tools only.
   *
   * A refusal that redirects to an area the actor also cannot reach is a second
   * wrong answer, so nothing is named here unless this request's own tool
   * filter already cleared it.
   */
  private safeAlternativeSentence(visibleTools: ZacReadOnlyTool[]): string {
    const usable = visibleTools.filter(
      (tool) => tool.enabled && tool.name !== 'context.capabilities',
    );
    if (usable.length === 0) {
      return 'Your capability questions and your own saved notes still work as normal.';
    }
    const labels = usable
      .slice(0, 3)
      .map((tool) => (TOOL_AREA_LABELS[tool.name] ?? tool.description).toLowerCase());
    return `What I can help with instead, within your current access: ${joinList(labels)}.`;
  }

  /**
   * ZAC Phase 1 is read-only. A request to CHANGE something is refused for that
   * reason and no other — never "that data isn't connected", which would imply
   * the action becomes possible once a source is wired up. It does not: no
   * write contract exists to implement.
   */
  buildReadOnlyBoundaryResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I can't do that — ZAC is read-only, so I can't make changes in QLOOQO. That's a fixed boundary in this phase, not a data-connection gap or a permission you could be granted.",
        'Bookings, prices, clients, stock, payments and messages are all changed by you in QLOOQO itself. I can explain, analyse and recommend, but the action stays with you.',
        this.safeAlternativeSentence(visibleTools),
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.access_boundary',
          source_ref: 'phase1-read-only:fixed-boundary',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'ZAC is read-only in Phase 1 — it cannot create, change, cancel or send anything. This is a product boundary, not a permission or a connection state.',
        'Nothing was changed, and nothing was read for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Make the change in QLOOQO directly — or ask me to explain the impact first.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'policy.read_only',
      },
      trace_id: traceId,
    };
  }

  /**
   * The actor may not use a capability that genuinely EXISTS and is connected.
   * Distinct from a privacy boundary (which no permission could ever lift) and
   * from unavailable data (which no permission change would fix): this is the
   * one refusal where "ask an owner to widen your access" is the true remedy.
   */
  buildPermissionDeniedResponse(
    input: MemoryResponseBaseInput & { explanation?: string },
  ): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I can't answer that at your current access level.",
        input.explanation?.trim()
          ? input.explanation.trim()
          : 'That area is connected and working — your security level just does not include the permission it needs, so an owner could open it up if you should have it.',
        this.safeAlternativeSentence(visibleTools),
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.permissions',
          source_ref: 'effective-permission-denied',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'This is a permission boundary at your current security level, not a privacy rule and not a data problem.',
        'Nothing from that area was read for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Ask an owner to review your security level if you need that area — or ask "What am I allowed to see?" for your full picture.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'policy.permission_denied',
      },
      trace_id: traceId,
    };
  }

  /**
   * ZAC does not have this capability in Phase 1 at all. Nobody's permissions
   * would help and no data would arrive to fix it — the honest statement is
   * that it is not built yet.
   */
  buildUnsupportedCapabilityResponse(
    input: MemoryResponseBaseInput & { explanation?: string; area?: string },
  ): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;
    const area = input.area?.trim();

    return {
      conversation_id: input.conversationId,
      answer: [
        area
          ? `${area} isn't something I can do in this phase of ZAC yet.`
          : "That isn't something I can do in this phase of ZAC yet.",
        input.explanation?.trim()
          ? input.explanation.trim()
          : "It's a capability that hasn't been built into ZAC yet rather than a permission you're missing or data that's temporarily down — so I won't guess at an answer.",
        this.safeAlternativeSentence(visibleTools),
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.capability',
          source_ref: 'phase1-capability-not-implemented',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'This capability is not implemented in ZAC Phase 1 — it is not a permission problem and not a temporary data outage.',
        'No data of any kind was read or invented for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step: 'Ask "What can you help me with?" to see what is available today.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'policy.unsupported_capability',
      },
      trace_id: traceId,
    };
  }

  /**
   * The capability exists, the actor is permitted, the tool ran — and the
   * SOURCE DATA was not there. Saying "you don't have permission" here sends a
   * user to their administrator over a missing rota; saying "not built yet"
   * sends them away for good. Both are false, so this reason stands alone.
   */
  buildDataUnavailableResponse(
    input: MemoryResponseBaseInput & { explanation?: string; capability?: string },
  ): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;
    const capability = input.capability?.trim();

    return {
      conversation_id: input.conversationId,
      answer: [
        capability
          ? `I can analyse ${capability}, but there isn't enough data behind it to answer that right now.`
          : "I can look at that area, but there isn't enough data behind it to answer right now.",
        input.explanation?.trim()
          ? input.explanation.trim()
          : "This is a data gap, not a permission problem — you're allowed to see it, there just isn't enough recorded yet for an honest answer, and I won't estimate one.",
        this.safeAlternativeSentence(visibleTools),
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.data_availability',
          source_ref: 'source-data-missing',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'The source data for that answer is missing or incomplete — this is not a permission boundary and not an unsupported capability.',
        'No figure was estimated, inferred or invented to fill the gap.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step:
        'Try a different period, or ask again once the underlying records are in QLOOQO.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'policy.data_unavailable',
      },
      trace_id: traceId,
    };
  }

  /**
   * Another business, or a location outside the actor's scope. Distinct from an
   * ordinary permission denial because no owner can grant it: it is the tenant
   * boundary, and telling the user to "ask an owner to review your access"
   * would send them on an errand that cannot succeed.
   */
  buildTenantBoundaryResponse(input: MemoryResponseBaseInput): ZacResponse {
    const { context, profile, visibleTools, completion, traceId } = input;

    return {
      conversation_id: input.conversationId,
      answer: [
        "I can't answer that — it's outside the business and locations your account covers.",
        'That boundary is the account itself rather than a security level, so it is not something an owner could open up for you here. Data belonging to another business is never readable through ZAC, under any phrasing.',
        this.safeAlternativeSentence(visibleTools),
      ].join('\n\n'),
      role_context: context.roleContext,
      response_type: 'Refusal / Insufficient Data',
      evidence: [
        {
          source_type: 'zac.access_boundary',
          source_ref: 'tenant-scope:fixed-boundary',
          as_of: null,
          entities_used: [],
        },
      ],
      confidence: 'high',
      limitations: [
        'This is the account/tenant boundary — not a permission that can be granted, and not a data problem.',
        'Nothing outside your business or locations was read for this answer.',
        `Your ZAC scope: ${profile.scopeDescription}`,
      ],
      suggested_next_step: 'Ask about the business and locations your account covers.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: [],
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        detected_intent: 'policy.tenant_boundary',
      },
      trace_id: traceId,
    };
  }

  /**
   * A multi-source analysis answer.
   *
   * Evidence is the UNION of every source that contributed, so the owner can
   * see the analysis rested on several parts of the business rather than one
   * report. Limitations name the sources that could not be assessed — partial
   * coverage is stated, never implied away, and never inflated into "I have no
   * live data".
   */
  buildAnalysisResponse(
    input: MemoryResponseBaseInput & {
      answer: string;
      orchestration: ZacOrchestrationResult;
      toolCalls: ZacToolDispatchTrace[];
      narrated: boolean;
      /** The cap the user asked for; the answer may contain fewer, never more. */
      requestedCount?: number;
      /** The issues this answer actually raised, after validation. */
      priorities?: ZacResolvedPriority[];
    },
  ): ZacResponse {
    const { context, profile, visibleTools, completion, traceId, orchestration } = input;
    const failed = orchestration.executions.filter((execution) => !execution.ok);
    const contributing = [...new Set(orchestration.signals.map((signal) => signal.sourceTool))];
    const priorities = input.priorities ?? [];

    // Evidence follows what was RAISED, not everything that was gathered: a
    // priority list of two should not cite five sources the user never sees.
    // Source transparency is preserved by merging every reference behind each
    // consolidated issue.
    const evidence: ZacEvidenceItem[] = dedupeEvidence(
      priorities.length > 0
        ? priorities.flatMap((priority) => priority.candidate.evidenceRefs)
        : orchestration.signals.flatMap((signal) => signal.evidenceRefs),
    );

    const limitations = [
      ...failed.map((execution) => execution.limitation ?? ''),
      ...new Set(orchestration.signals.flatMap((signal) => signal.limitations)),
    ].filter((line) => line.length > 0);

    if (contributing.length > 0) {
      limitations.push(
        `This analysis is based on ${contributing.length} live source${contributing.length === 1 ? '' : 's'} you currently have access to; it is not a complete audit of the business.`,
      );
    }
    limitations.push(`Data scope: ${profile.scopeDescription}`);

    return {
      conversation_id: input.conversationId,
      answer: input.answer,
      role_context: context.roleContext,
      response_type: severityToResponseType(orchestration.signals),
      evidence:
        evidence.length > 0
          ? evidence
          : [
              {
                source_type: 'zac.analysis',
                source_ref: 'multi-source-analysis',
                as_of: null,
                entities_used: [],
              },
            ],
      // Confidence follows COVERAGE, not the model's tone: an analysis missing
      // sources is exactly as uncertain as the gaps it could not fill.
      confidence:
        failed.length === 0 ? 'high' : failed.length >= contributing.length ? 'low' : 'medium',
      limitations,
      suggested_next_step:
        orchestration.signals.length > 0
          ? 'Ask me to go deeper on any one of these, or check back after the next reporting period.'
          : 'Ask about a specific area — rebooking, utilisation or team KPIs — and I will look at it directly.',
      measurement_hook: null,
      attribution_seed: null,
      memory_updates: [],
      tool_calls: input.toolCalls,
      cost_metadata: this.costMetadata(completion),
      technical_details: {
        ...this.technicalDetails(visibleTools, completion),
        // `foundation_mode` means "this answer is not built from live data".
        // A multi-source analysis is built from live data whether or not a
        // model put it into prose, so the deterministic answer is just as
        // live as the narrated one.
        ...(orchestration.hasLiveEvidence ? { foundation_mode: false } : {}),
        detected_intent: `analysis.${orchestration.plan.analysisIntent}`,
        ...(input.requestedCount === undefined
          ? {}
          : { requested_priority_count: input.requestedCount }),
        final_priority_count: priorities.length,
        ...(orchestration.consolidation
          ? {
              raw_signal_count: orchestration.consolidation.rawSignalCount,
              consolidated_candidate_count: orchestration.consolidation.candidates.length,
              candidate_domains: orchestration.consolidation.candidates.map((c) => c.domain),
              duplicate_signals_removed: orchestration.consolidation.duplicateSignalsRemoved,
              signals_merged: orchestration.consolidation.signalsMerged,
            }
          : {}),
      },
      trace_id: traceId,
    };
  }
}

/** "a, b and c" — Oxford-free, matches the product copy elsewhere. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Highest-severity signal decides the framing: a Risk is not an Insight. */
function severityToResponseType(signals: ZacEvidenceSignal[]): ZacResponse['response_type'] {
  if (signals.some((signal) => signal.severity === 'attention')) return 'Risk';
  if (signals.some((signal) => signal.severity === 'watch')) return 'Watch Point';
  return 'Insight';
}

/** One reference per source_ref — several signals often share a source. */
function dedupeEvidence(items: ZacEvidenceItem[]): ZacEvidenceItem[] {
  const seen = new Set<string>();
  const out: ZacEvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.source_type}|${item.source_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
