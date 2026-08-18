import { Injectable } from '@nestjs/common';
import type { ZacRoleContext } from '../context/zac-context.types';
import { ZacMemoryExtractionService } from '../memory/zac-memory-extraction.service';
import type {
  ZacDataInstruction,
  ZacRequestClassification,
  ZacRequestMode,
} from './zac-request-mode.types';

/**
 * Deterministic request-mode classification — the authoritative first layer.
 *
 * Precedence (highest first):
 *   1. memory recall questions (single source of truth: the memory extractor);
 *   2. explicit current-turn data instructions ("forget my QLOOQO data",
 *      "use my actual figures") — these always beat keyword inference AND
 *      stale conversation context;
 *   3. permission/capability-boundary questions;
 *   4. capability/identity questions (kept on the existing capability tool);
 *   5. hypothetical framing (suppose/imagine/what-if/fictional, or "if" with
 *      supplied numbers);
 *   6. general-advice framing (leading "generally", indefinite subjects —
 *      business NOUNS alone never force a data tool);
 *   7. conversational acknowledgements and follow-ups;
 *   8. possessive/imperative data anchors ("my rebooking", "show revenue");
 *   9. everything else is AMBIGUOUS — the orchestrator may consult the model
 *      (validated against the closed enum) and otherwise falls back to
 *      qlooqo_data, which is exactly the pre-mode pipeline and therefore the
 *      safest default (its own routing still ends in the capability answer
 *      for unmatched questions).
 *
 * The classifier reads ONLY the current question text and role context. It
 * grants nothing: every tool dispatch downstream re-checks role + permissions.
 */
@Injectable()
export class ZacRequestModeClassifierService {
  constructor(private readonly memoryExtraction: ZacMemoryExtractionService) {}

  /** Deterministic layers. `null` = genuinely ambiguous (caller may ask the model). */
  classify(question: string, roleContext: ZacRoleContext): ZacRequestClassification | null {
    void roleContext;
    const q = question.toLowerCase();

    if (this.memoryExtraction.detectRecallSubject(question) !== null) {
      return { mode: 'memory', source: 'deterministic', dataInstruction: null };
    }

    const dataInstruction = this.detectDataInstruction(q);
    if (dataInstruction === 'use_data') {
      return { mode: 'qlooqo_data', source: 'deterministic', dataInstruction };
    }
    if (dataInstruction === 'ignore_data') {
      // "Ignore my data" + a supplied scenario reads hypothetically; otherwise
      // the user wants general reasoning. Either way NO business tool runs.
      // The lax shape check applies: the user already said to set data aside,
      // so possessive figures inside the scenario stay hypothetical.
      return {
        mode: this.hasHypotheticalShape(q, false) ? 'hypothetical' : 'general_advice',
        source: 'deterministic',
        dataInstruction,
      };
    }

    if (this.isPermissionQuestion(q)) {
      return { mode: 'permission_capability', source: 'deterministic', dataInstruction: null };
    }

    // Capability/identity stays on the existing capability tool inside the
    // data pipeline ("what can you do", "who are you").
    if (
      /what can (you|zac|i ask)|help me with|what do you do|what can you do|capabilit|who are you\b/.test(
        q,
      )
    ) {
      return { mode: 'qlooqo_data', source: 'deterministic', dataInstruction: null };
    }

    if (this.hasHypotheticalShape(q, true)) {
      return { mode: 'hypothetical', source: 'deterministic', dataInstruction: null };
    }

    if (this.isGeneralAdviceQuestion(q)) {
      return { mode: 'general_advice', source: 'deterministic', dataInstruction: null };
    }

    // Conversational rules yield to an own-data anchor: "why do you think MY
    // rebooking is low?" is a diagnosis request, not chat about the dialogue.
    if (this.isConversational(q) && !this.hasOwnDataAnchor(q)) {
      return { mode: 'conversational', source: 'deterministic', dataInstruction: null };
    }

    if (this.hasOwnDataAnchor(q)) {
      return { mode: 'qlooqo_data', source: 'deterministic', dataInstruction: null };
    }

    return null;
  }

