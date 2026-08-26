import { Injectable } from '@nestjs/common';
import type { ZacRoleContext } from '../context/zac-context.types';
import { ZacMemoryExtractionService } from '../memory/zac-memory-extraction.service';
import { ZacResourceCategoryService } from '../policy/zac-resource-category.service';
import type {
  ZacDataInstruction,
  ZacDeterministicVerdict,
  ZacRequestMode,
} from './zac-request-mode.types';
import { isZacRequestMode } from './zac-request-mode.types';

/**
 * Deterministic request-mode rules — Layers 1 and 3 of the hybrid router.
 *
 * This service answers two different questions, and the difference matters:
 *
 *   classifyExplicit()  — Layer 1. Only rules that are LINGUISTICALLY EXPLICIT:
 *                         the user stated their intent, so no model is needed
 *                         and none is called. These short-circuit, which is
 *                         what keeps routing cheap and fast for the common
 *                         cases.
 *
 *   classifyHeuristic() — Layer 3. The older keyword/shape heuristics. They are
 *                         useful but NOT authoritative: an English sentence can
 *                         match them and still mean something else. They run
 *                         only when the semantic layer could not decide (no
 *                         provider, timeout, refusal, malformed output, low
 *                         confidence), so a build with no model key still
 *                         behaves at least as well as the pre-semantic router.
 *
 * Between the two sits {@link ZacSemanticRouterService}, which reasons about
 * meaning. That ordering is deliberate: previous iterations of this file tried
 * to express meaning in regexes and could only ever recognise the phrasings
 * someone had thought of. Natural paraphrases now go to the semantic layer.
 *
 * The classifier reads ONLY the question text and the role LENS. It grants
 * nothing: every tool dispatch downstream re-checks role + permissions.
 */
@Injectable()
export class ZacRequestModeClassifierService {
  constructor(
    private readonly memoryExtraction: ZacMemoryExtractionService,
    private readonly resourceCategories: ZacResourceCategoryService = new ZacResourceCategoryService(),
  ) {}

  /**
   * Layer 1. A verdict here is treated as final and skips the model entirely.
   * `null` means "not explicit" — the semantic layer decides.
   */
  classifyExplicit(question: string, roleContext: ZacRoleContext): ZacDeterministicVerdict | null {
    const q = normalise(question);

    // 1. Memory recall — the memory extractor is the single source of truth.
    if (this.memoryExtraction.detectRecallSubject(question) !== null) {
      return certain('memory', 'user_memory_recall', null);
    }

    // 1b. A reach for ANOTHER person's private material. This runs before the
    //     own-data rules on purpose: "show me Sarah's private coaching" carries
    //     a possessive and an imperative, so the own-data anchor below would
    //     otherwise claim it with certainty and send a privacy probe into the
    //     live-data pipeline. Own-memory recall above still wins, because a
    //     question about the ASKER's own history is never this.
    const protectedTarget = this.resourceCategories.classify(question, roleContext);
    if (
      protectedTarget?.certain &&
      (protectedTarget.category === 'private_other_stylist_coaching' ||
        protectedTarget.category === 'private_other_actor_conversation')
    ) {
      return certain('privacy_boundary', 'privacy_boundary_probe', null);
    }

    // 2. Explicit current-turn instruction about the user's own data. Resolved
    //    by CLAUSE DIRECTION, not by substring presence — see analyseDataInstruction.
    const dataInstruction = this.analyseDataInstruction(q);
    if (dataInstruction === 'use_data') {
      return certain('qlooqo_data', 'explicit_live_data_request', 'use_data');
    }
    if (dataInstruction === 'ignore_data') {
      // The user has already excluded their data, so a supplied scenario reads
      // hypothetically even when it uses "my"; otherwise they want the general
      // case. Either way NO operational tool can run for this turn.
      return certain(
        this.suppliesScenario(q) ? 'hypothetical' : 'general_advice',
        'explicit_ignore_live_data',
        'ignore_data',
      );
    }

    // 3. Bare acknowledgements — unambiguous, and must never cost a model call.
    if (this.isPureAcknowledgement(question)) {
      return certain('conversational', 'conversation_followup', null);
    }

    // 4. Explicit permission-boundary questions. These come BEFORE hypothetical
    //    framing: "hypothetically, what am I allowed to see?" is still about
    //    the actor's REAL access boundary and must be answered from their
    //    effective permissions, never imagined by the model.
    if (this.isPermissionQuestion(q)) {
      return certain('permission_capability', 'capability_question', null);
    }

    // 5. Capability/identity ("what can you do", "who are you"). Pinned
    //    product behaviour: these are answered by the capability summary —
    //    ZAC's own metadata, not operational business data — so they are
    //    decided here and the semantic layer never sees them.
    if (this.isCapabilityQuestion(q)) {
      return certain('qlooqo_data', 'capability_question', null);
    }

    // 6. Explicit hypothetical framing: the user marked the scenario as supposed.
    if (this.hasExplicitHypotheticalMarker(q)) {
      return certain('hypothetical', 'hypothetical_scenario', null);
    }

    // 7. Explicit general framing — indefinite subject or "in general", with no
    //    possessive pulling it back to their own figures.
    if (this.isExplicitGeneralFraming(q)) {
      return certain('general_advice', 'general_business_advice', null);
    }

    // 8. Pinned first-person work phrasings only. A bare possessive is NOT
    //    enough to be certain: "what do you know about me and my column?" is
    //    a memory question, "am I allowed to look at the other stylists'
    //    columns?" is a permission question, and "what's a healthy rebooking
    //    rate for a salon our size?" is general advice — all of them carry a
    //    possessive and a business noun. Those go to the semantic layer; only
    //    the phrasings pinned as product behaviour short-circuit here.
    if (this.hasPinnedSelfDataPhrasing(q) && !this.hasSuppliedFigureAmbiguity(q)) {
      return certain('qlooqo_data', 'real_business_analysis', null);
    }

    // 9. An own-data anchor with NO plausible second reading. "How is my
    //    business doing?" and "what is my revenue this month?" are
    //    client-accepted behaviours and must not depend on a model being right
    //    — a wrong advisory verdict there sends an owner asking about their
    //    own trading to generic prose.
    //
    //    The veto is what keeps this honest. A possessive plus a business noun
    //    is NOT enough on its own: "what do you know about me and my column?"
    //    is memory, "which bits of my data can you read?" is permission, and
    //    "what's a healthy rebooking rate for a salon our size?" is general
    //    advice. Those all carry the anchor and all have a real second
    //    reading, so they go to the semantic layer instead.
    if (
      this.hasOwnDataAnchor(q) &&
      !this.hasSuppliedFigureAmbiguity(q) &&
      !this.hasPlausibleNonDataReading(q)
    ) {
      return certain('qlooqo_data', 'real_business_analysis', null);
    }

    return null;
  }

