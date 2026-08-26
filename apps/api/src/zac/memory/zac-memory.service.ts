import { Injectable, Logger } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacCostTelemetryService } from '../measurement/zac-cost-telemetry.service';
import type { ZacMemoryScope } from '../responses/zac-response.types';
import { ZacMemoryStore } from '../persistence/zac-memory.store';
import { ZacMemoryExtractionService } from './zac-memory-extraction.service';
import type {
  ZacMemoryCommand,
  ZacMemoryItem,
  ZacMemoryKind,
  ZacMemoryRecallSubject,
} from './zac-memory.types';
import { ZAC_MEMORY_KIND_LABELS } from './zac-memory.types';

/** Hard cap on memories entering any prompt or recall answer. */
const MAX_RELEVANT_MEMORIES = 5;

export interface ZacMemoryCaptureResult {
  item: ZacMemoryItem;
  supersededCount: number;
}

/**
 * The Phase 1 memory brain: server-side scope resolution, capture with
 * supersession (one active memory per kind+topic+owner), and deterministic
 * relevance retrieval under the acting user's CURRENT role and location scope.
 *
 * The privacy invariants live here and are covered by tests:
 * - stylist_private is retrievable ONLY by the actor who owns it — an owner or
 *   manager role never widens into it;
 * - user_private is per-actor;
 * - business scopes require an owner/manager role NOW (stale conversations or
 *   old memories never outrank current permissions);
 * - manager_team_theme respects the manager's current location scope.
 */
@Injectable()
export class ZacMemoryService {
  private readonly logger = new Logger(ZacMemoryService.name);

  constructor(
    private readonly store: ZacMemoryStore,
    private readonly extraction: ZacMemoryExtractionService,
    private readonly telemetry: ZacCostTelemetryService,
  ) {}

