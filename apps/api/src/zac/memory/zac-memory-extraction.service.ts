import { Injectable } from '@nestjs/common';
import type { ZacRoleContext } from '../context/zac-context.types';
import type {
  ZacMemoryCommand,
  ZacMemoryKind,
  ZacMemoryRecallSubject,
} from './zac-memory.types';
import { redactForStorage } from './zac-redaction';

/**
 * Deterministic Phase 1 memory extraction — no model call, ever. Explicit
 * commands ("remember that…", "my goal is…", "I prefer…", "from now on…") are
 * the reliable cases Phase 1 promises; anything subtler stays un-captured
 * rather than guessed. Output is schema-shaped by construction (closed kind
 * vocabulary, server-derived topic slug, redacted content) and NEVER carries a
 * visibility scope — scope is resolved later from the acting role, so no text
 * can widen who sees a memory.
 */
@Injectable()
export class ZacMemoryExtractionService {
  /**
   * Explicit remember-triggers. Update-shaped phrasing ("update/change that
   * goal to 60%") counts too, flagged so capture can supersede a predecessor.
   */
  detectCommand(question: string, roleContext: ZacRoleContext): ZacMemoryCommand | null {
    const q = question.toLowerCase();

    // A question-shaped message is an ASK, not a statement to store: "How do I
    // set my revenue target to £2000?" must be answered, never captured. Only
    // an explicit imperative remember-verb overrides this ("Can you remember
    // that I prefer short answers?" is still a memory request).
    const interrogative =
      /\?\s*$/.test(question.trim()) ||
      /^(how|what|why|when|where|who|which|can|could|would|should|do|does|did|is|are|am)\b/.test(q);
    const imperativeRemember =
      /\b(please\s+)?remember\s+(that|this)\b|\bkeep in mind\b|\bdon'?t forget\b|\bmake a note\b/.test(
        q,
      ) && !/\bremember when\b/.test(q);

    const explicitRemember =
      imperativeRemember ||
      (!interrogative &&
        /\b(please\s+)?remember\b(?!\s+when)|\bfrom now on\b/.test(q));
    const statesGoal =
      !interrogative &&
      /\b(my|our)\s+(?:[\w-]+\s+){0,3}(goal|target|priority|focus)\b[^.?]*\b(is|are)\b/.test(q);
    const updateIntent =
      !interrogative &&
      (/\b(update|change|revise|set|make)\b[^.?]*\b(goal|target|priority|preference|focus)\b[^.?]*\bto\b/.test(
        q,
      ) ||
        /\bactually\b[^.?]*\b(goal|target|priority)\b/.test(q));
    // Narrow implicit case (Phase 1 scope): a stylist stating a confidence /
    // improvement aspiration as a statement, not a question.
    const stylistAspiration =
      roleContext === 'stylist' &&
      !interrogative &&
      /\bi (want|would like) to (get|be|become|feel) (more\s+)?(confident|better|comfortable)\b/.test(
        q,
      );

    if (!explicitRemember && !statesGoal && !updateIntent && !stylistAspiration) {
      return null;
    }
    // A memory RECALL question ("what goal did I give you?") is not a command.
    if (this.detectRecallSubject(question) !== null) {
      return null;
    }

    const kind = this.classifyKind(q, roleContext);
    const topic = this.inferTopic(q, kind);
    const statedValue = this.extractStatedValue(q);