  /** True for bare acknowledgements that deserve a reply but never a model call. */
  isPureAcknowledgement(question: string): boolean {
    // Up to three ack words with separators covers compounds ("Ok, thanks!",
    // "Great, thank you.", "Sounds good."). Anything more is a real message.
    return /^\s*(?:(?:thanks(?: a lot| so much)?|thank you(?: very much)?|ok(?:ay)?|great|perfect|cool|got it|nice|brilliant|lovely|cheers|sounds good|will do|understood)[\s,!.—-]*){1,3}$/i.test(
      question,
    );
  }

  /**
   * Explicit current-turn instructions about the user's own data. Checked
   * before everything except memory recall, so "ignore my QLOOQO data —
   * generally, how..." can never be dragged into a tool by its nouns.
   */
  private detectDataInstruction(q: string): ZacDataInstruction {
    // use_data is tested FIRST and wins ties: when a message carries both
    // ("ignore industry averages and use my actual figures"), wrongly ignoring
    // the user's data is the harmful direction.
    if (
      /\b(use|using|based on|from|with|check|look at|pull)\b[^.?!]*\bmy\b[^.?!]*\b(actual|real|current|live|qlooqo)\b[^.?!]*\b(data|figures?|numbers?|stats|performance|salon|business)\b/.test(
        q,
      ) ||
      /\bmy (actual|real) (salon|business|qlooqo) data\b/.test(q) ||
      /\bdon'?t give me generic advice\b/.test(q) ||
      /\buse my (data|figures?|numbers?)\b/.test(q)
    ) {
      return 'use_data';
    }
    // Clause-bound on purpose: the verb must govern the data noun in the SAME
    // clause. "Ignore that, show me my numbers" is a retraction plus a data
    // request — commas/semicolons/dashes break the match.
    if (
      /\b(forget|ignore|don'?t use|do not use|without( using)?|leave (out|aside)|put aside|set aside)\b[^.?!,;:—–]*\b(qlooqo|the data|my data|current data|real data|actual data|data|numbers?|figures?|stats)\b/.test(
        q,
      ) ||
      /\bnot (about|using|from) my (data|numbers?|figures?)\b/.test(q)
    ) {
      return 'ignore_data';
    }
    return null;
  }