  /**
   * Persist an extracted command. Scope comes from role+kind rules here —
   * never from the message. Supersedes any active memory with the same
   * kind+topic+owner so goals update instead of contradicting.
   */
  async capture(
    context: ZacActingContext,
    command: ZacMemoryCommand,
    conversationId: string | null,
    traceId: string,
  ): Promise<ZacMemoryCaptureResult> {
    const visibilityScope = this.resolveScope(context, command.kind);
    const kind = this.downgradeKindForRole(context, command.kind);

    const existing = await this.store.listActiveForBusiness(context.businessId);
    const visible = existing.filter((item) => this.canSee(context, item));

    // Resolve the predecessor: same kind+topic+owner. An update-shaped command
    // with no inferable topic ("update that goal to 60%") inherits the topic of
    // the most recent matching memory — same conversation first.
    let topic = command.topic;
    const predecessorPool = visible.filter(
      (item) => item.kind === kind && this.sameOwner(context, item, visibilityScope),
    );
    if (topic === 'general' && command.updateIntent && predecessorPool.length > 0) {
      const sameConversation = predecessorPool.find(
        (item) => conversationId && item.sourceConversationId === conversationId,
      );
      topic = (sameConversation ?? predecessorPool[0]).topic;
    }
    const superseded = predecessorPool.filter((item) => item.topic === topic);

    // A bare-value update ("update that goal to 60%") produces an unreadable
    // clause; synthesise a proper summary from the predecessor's subject.
    let content = command.content;
    if (command.updateIntent && command.statedValue && superseded.length > 0) {
      const hasSubstance = command.content.length > 40 || topic !== 'general';
      if (!hasSubstance || /^(update|change|make|set|revise)\b.*\bto\b/i.test(command.content)) {
        content = `${ZAC_MEMORY_KIND_LABELS[kind]} (${topic.replace(/_/g, ' ')}): ${command.statedValue}.`;
      }
    }

    const item = await this.store.insert({
      businessId: context.businessId,
      locationId: visibilityScope === 'manager_team_theme' ? this.teamLocationId(context) : null,
      actorUserId: context.actorUserId,
      roleContext: context.roleContext,
      visibilityScope,
      kind,
      topic,
      content,
      sourceConversationId: conversationId,
    });

    if (superseded.length > 0) {
      // The new memory is already committed — a supersede failure must not
      // surface as "nothing was stored" (that would be false). Degrade to two
      // temporarily-active rows and say so loudly in telemetry.
      try {
        await this.store.supersede(
          context.businessId,
          superseded.map((memory) => memory.id),
          item.id,
        );
        this.telemetry.recordSpineEvent('memory_superseded', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          kind,
          superseded_count: superseded.length,
        });
      } catch (error) {
        this.logger.error(`zac memory supersede failed: ${(error as Error).message}`);
        this.telemetry.recordSpineEvent('persistence_failed', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          operation: 'memory_supersede',
        });
      }
    }

    this.telemetry.recordSpineEvent('memory_created', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      kind,
      visibility_scope: visibilityScope,
      topic,
    });

    return { item, supersededCount: superseded.length };
  }

  /** Recall for explicit memory questions ("what do you remember about…"). */
  async recall(
    context: ZacActingContext,
    subject: ZacMemoryRecallSubject,
    traceId: string,
  ): Promise<ZacMemoryItem[]> {
    const visible = await this.listVisible(context);
    const matches = visible.filter((item) => this.matchesSubject(context, item, subject));
    const result = matches.slice(0, MAX_RELEVANT_MEMORIES);
    this.telemetry.recordSpineEvent('memory_retrieved', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      subject,
      memory_count: result.length,
    });
    return result;
  }

  /**
   * Relevant memory for a NORMAL question — deliberately narrow so unrelated
   * memories never pad the prompt. Communication-style preferences always
   * apply (they shape every answer); everything else needs a topic or an
   * improvement-shaped question to earn its place. Fail-soft: retrieval
   * problems return [] and the turn continues without memory.
   */
  async retrieveRelevant(
    context: ZacActingContext,
    question: string,
    traceId: string,
  ): Promise<ZacMemoryItem[]> {
    try {
      const visible = await this.listVisible(context);
      if (visible.length === 0) return [];

      const questionTopic = this.extraction.inferTopic(question, 'business_goal');
      const improvementShaped = /\b(improve|focus|better|grow|increase|target|goal)\b/i.test(
        question,
      );

      const stylePreferences = visible.filter(
        (item) => item.kind === 'user_preference' && item.topic === 'communication_style',
      );
      const topical = visible.filter(
        (item) =>
          item.topic !== 'general' &&
          item.topic === questionTopic &&
          item.kind !== 'user_preference',
      );
      const goals = improvementShaped
        ? visible.filter(
            (item) =>
              (item.kind === 'business_goal' || item.kind === 'coaching_focus') &&
              !topical.includes(item),
          )
        : [];

      const result = [...topical, ...goals, ...stylePreferences].slice(0, MAX_RELEVANT_MEMORIES);
      if (result.length > 0) {
        this.telemetry.recordSpineEvent('memory_retrieved', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          subject: 'relevance',
          memory_count: result.length,
        });
      }
      return result;
    } catch (error) {
      this.logger.error(`zac memory retrieval failed: ${(error as Error).message}`);
      return [];
    }
  }

  /** All active memories the acting user may see under their CURRENT role. */
  private async listVisible(context: ZacActingContext): Promise<ZacMemoryItem[]> {
    const all = await this.store.listActiveForBusiness(context.businessId);
    return all.filter((item) => this.canSee(context, item));
  }

  /**
   * The visibility matrix. Deny-by-default: anything unrecognised is invisible.
   * Note stylist_private admits ONLY the owning actor — role is irrelevant.
   */
  private canSee(context: ZacActingContext, item: ZacMemoryItem): boolean {
    if (item.businessId !== context.businessId) return false;
    switch (item.visibilityScope) {
      case 'user_private':
      case 'stylist_private':
        return item.actorUserId === context.actorUserId;
      case 'business_owner':
        return context.roleContext === 'owner' || context.roleContext === 'manager';
      case 'manager_team_theme':
        if (context.roleContext === 'owner') return true;
        if (context.roleContext !== 'manager') return false;
        // A theme with no resolvable location must FAIL CLOSED for other
        // managers: only its author (and owners, above) can see it. Otherwise a
        // multi-location manager's theme would broadcast to every manager in
        // the business.
        return item.locationId === null
          ? item.actorUserId === context.actorUserId
          : context.accessibleLocationIds.includes(item.locationId);
      default:
        return false;
    }
  }

  /**
   * Server-side scope rules — the heart of the privacy model:
   * - preferences are always private to the actor;
   * - stylist coaching is stylist_private (the hard Phase 1 requirement);
   * - stylists can never create business- or team-visible memory;
   * - owner business statements are business-visible; manager business
   *   statements stay within their team scope.
   */
  resolveScope(context: ZacActingContext, kind: ZacMemoryKind): ZacMemoryScope {
    if (kind === 'user_preference') return 'user_private';
    if (context.roleContext === 'stylist') {
      return kind === 'coaching_focus' ? 'stylist_private' : 'user_private';
    }
    if (kind === 'coaching_focus') return 'user_private';
    if (kind === 'manager_team_theme') return 'manager_team_theme';
    if (context.roleContext === 'owner') return 'business_owner';
    return 'manager_team_theme';
  }

  /** A stylist's "team theme" is not a team theme — keep it personal. */
  private downgradeKindForRole(context: ZacActingContext, kind: ZacMemoryKind): ZacMemoryKind {
    if (context.roleContext === 'stylist' && kind === 'manager_team_theme') {
      return 'coaching_focus';
    }
    return kind;
  }

  /** Supersession owner-match must mirror canSee's write-side semantics. */
  private sameOwner(
    context: ZacActingContext,
    item: ZacMemoryItem,
    scope: ZacMemoryScope,
  ): boolean {
    if (item.visibilityScope !== scope) return false;
    switch (scope) {
      case 'user_private':
      case 'stylist_private':
        return item.actorUserId === context.actorUserId;
      case 'business_owner':
        return true; // one shared goal-space per business
      case 'manager_team_theme':
        return item.locationId === this.teamLocationId(context);
      default:
        return false;
    }
  }

  private teamLocationId(context: ZacActingContext): string | null {
    if (context.locationId) return context.locationId;
    return context.accessibleLocationIds.length === 1 ? context.accessibleLocationIds[0] : null;
  }

  private matchesSubject(
    context: ZacActingContext,
    item: ZacMemoryItem,
    subject: ZacMemoryRecallSubject,
  ): boolean {
    switch (subject) {
      case 'goals':
        return (
          item.kind === 'business_goal' ||
          item.kind === 'business_priority' ||
          (item.kind === 'coaching_focus' && item.actorUserId === context.actorUserId)
        );
      case 'preferences':
        return item.kind === 'user_preference' && item.actorUserId === context.actorUserId;
      case 'about_me':
        // Everything the actor personally stated, across any scope they own.
        return item.actorUserId === context.actorUserId;
      case 'about_business':
        return item.visibilityScope === 'business_owner' || item.visibilityScope === 'manager_team_theme';
      case 'about_team':
        // Team recall NEVER includes stylist_private items — canSee already
        // excludes other actors' private rows; this also excludes the asker's
        // own private coaching from a team-framed answer.
        return item.visibilityScope === 'manager_team_theme';
      default:
        return false;
    }
  }
}