    return {
      kind,
      topic,
      content: this.cleanClause(question),
      updateIntent,
      statedValue,
    };
  }

  /**
   * Memory-recall questions get answered from persisted memory, never from a
   * report tool and never from model imagination. Checked BEFORE all other
   * routing, so "what do you remember about the team?" cannot fall into the
   * staff-list intent.
   */
  detectRecallSubject(question: string): ZacMemoryRecallSubject | null {
    const q = question.toLowerCase();
    const asksMemory =
      /\bwhat (do|can|did) you (remember|know|recall)\b|\bdo you remember\b|\bwhat (have|did) (i|we) (told|tell|asked|ask) you\b|\bwhat did i (just )?(tell|give|ask)\b/.test(
        q,
      );

    if (
      /\bwhat (goal|goals|target|targets)\b.*\b(give|gave|set|told|tell)\b|\bwhat (are|is|'s)\s+(my|our)\s+(current\s+)?(goal|goals|priorit(y|ies)|target|targets)\b/.test(
        q,
      )
    ) {
      return 'goals';
    }
    if (
      /\bwhat\b.*\b(communication\s+)?preferences?\b.*\b(have|did)\s+i\b|\bwhat\b.*\bpreferences?\b.*\b(given|give|asked|ask|told|tell)\b|\bwhat (have|did) i asked? you to remember about (how|answers)\b/.test(
        q,
      )
    ) {
      return 'preferences';
    }
    if (!asksMemory) return null;
    if (/\babout (the |my |our )?(team|staff|stylists)\b/.test(q)) return 'about_team';
    if (/\babout (my|the|our|this) (business|salon)\b/.test(q)) return 'about_business';
    return 'about_me';
  }

  /**
   * Kind classification inside a detected command. Order matters: stylist
   * coaching language wins for stylists, preference language wins everywhere,
   * team-coaching language routes managers/owners to a team theme.
   */
  private classifyKind(q: string, roleContext: ZacRoleContext): ZacMemoryKind {
    if (/\bi prefer\b|\bpreference\b|\b(concise|short|brief|detailed|longer) (answers?|replies|responses)\b|\btone\b/.test(q)) {
      return 'user_preference';
    }
    if (
      roleContext === 'stylist' &&
      /\b(struggle|confident|comfortable|coaching|coach me|improve|better at)\b/.test(q)
    ) {
      return 'coaching_focus';
    }
    if (
      roleContext !== 'stylist' &&
      /\b(coach|coaching|develop|theme)\b[^.?]*\b(the\s+)?team\b|\bteam\b[^.?]*\b(coach|coaching|theme|focus)\b/.test(q)
    ) {
      return 'manager_team_theme';
    }
    if (/\bpriorit/.test(q)) return 'business_priority';
    if (/\b(goal|target)\b/.test(q)) return 'business_goal';
    if (/\b(keeps? (happening|coming back)|recurring|again and again|every (week|month))\b/.test(q)) {
      return 'recurring_problem';
    }
    if (/\b(struggle|problem|issue)\b/.test(q)) {
      return roleContext === 'stylist' ? 'coaching_focus' : 'recurring_problem';
    }
    if (/\b(decided|decision|we agreed|i chose)\b/.test(q)) return 'prior_decision';
    // Generic "keep in mind X": a stated fact/decision, personal by default for
    // stylists (scope resolution keeps it private regardless).
    return 'prior_decision';
  }

  /** Subject slug for dedup + relevance. Server-derived, never user free text. */
  inferTopic(text: string, kind: ZacMemoryKind): string {
    const q = text.toLowerCase();
    if (kind === 'user_preference') {
      if (/\b(concise|short|brief|detailed|longer|tone|answers?|replies|responses|communication)\b/.test(q)) {
        return 'communication_style';
      }
      return 'general';
    }
    if (/\brebook/.test(q)) return 'rebooking';
    if (/\b(colou?r|waste|qlab)\b/.test(q)) return 'colour_waste';
    if (/\b(revenue|takings|turnover|sales)\b/.test(q)) return 'revenue';
    if (/\bretail\b/.test(q)) return 'retail';
    if (/\b(utili[sz]ation|capacity)\b/.test(q)) return 'utilisation';
    if (/\b(retention|returning clients?)\b/.test(q)) return 'retention';
    if (/\b(schedule|diary|rota)\b/.test(q)) return 'scheduling';
    if (/\b(stock|inventory|order)\b/.test(q)) return 'stock';
    return 'general';
  }

  /**
   * The clause worth keeping: strip the remember-preamble and politeness, keep
   * the substance, redact and cap. "Please remember that my main goal this
   * month is to increase rebooking to 60%." → "My main goal this month is to
   * increase rebooking to 60%."
   */
  private cleanClause(question: string): string {
    let clause = question.trim();
    clause = clause.replace(
      /^(please\s+)?(can you\s+|could you\s+)?(remember|note|keep in mind)(\s+that|\s+this)?[,:\s]+/i,
      '',
    );
    clause = clause.replace(/[.\s]+please remember( that| this|.*)?$/i, '.');
    clause = clause.replace(/^please\s+/i, '');
    clause = clause.trim();
    if (clause.length > 0) {
      clause = clause[0].toUpperCase() + clause.slice(1);
    }
    if (!/[.!?]$/.test(clause) && clause.length > 0) clause = `${clause}.`;
    return redactForStorage(clause);
  }

  /**
   * The value the user is SETTING, for update synthesis. "Change my 2025
   * rebooking target to 65%" must yield '65%', not the year — the token after
   * "to" wins, then the LAST number as fallback. Currency symbols survive.
   */
  private extractStatedValue(q: string): string | null {
    const afterTo = q.match(/\bto\b\s*(£?\d+(?:\.\d+)?\s?%?)/);
    if (afterTo) return afterTo[1].replace(/\s/g, '');
    const all = q.match(/£?\d+(?:\.\d+)?\s?%?/g);
    return all && all.length > 0 ? all[all.length - 1].replace(/\s/g, '') : null;
  }
}