  /**
   * Does this question have a credible reading OTHER than "analyse my actual
   * figures"? Used to decide whether an own-data anchor is certain enough to
   * skip the semantic layer. Deliberately generous: when in doubt, defer.
   */
  private hasPlausibleNonDataReading(q: string): boolean {
    // Something the user told ZAC, rather than something ZAC measured.
    if (
      /\b(remember|remembered|told you|tell you|asked you to|you'?ve stored|stored about|know about me|carrying over|gave you|note i gave|do you still have|preferences)\b/.test(
        q,
      )
    ) {
      return true;
    }
    // About the access boundary rather than the contents.
    if (
      /\b(allowed|permitted|can i (see|look|access|pull|view|open)|can you (see|access|read)|owner.only|restricted|locked|approving|grant me|governance)\b/.test(
        q,
      )
    ) {
      return true;
    }
    // About ZAC's previous answer, or about the dialogue.
    if (REFERS_TO_PRIOR_ANSWER.test(q) || this.isConversationalShape(q)) return true;
    // Checking back on what ZAC just said.
    if (
      /\byou'?re saying\b|\bhave i got (that|this|it) right\b|\bunderstood you correctly\b|\bis that right\b|\bam i reading (that|this|it) right\b/.test(
        q,
      )
    ) {
      return true;
    }
    // Asking HOW to do something — run a meeting, coach, structure a
    // conversation — is advice about a process, not a request for figures.
    if (
      /\bhow (should|do|can|would) i (structure|run|approach|handle|set up|organise|organize|start|introduce|frame|word|phrase|deliver|pitch|coach)\b/.test(
        q,
      )
    ) {
      return true;
    }
    if (/\bbest way\b|\bbest ways\b|\bfrom scratch\b/.test(q)) return true;
    // Benchmark/best-practice framing: "a healthy rebooking rate for a salon
    // our size", "is that normal for a salon like mine".
    if (/\b(healthy|typical|typically|normal|normally|usual|usually|average|industry|benchmark|standard|best practice|rule of thumb|generally|good)\b/.test(q)) {
      return true;
    }
    // An indefinite subject alongside the possessive — the question is really
    // about salons in general, with their salon as the example.
    if (/\b(a|an|another|other) (salon|stylist|manager|owner|business|team)\b/.test(q)) return true;
    return false;
  }

  /**
   * The complete deterministic verdict with no model involved: Layer 1, then
   * the Layer 3 shape rules. This is exactly how ZAC routes when no semantic
   * provider is configured, and it is what the deterministic regression suite
   * pins. `null` means no rule matched at all.
   */
  classify(question: string, roleContext: ZacRoleContext): ZacDeterministicVerdict | null {
    return (
      this.classifyExplicit(question, roleContext) ?? this.classifyHeuristic(question, roleContext)
    );
  }

  /**
   * Layer 3. Best-effort shape rules for when the semantic layer is
   * unavailable or unsure. Never authoritative on its own — the router
   * combines this with the safe-fallback ladder.
   */
  classifyHeuristic(question: string, roleContext: ZacRoleContext): ZacDeterministicVerdict | null {
    void roleContext;
    const q = normalise(question);

    if (this.hasConditionalScenarioShape(q)) {
      return heuristic('hypothetical', 'hypothetical_scenario', null);
    }

    if (this.isGeneralAdviceShape(q)) {
      return heuristic('general_advice', 'general_business_advice', null);
    }

    // Conversational rules yield to an own-data anchor: "why do you think MY
    // rebooking is low?" is a diagnosis request, not chat about the dialogue.
    if (this.isConversationalShape(q) && !this.hasOwnDataAnchor(q)) {
      return heuristic('conversational', 'conversation_followup', null);
    }

    if (this.hasOwnDataAnchor(q)) {
      return heuristic('qlooqo_data', 'real_business_analysis', null);
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
   * Public so the router can enforce the hard veto: when the user excluded
   * their own data this turn, no layer — semantic included — may return
   * `qlooqo_data`.
   */
  detectDataInstruction(question: string): ZacDataInstruction {
    return this.analyseDataInstruction(normalise(question));
  }

  /**
   * Does the current message supply a scenario to reason about? Used to split
   * an explicit exclusion into `hypothetical` (a case was supplied) vs
   * `general_advice` (an open question).
   */
  suppliesScenario(qNormalised: string): boolean {
    const q = qNormalised;
    if (this.hasExplicitHypotheticalMarker(q)) return true;
    // A conditional or comparison carrying a figure is a supplied scenario:
    // "if a stylist has 40% against a 50% target", "someone ten points behind".
    if (/\b(if|when|where|with|at|on)\b[^.?!]{0,80}\d/.test(q)) return true;
    if (/\b\d+\s*(%|percent|points?|pts?)\b/.test(q)) return true;
    // "£15k a month", "a two-stylist salon", "20 clients a week" — a quantity
    // attached to the described situation is the scenario.
    if (/£\s?\d/.test(q)) return true;
    if (/\b(one|two|three|four|five|six|\d+)[- ](stylist|chair|column|person|site|salon)s?\b/.test(q)) {
      return true;
    }
    if (/\b(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|five)\s+(points?|percent)\b/.test(q)) {
      return true;
    }
    // "a stylist who was behind their target" — an indefinite protagonist in a
    // described situation, with no figure.
    if (/\b(a|an|another|some|one of my)\s+(stylist|manager|salon|owner|colleague|team member)\b[^.?!]{0,60}\b(who|that|whose)\b/.test(q)) {
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Explicit data instructions — clause direction, not substring presence.
  // ---------------------------------------------------------------------------

  /**
   * Decide whether the user told ZAC to USE or to EXCLUDE their own data.
   *
   * The message is split into clauses and each clause is read as
   * (polarity, object): does it point AT the user's own data, or AT general
   * knowledge, and is it positive or negative? Only then is a direction
   * assigned. This is what stops the two failures naive matching always makes:
   *
   *   "don't use my data"      — contains "use my data", but the verb is negated.
   *   "ignore industry averages and use my actual figures"
   *                            — contains "ignore", but what is excluded is the
   *                              benchmark, not their data.
   *
   * When a message carries both directions, the LAST explicit own-data clause
   * wins, which is how retraction works in speech: "forget my figures — no,
   * actually, show me my numbers".
   */
  private analyseDataInstruction(q: string): ZacDataInstruction {
    // Signals about the user's OWN data and signals about GENERAL knowledge are
    // tracked separately, because they are not comparable evidence.
    //
    // An explicit statement about their own data is direct. "I don't want
    // generic advice" is only an INFERENCE that they want their own data — and
    // a weak one, since it happily coexists with an explicit exclusion:
    //
    //   "Don't use my data. I don't want the industry average."
    //
    // Reading those two clauses as equals and letting the last one win inverts
    // the sentence into a live-data request, which is exactly the failure this
    // router exists to prevent. Own-data statements therefore always outrank
    // the general-knowledge inference, and only among own-data statements does
    // "last one wins" apply (that is how spoken retraction works).
    let ownData: ZacDataInstruction = null;
    let generalKnowledgeExcluded = false;

    for (const sentence of splitSentences(q)) {
      // Discontinuous exclusion frames — "leave my numbers, and the targets,
      // out of this one" — straddle the clause boundaries, so they are read at
      // sentence level before the sentence is split.
      if (DISCONTINUOUS_EXCLUSION.test(sentence) && OWN_DATA_OBJECT.test(sentence)) {
        ownData = 'ignore_data';
        continue;
      }
      for (const clause of splitClauses(sentence)) {
        // A blanket prohibition on looking anything up excludes their data
        // without ever naming it ("don't look anything up", "no lookups").
        // Clause-scoped and general-knowledge-aware on purpose: "don't look up
        // the industry benchmarks, show me my numbers" prohibits the BENCHMARK
        // lookup, and the following clause still wins.
        if (LOOKUP_PROHIBITION.test(clause) && !GENERAL_KNOWLEDGE_OBJECT.test(clause)) {
          ownData = 'ignore_data';
          continue;
        }
        const signal = this.readDataClause(clause);
        if (signal === 'own_ignore') ownData = 'ignore_data';
        else if (signal === 'own_use') ownData = 'use_data';
        else if (signal === 'general_excluded') generalKnowledgeExcluded = true;
      }
    }

    if (ownData !== null) return ownData;
    return generalKnowledgeExcluded ? 'use_data' : null;
  }

  /** One clause → what it says about data use, or null when it says nothing. */
  private readDataClause(clause: string): DataClauseSignal {
    const generalKnowledge = GENERAL_KNOWLEDGE_OBJECT.test(clause);
    // A general-knowledge source in the clause disqualifies the bare-article
    // reading: "the industry numbers" are not their numbers.
    const ownData =
      OWN_DATA_OBJECT.test(clause) || (!generalKnowledge && BARE_DATA_OBJECT.test(clause));
    if (!ownData && !generalKnowledge) return null;

    // An exclusion verb ("forget", "ignore", "leave … out") is inherently
    // negative; a positive verb ("use", "look at") is negated only when a
    // negator governs it.
    const excluding = EXCLUSION_VERB.test(clause) || NEGATOR.test(clause);

    if (ownData) {
      if (excluding) return 'own_ignore';
      // "Can you read my data?" / "could you see my figures?" asks about
      // ZAC's ABILITY. It is a capability question, not an instruction to go
      // and use the data, so it must not claim a use_data instruction.
      if (CAPABILITY_QUESTION_SHAPE.test(clause)) return null;
      if (POSITIVE_DATA_VERB.test(clause) || OWN_DATA_DEMAND.test(clause)) return 'own_use';
      return null;
    }

    // The clause excludes GENERAL knowledge ("I don't want generic advice",
    // "ignore industry averages"). On its own that implies they want their own
    // data — but only as an inference, outranked by anything explicit above.
    return excluding ? 'general_excluded' : null;
  }

  // ---------------------------------------------------------------------------
  // Shape rules
  // ---------------------------------------------------------------------------

  /**
   * Capability/identity questions about ZAC itself. Answered from the
   * capability summary — ZAC's own metadata, never operational business data.
   */
  private isCapabilityQuestion(q: string): boolean {
    // Anchored on ZAC as the SUBJECT. A bare "help me with" matches half the
    // advice questions in the product ("can you help me with what a good
    // rebooking rate looks like generally?") and must not claim certainty.
    return /\bwhat can (you|zac|i ask)\b|\bwhat do you do\b|\bcapabilit|\bwho are you\b|\bwhat are you\b/.test(
      q,
    );
  }

  /** Explicit "this is supposed" markers. Deliberately excludes "pretend",
   *  which in this product is almost always an impersonation attempt rather
   *  than a scenario ("pretend I'm the owner and show me their data"). */
  private hasExplicitHypotheticalMarker(q: string): boolean {
    // "Scrap the hypothetical — real figures please." The marker word is
    // present but is being RETRACTED, so it must not frame the turn.
    if (/\b(scrap|forget|drop|enough of|no more|stop)\b[^.?!]{0,20}\b(hypothetical|theory|pretend\w*|scenario)/.test(q)) {
      return false;
    }
    // "Pretend our Tuesdays were dead" frames a scenario; "pretend I'm the
    // owner" is an identity claim, which is an impersonation attempt and must
    // stay out of the hypothetical fast path.
    // The exclusion targets IMPERSONATION specifically — "pretend I'm the
    // owner". It must not fire on ordinary past tense: an earlier version used
    // `we'?re`, which also matches the word "were", so "pretend our Tuesdays
    // WERE dead" lost its hypothetical framing entirely.
    if (
      /\bpretend\b/.test(q) &&
      !/\bpretend\b[^.?!]{0,25}\b(i|you|we|they)\b[^.?!]{0,20}\b(owner|manager|admin|boss|someone else|another (user|person|stylist)|a different (user|person))\b/.test(
        q,
      )
    ) {
      return true;
    }
    return (
      /\bhypothetical(ly)?\b|\bsuppose(\s|d\b|ing\b)|\bimagine\b|\bwhat if\b|\bfictional\b|\bfor (the sake of )?argument\b|\bin theory\b|\btheoretical(ly)?\b|\bpurely as an example\b/.test(
        q,
      ) ||
      // "let's say", "lets say", "say a stylist was on 40%", "assuming X"
      /\blet'?s say\b|\bletssay\b|\blet us say\b|\blet'?s assume\b|\bsay a\b|\bas if i'?d\b/.test(q) ||
      /(^|[.?!;]\s*)assume\b/.test(q) ||
      /^\s*say\b[^.?!]{0,60}\b(was|were|is|are|had|has)\b/.test(q) ||
      // Counterfactual about ownership: "if this wasn't my business",
      // "if this were another salon", "if it wasn't mine".
      /\bif (this|that|it) (was|were)n'?t\b|\bif (this|that|it) (was|were) (another|a different|someone else'?s)\b/.test(
        q,
      ) ||
      /\bif i (was|were) (asking |someone |another )/.test(q)
    );
  }

  /**
   * A conditional over supplied figures — hypothetical SHAPE without an
   * explicit marker. Heuristic tier only: "tell me if my revenue is above
   * £2000" has the same shape but is a data question, so the guards below
   * refuse the report-me lead-ins and possessive subjects.
   */
  private hasConditionalScenarioShape(q: string): boolean {
    const conditional = /\bif\b[^.?!]{0,80}\d/.test(q) || /\bif\b[^.?!]{0,60}\b(was|were)\b/.test(q);
    if (!conditional) return false;
    // "tell/check/let me know if …" reports on live data.
    if (/\b(tell|check|know|see|ask|wondering|let me know|alert|notify)\b[^.?!]{0,25}\bif\b/.test(q)) {
      return false;
    }
    // "if my X is …" asks about their real figures.
    if (/\bif\b[^.?!]{0,30}\b(my|our)\b/.test(q)) return false;
    return true;
  }

  /** Explicit general framing — high confidence, no possessive anchor. */
  private isExplicitGeneralFraming(q: string): boolean {
    if (this.hasOwnDataAnchor(q)) return false;
    // "…is that something you worked out, or a rule of thumb?" asks about the
    // PREVIOUS answer; the advice vocabulary is incidental.
    if (REFERS_TO_PRIOR_ANSWER.test(q)) return false;
    // "generally", "in general", "typically", "as a rule".
    if (/^\s*(generally|in general|typically|usually|normally)\b/.test(q)) return true;
    if (/\b(in general|generally speaking|as a rule|in a typical salon|in most salons)\b/.test(q)) {
      return true;
    }
    if (/\bbest practices?\b|\brules? of thumb\b/.test(q)) return true;
    return false;
  }

  /** Softer general-advice shapes — heuristic tier. */
  private isGeneralAdviceShape(q: string): boolean {
    if (this.hasOwnDataAnchor(q)) return false;
    if (this.isExplicitGeneralFraming(q)) return true;
    if (
      /\bwhat (are|is) (some|a few|three|four|five|\d+|good|effective|practical|proven|the best)\s+(?:[\w-]+\s+){0,2}(ways?|tips?|methods?|approaches|strategies|practices?|ideas)\b/.test(
        q,
      )
    ) {
      return true;
    }
    if (/\btips (for|on)\b/.test(q)) return true;
    // "What normally lifts retail attach?", "what typically drives walk-ins" —
    // the adverb marks the general case whatever verb follows it.
    if (/\bwhat (generally|typically|usually|normally|often)\b/.test(q)) return true;
    // Official Manager acceptance phrasings: coaching-conversation guidance is
    // advice (reasoned, tool-free), not a data lookup.
    if (
      /\bwhat coaching conversation\b|\bcoaching conversation should i\b|\bhow should i coach\b|\bwhat should success look like\b/.test(
        q,
      )
    ) {
      return true;
    }
    // Asking what ZAC would advise IN THE ABSTRACT, with nothing anchoring the
    // question to their own figures.
    if (
      /\bwhat would you (normally|typically|usually|generally|often)?\s*(suggest|recommend|advise|do|say)\b/.test(
        q,
      ) ||
      /\bhow would you (improve|approach|handle|coach|fix|tackle)\b/.test(q) ||
      /\bwhat makes (a|an|for a)\b/.test(q) ||
      /\bgenerally\b/.test(q)
    ) {
      return true;
    }
    // Indefinite plural/singular subject in a general claim: "why salons
    // struggle with utilisation", "what stylists get wrong about rebooking".
    if (
      /\b(why|how|what)\b[^.?!]{0,20}\b(salons?|stylists?|managers?|businesses|owners?|receptionists?|teams?)\b[^.?!]{0,40}\b(struggle|fail|succeed|do|get|find|tend|often|usually|typically)\b/.test(
        q,
      )
    ) {
      return true;
    }
    // Indefinite subject: "How should a salon manager…", "How do salons…",
    // "What causes low rebooking?", "Why do salons struggle with X?"
    if (
      /\bhow (should|can|do|does|would|might) (a|an) (salon|stylist|manager|business|team|receptionist|owner)\b/.test(q) ||
      /\bhow (should|can|do|does|would|might) (salons?|stylists?|managers?|businesses|owners?)\b/.test(q) ||
      /\bwhy do (salons?|stylists?|managers?|businesses|owners?|people|clients?)\b/.test(q) ||
      /\bwhat (causes?|drives?|improves?|makes?|helps?) (a |an |good |low |poor |high |successful )?(rebooking|utilisation|utilization|retention|revenue|salon|consultation|client|retail|attach)/.test(q)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Permission-boundary questions: what the ACTOR may/may not see or do.
   * Deliberately narrower than capability questions ("what can you do") and
   * self-data questions ("can I see my appointments?" is a diary ask).
   */
  private isPermissionQuestion(q: string): boolean {
    if (
      /\b(allowed|permitted|not allowed)\b[^.?!]{0,60}\b(to )?(see|access|view|know|look at|get at|pull up|open|check)\b/.test(
        q,
      )
    ) {
      return true;
    }
    if (/\bwhat\b[^.?!]{0,40}\b(am i|are we)\b[^.?!]{0,40}\b(allowed|permitted)\b/.test(q)) return true;
    if (/\bmy permissions?\b|\bbased on my permissions?\b/.test(q)) return true;
    if (/\bpermissions?\b[^.?!]{0,60}\b(see|access|view|boundar|allow)\b/.test(q)) return true;
    if (
      /\bwhy can'?t (i|you)\b[^.?!]{0,60}\b(see|show|access|view|tell)\b/.test(q) &&
      // "…my appointments/diary" is a diary problem, not a permission ask.
      !/\bmy (schedule|diary|appointments?|day|week|kpis?|numbers?|performance)\b/.test(q)
    ) {
      return true;
    }
    if (/\b(what|which)\b[^.?!]{0,30}\b(can|do|could) you (\w+ )?(access|see|read|view)\b/.test(q)) {
      return true;
    }
    // "Does ZAC have sight of our supplier invoices, or is that outside what
    // you're plugged into?" — a boundary question, not a request for figures.
    if (
      /\b(does|do|can) (zac|you)\b[^.?!]{0,25}\b(sight of|access to|visibility (of|into)|plugged into)\b/.test(
        q,
      )
    ) {
      return true;
    }
    if (/\bwhat (information|data|things?) can you access\b/.test(q)) return true;
    if (/\bwhat can('t| not)? i (see|access|view)\b/.test(q)) return true;
    // "What financial information can I access?" — "financial" qualifies
    // INFORMATION, so this describes the boundary; it is not a request for
    // figures. Keyed on the information noun so "what locations can I see?"
    // stays a data question.
    if (
      /\bwhat\b[^.?!]{0,24}\b(information|data|reports?|records?|details)\b[^.?!]{0,20}\b(can|could|am i able to) i? ?(see|access|view|get at|read)\b/.test(
        q,
      )
    ) {
      return true;
    }
    // "Can I see X?" is a permission question only when X is clearly
    // restricted-flavoured (others' data, coaching, pay, financials) — plain
    // "what locations can I see?" is a data question and stays on its tool.
    if (
      /\bcan i (see|view|access)\b[^.?!]{0,60}\b(coaching|conversations?|private|other|everyone|payroll|salar\w*|wages?|financial\w*|owner)\b/.test(
        q,
      )
    ) {
      return true;
    }
    return false;
  }

  /** Conversational: acknowledgements and meta/follow-up requests about the dialogue itself. */
  private isConversationalShape(q: string): boolean {
    if (this.isPureAcknowledgement(q)) return true;
    if (/\b(explain|put|say) (that|this|it)\b[^.?!]{0,40}\b(simpl\w+|again|more|differently|shorter)\b/.test(q)) {
      return true;
    }
    if (/\bin simpler terms\b|\bmore simply\b|\bplain english\b|\bshorter\b/.test(q)) return true;
    if (/\bwhat do you mean\b|\bcan you (rephrase|clarify|elaborate|expand|shorten)\b|\btell me more\b/.test(q)) {
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
    if (/\bwhat evidence\b[^.?!]{0,40}\b(that|this|it)\b/.test(q)) return true;
    return false;
  }

  /**
   * The narrow, pinned set of first-person work questions that are certain
   * enough to skip the model: the stylist coaching/diary territory and the
   * whole-business/which-stylist phrasings the product has already accepted.
   */
  private hasPinnedSelfDataPhrasing(q: string): boolean {
    // "Have I got that right?" / "do I have that correct?" check ZAC's last
    // answer; they are not diary questions despite the shared shape.
    if (/\b(have|do) i (have|got)\b[^.?!]{0,12}\b(that|this|it)\b[^.?!]{0,10}\b(right|correct)\b/.test(q)) {
      return false;
    }
    if (
      /\bhow am i (doing|performing)\b|\bwhat should i focus\b|\bhow can i improve\b|\bam i on track\b|\bappointments? (do|have) i\b|\b(do|have) i (have|got)\b/.test(
        q,
      )
    ) {
      return true;
    }
    if (/\bthe (whole|entire) (business|salon)\b/.test(q)) return true;
    if (/\bwhich (stylists?|staff|team members?|colleagues?)\b/.test(q)) return true;
    if (/\bwho works\b|\bstaff list\b|\bteam members?\b/.test(q)) return true;
    if (/\b(what|which|how many) locations?\b/.test(q)) return true;
    return false;
  }

  /**
   * The user's OWN business data: possessive/self anchors with a business
   * noun, imperatives ("show/list…"), or bare staff-list phrases. Heuristic
   * tier only — see hasPinnedSelfDataPhrasing for the certain subset.
   */
  hasOwnDataAnchor(q: string): boolean {
    const businessNoun =
      /\b(business|salon|revenue|takings|turnover|sales|money|rebook\w*|booking?s?|appointments?|schedule|diary|team|staff|stylists?|colleagues?|members?|kpis?|perform\w*|clients?|utili[sz]ation|stock|inventory|locations?|targets?|figures?|numbers?|health|column|chair)\b/;
    if (/\b(my|our)\b/.test(q) && businessNoun.test(q)) return true;
    // First-person plural trading questions: "how much did we make this week",
    // "were we busy", "why were we quieter".
    if (/\b(we|us)\b/.test(q) && (businessNoun.test(q) || /\b(make|made|take|took|busy|quiet\w*|earn\w*)\b/.test(q))) {
      return true;
    }
    // Imperatives count at the start of the message OR of a clause
    // ("Forget last week, show me this week's numbers").
    if (/(^|[,;:—–]\s*)(show|list|give me|pull|get)\b/.test(q) && businessNoun.test(q)) return true;
    if (/\bwho works\b|\bstaff list\b|\bteam members?\b|\bthe (whole |entire )?(business|salon)\b/.test(q)) {
      return true;
    }
    if (/\b(what|which|how many) locations?\b/.test(q)) return true;
    if (/\bwhich (stylists?|staff|team members?|colleagues?)\b/.test(q)) return true;
    // First-person work questions — the stylist coaching/diary territory the
    // downstream router handles.
    if (
      /\bhow am i (doing|performing)\b|\bwhat should i focus\b|\bhow can i improve\b|\bam i on track\b|\bappointments? (do|have) i\b|\b(do|have) i (have|got)\b/.test(
        q,
      )
    ) {
      return true;
    }
    return false;
  }

  /**
   * A figure supplied next to the metric makes ownership genuinely ambiguous:
   * "what is my 40% rebooking telling me?" could be a live-data read or an
   * assertion to reason from. Those go to the semantic layer rather than being
   * decided by a possessive.
   */
  private hasSuppliedFigureAmbiguity(q: string): boolean {
    if (this.hasExplicitHypotheticalMarker(q)) return true;
    if (/\bif\b/.test(q) && /\d/.test(q)) return true;
    // "my 40% rebooking", "our 12k month" — a number directly qualifying the
    // possessed noun, as opposed to a period ("my last 3 months").
    if (/\b(my|our)\s+(?:[\w-]+\s+){0,2}\d+\s*(%|percent|k\b|£)/.test(q)) return true;
    if (/£\s?\d/.test(q) && /\b(if|say|were|was)\b/.test(q)) return true;
    return false;
  }

  /** Guard for the model layer: only closed-enum values survive. */
  static isValidMode(candidate: string | null | undefined): candidate is ZacRequestMode {
    return isZacRequestMode(candidate);
  }
}

// -----------------------------------------------------------------------------
// Shared vocabulary for clause-direction analysis.
// -----------------------------------------------------------------------------

/** The user's own data as the object of a clause. */
const DATA_NOUN = 'data|figures?|numbers?|stats|statistics|results?|metrics|kpis?|actuals?|takings';

/**
 * The user's own data as the object of a clause. First person is required, or
 * an explicit QLOOQO reference.
 *
 * The bare article "the" is deliberately NOT enough: "ignore the industry
 * numbers" and "don't look at the textbook figures" exclude RECEIVED knowledge,
 * not the user's own — reading them as an own-data exclusion would invert
 * an explicit live-data request into a refusal to look. Bare "the data" is
 * handled separately below, and only when the clause names no general source.
 */
const OWN_DATA_OBJECT =
  /\b(qlooqo\b|(my|our)\s+(?:[\w-]+\s+){0,6}(data|figures?|numbers?|stats|statistics|results?|metrics|kpis?|actuals?|takings)\b|anything you know about (my|our)|what you know about (my|our)|(my|our) (own )?(salon|business)\b)/;

/**
 * "the data" / "the current figures" — ambiguous alone, so it counts as the
 * user's data ONLY when the clause names no general-knowledge source.
 */
const BARE_DATA_OBJECT = new RegExp(
  String.raw`\bthe\s+(actual\s+|real\s+|current\s+|live\s+|connected\s+|latest\s+)?(${DATA_NOUN})\b`,
);

/** General/received knowledge as the object of a clause. */
const GENERAL_KNOWLEDGE_OBJECT =
  /\b(generic|general|industry|benchmarks?|averages?|best practice|textbook|standard advice|what other salons|other salons|the usual advice|theory)\b/;

/** Verbs whose meaning is exclusion regardless of any separate negator. */
const EXCLUSION_VERB =
  /\b(forget|ignore|disregard|skip|omit|exclude|park|set aside|put aside|leave out|leave aside|never mind|nevermind|steer clear of)\b|\bleave\b[^.?!]{0,30}\bout\b|\bput\b[^.?!]{0,30}\b(aside|to one side)\b|\bset\b[^.?!]{0,30}\baside\b|\bwithout\s+(using|looking|checking|reading|pulling|consulting|reference to|regard to|any reference)\b/;

/** A negator governing an otherwise-positive verb. */
const NEGATOR = /\b(don'?t|do not|dont|doesn'?t|never|no need to|rather than|instead of|not)\b/;

/** Positive verbs that reach for data. */
const POSITIVE_DATA_VERB =
  /\b(use|using|based on|look at|looking at|check|pull|read|analyse|analyze|review|go (off|on)|work from|refer to|consider)\b/;

/**
 * A blanket ban on retrieval. Distinct from the clause analysis because the
 * object is "anything", not a named data noun.
 */
const LOOKUP_PROHIBITION =
  /\b(don'?t|do not|dont|without|no need to|never)\b[^.?!]{0,20}\b(look|check|search|pull|retrieve|fetch|consult)\b[^.?!]{0,15}\b(anything|any ?thing|it up|them up|up)\b|\bno lookups?\b|\bwithout looking (anything|it) up\b/;

/** A bare demand for their own figures without an explicit verb of retrieval. */
const OWN_DATA_DEMAND =
  /\bwhat (do|does) (my|our)\b[^.?!]{0,40}\b(say|show|tell)\b|\btell me what (my|our)\b|\b(my|our) (actual|real|current) (data|figures?|numbers?)\b/;

/**
 * An explicit reference to ZAC's own previous answer. Such a turn is about the
 * dialogue, whatever vocabulary it borrows.
 */
const REFERS_TO_PRIOR_ANSWER =
  /\byou (said|quoted|mentioned|worked out|put it|told me|gave me)\b|\b(that|this) (last )?(bit|answer|point|figure)\b|\ba minute ago\b|\bearlier you\b|\bwhat you (said|meant)\b/;

/** What one clause says about data use. */
type DataClauseSignal = 'own_ignore' | 'own_use' | 'general_excluded' | null;

/**
 * An exclusion frame whose two halves straddle clause boundaries: "leave my
 * numbers, and the targets, out of this". Clause splitting would sever
 * "leave …" from "… out", so this is tested on the whole sentence first.
 */
const DISCONTINUOUS_EXCLUSION =
  /\b(leave|left)\b[^.?!]{0,60}\bout\b|\b(put|set|park)\b[^.?!]{0,60}\b(aside|to one side)\b|\bkeep\b[^.?!]{0,60}\bout of\b/;

/** A question about ZAC's ability to reach data, rather than an instruction to. */
const CAPABILITY_QUESTION_SHAPE =
  /\b(can|could|are) you\b[^.?!]{0,20}\b(read|see|access|view|get at|reach|pull)\b|\bare you able to\b/;

/**
 * Lowercase, fold compatibility forms, drop invisible characters, normalise
 * curly punctuation, collapse whitespace.
 *
 * Stripping zero-width and other format characters matters for correctness,
 * not tidiness: a zero-width space inside "da\u200Bta" breaks \bdata\b, which
 * would silently defeat the explicit ignore-data instruction the user typed.
 */
function normalise(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    // Zero-width space/non-joiner/joiner, word joiner, BOM, soft hyphen and
    // the bidi control range — all invisible, none meaningful here.
    .replace(/[\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split on sentence boundaries only. Clause analysis runs inside each sentence. */
function splitSentences(q: string): string[] {
  return q
    .split(/[.?!\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Split a sentence into clauses. Coordinating "and"/"but" split too, because
 * that is exactly where direction flips:
 * "ignore industry averages | and use my actual figures".
 */
function splitClauses(q: string): string[] {
  return q
    .split(/[;:—–]+|,\s*|\s+\b(?:and|but|however|then|instead)\b\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function certain(
  mode: ZacRequestMode,
  reasonCode: ZacDeterministicVerdict['reasonCode'],
  dataInstruction: ZacDataInstruction,
): ZacDeterministicVerdict {
  return { mode, reasonCode, dataInstruction, certain: true };
}

function heuristic(
  mode: ZacRequestMode,
  reasonCode: ZacDeterministicVerdict['reasonCode'],
  dataInstruction: ZacDataInstruction,
): ZacDeterministicVerdict {
  return { mode, reasonCode, dataInstruction, certain: false };
}