  /**
   * Permission-boundary questions: what the ACTOR may/may not see or do.
   * Deliberately narrower than capability questions ("what can you do") and
   * self-data questions ("can I see my appointments?" is a diary ask).
   */
  private isPermissionQuestion(q: string): boolean {
    if (/\b(allowed|permitted|not allowed)\b[^.?!]*\b(to )?(see|access|view|know)\b/.test(q)) {
      return true;
    }
    if (/\bwhat\b[^.?!]*\b(am i|are we)\b[^.?!]*\b(allowed|permitted)\b/.test(q)) return true;
    if (/\bmy permissions?\b|\bbased on my permissions?\b/.test(q)) return true;
    if (/\bpermissions?\b[^.?!]*\b(see|access|view|boundar|allow)\b/.test(q)) return true;
    if (
      /\bwhy can'?t (i|you)\b[^.?!]*\b(see|show|access|view|tell)\b/.test(q) &&
      // "...my appointments/diary" is a diary problem, not a permission ask.
      !/\bmy (schedule|diary|appointments?|day|week|kpis?|numbers?|performance)\b/.test(q)
    ) {
      return true;
    }
    if (/\bwhat (can|do) you (access|see|read)\b/.test(q)) return true;
    if (/\bwhat can('t| not)? i (see|access|view)\b/.test(q)) return true;
    // "Can I see X?" is a permission question only when X is clearly
    // restricted-flavoured (others' data, coaching, pay, financials) — plain
    // "what locations can I see?" is a data question and stays on its tool.
    if (
      /\bcan i (see|view|access)\b[^.?!]*\b(coaching|conversations?|private|other|everyone|payroll|salar\w*|wages?|financial\w*|owner)\b/.test(
        q,
      )
    ) {
      return true;
    }
    return false;
  }

  /**
   * Hypothetical framing: explicit markers, or a conditional with supplied
   * numbers. `strict` (the standalone branch) refuses conditionals that are
   * really indirect DATA questions — "tell me if my revenue is above £2000" —
   * by rejecting report-me lead-ins and possessive subjects; the lax form
   * (used under an explicit ignore-data instruction) keeps "if I were at 40%,
   * how would I reach my 60% goal" hypothetical.
   */
  private hasHypotheticalShape(q: string, strict: boolean): boolean {
    if (/\bhypothetical(ly)?\b|\bsuppose\b|\bimagine\b|\bwhat if\b|\bfictional\b|\bfor (the sake of )?argument\b/.test(q)) {
      return true;
    }
    const conditional =
      /\bif\b[^.?!]*\b(was|were|is|are|has|have|had|earns?|sees?|takes?|achiev\w*|dropped|fell|rose|hit|reached|went|dipped|climbed)\b[^.?!]*\d/.test(
        q,
      );
    if (!conditional) return false;
    if (!strict) return true;
    // "tell/check/let me know if..." reports on live data; "if my X is..."
    // asks about their real figures. Both belong on the data pipeline.
    if (/\b(tell|check|know|see|ask|wondering|let me know|alert|notify)\b[^.?!]{0,25}\bif\b/.test(q)) {
      return false;
    }
    if (/\bif\b[^.?!]{0,30}\b(my|our)\b/.test(q)) return false;
    return true;
  }

  /**
   * General advice: the user asks how salons/stylists/managers IN GENERAL
   * work — indefinite subjects, "ways to", best practices. Business nouns
   * (rebooking, revenue, utilisation) do NOT force a data tool; what matters
   * is that the user is not asking about their own figures.
   */
  private isGeneralAdviceQuestion(q: string): boolean {
    // "in general"/"generally" yields to an own-data anchor: "How is my
    // business doing in general?" means "overall", and is a data question.
    if (
      (/^\s*(generally|in general)\b/.test(q) || /\bin general\b/.test(q)) &&
      !this.hasOwnDataAnchor(q)
    ) {
      return true;
    }
    if (
      /\bwhat (are|is) (some|a few|three|four|five|\d+|good|effective|practical|proven|the best)\s+(?:[\w-]+\s+){0,2}(ways?|tips?|methods?|approaches|strategies|practices?|ideas)\b/.test(
        q,
      )
    ) {
      return true;
    }
    if (/\bbest practices?\b|\btips (for|on)\b|\brules? of thumb\b/.test(q)) return true;
    if (/\bwhat (generally|typically|usually|normally|often) (causes?|drives?|helps?|leads? to|explains?)\b/.test(q)) {
      return true;
    }
    // Official Manager acceptance phrasings: coaching-conversation guidance is
    // advice (reasoned, tool-free), not a data lookup.
    if (
      /\bwhat coaching conversation\b|\bcoaching conversation should i\b|\bhow should i coach\b|\bwhat should success look like\b/.test(
        q,
      )
    ) {
      return true;
    }
    // "How should a salon manager..." / "How do salons..." — indefinite
    // subject, and no possessive anchor pulling it back to their business.
    if (
      /\bhow (should|can|do|does|would|might) (a|an) (salon|stylist|manager|business|team|receptionist)\b/.test(q) ||
      /\bhow (should|can|do|does|would|might) (salons?|stylists?|managers?|businesses)\b/.test(q)
    ) {
      return !/\bmy\b|\bour\b/.test(q);
    }
    return false;
  }

  /** Conversational: acknowledgements and meta/follow-up requests about the dialogue itself. */
  private isConversational(q: string): boolean {
    if (this.isPureAcknowledgement(q)) return true;
    if (/\b(explain|put) (that|this|it)\b[^.?!]*\b(simpl\w+|again|more|differently)\b/.test(q)) return true;
    if (/\bin simpler terms\b|\bmore simply\b|\bplain english\b/.test(q)) return true;
    if (/\bwhat do you mean\b|\bcan you (rephrase|clarify|elaborate|expand)\b|\btell me more\b/.test(q)) {
      return true;
    }
    // Deictic required: "why did you recommend THAT" is meta; "why do you
    // think my rebooking is low" is a diagnosis request for the data pipeline.
    if (/\bwhy (did|do) you (say|recommend|suggest|think) (that|this|it|so)\b/.test(q)) return true;
    // "Why is it so quiet on Mondays?" uses dummy-subject 'it', and "why is
    // this stylist underperforming?" uses 'this' as a determiner — both are
    // DATA questions, not dialogue meta. Business-activity words and a
    // person/business noun after the pronoun veto the deictic reading.
    if (
      /^\s*why (is|does|would) (that|this|it)\b(?!\s+(stylists?|staff|team|members?|colleagues?|salon|business|location))/.test(
        q,
      ) &&
      !/\b(quiet|quietest|slow|slowest|dead|empty|busy|busiest)\b/.test(q)
    ) {
      return true;
    }
    // "What evidence supports that?" — a meta question about ZAC's previous
    // answer, answered from conversation context, never a fresh tool run.
    if (/\bwhat evidence\b[^.?!]*\b(that|this|it)\b/.test(q)) return true;
    return false;
  }

  /**
   * The user's OWN business data: possessive/self anchors with a business
   * noun, imperatives ("show/list..."), or bare staff-list phrases. These keep
   * the pre-mode pipeline behaviour, including the stylist restricted router
   * and the honest staff-not-connected answer.
   */
  private hasOwnDataAnchor(q: string): boolean {
    const businessNoun =
      /\b(business|salon|revenue|takings|turnover|sales|rebook\w*|booking?s?|appointments?|schedule|diary|team|staff|stylists?|colleagues?|members?|kpis?|perform\w*|clients?|utili[sz]ation|stock|inventory|locations?|targets?|figures?|numbers?|health)\b/;
    if (/\b(my|our|we|us)\b/.test(q) && businessNoun.test(q)) return true;
    // Imperatives count at the start of the message OR of a clause
    // ("Forget last week, show me this week's numbers").
    if (/(^|[,;:—–]\s*)(show|list|give me|pull|get)\b/.test(q) && businessNoun.test(q)) return true;
    if (/\bwho works\b|\bstaff list\b|\bteam members?\b|\bthe (whole |entire )?(business|salon)\b/.test(q)) {
      return true;
    }
    if (/\b(what|which|how many) locations?\b/.test(q)) return true;
    if (/\bwhich (stylists?|staff|team members?|colleagues?)\b/.test(q)) return true;
    // First-person work questions — the stylist coaching/diary territory the
    // downstream router handles. Deterministic on purpose: these are pinned
    // product behaviours, so the model tie-break must never see them.
    if (
      /\bhow am i (doing|performing)\b|\bwhat should i focus\b|\bhow can i improve\b|\bam i on track\b|\bappointments? (do|have) i\b|\b(do|have) i (have|got)\b/.test(
        q,
      )
    ) {
      return true;
    }
    return false;
  }

  /** Guard for the model layer: only closed-enum values survive. */
  static isValidMode(candidate: string | null | undefined): candidate is ZacRequestMode {
    return (
      candidate === 'qlooqo_data' ||
      candidate === 'general_advice' ||
      candidate === 'hypothetical' ||
      candidate === 'memory' ||
      candidate === 'permission_capability' ||
      candidate === 'conversational'
    );
  }
}
