import { Injectable } from '@nestjs/common';
import type { ZacRoleContext } from '../context/zac-context.types';
import type {
  ZacAnalysisIntent,
  ZacAnalysisIntentReason,
} from './zac-analysis.types';

/** A deterministic verdict. `certain` verdicts skip the model entirely. */
export interface ZacAnalysisVerdict {
  intent: ZacAnalysisIntent;
  reasonCode: ZacAnalysisIntentReason;
  certain: boolean;
}

/**
 * Deterministic analysis-intent rules — Layer 1 of the analysis classifier.
 *
 * Two jobs, and the split matters:
 *
 *  - `classifyCertain()` recognises the narrow, unambiguous shapes where a
 *    model adds nothing: a named metric ("what is my rebooking rate?"), an
 *    explicit overview ("how is my business doing?"), a why-question. These
 *    short-circuit, which keeps the common path cheap.
 *
 *  - `classifyHeuristic()` is the safety net for when no model is available.
 *    It is deliberately NOT the primary route for broad prioritisation:
 *    "taking everything into account, what would you work on first?" shares no
 *    keyword with "what should I focus on", and a rule list can only ever
 *    recognise the phrasings someone thought of. Meaning goes to the model.
 *
 * Neither decides access. The intent selects which EVIDENCE to gather; the
 * registry and policy layers decide what may be read, unchanged.
 */
@Injectable()
export class ZacAnalysisIntentService {
  /**
   * The unambiguous cases. `null` means "not certain" — the semantic layer
   * should decide, and `classifyHeuristic` catches it if no model answers.
   */
  classifyCertain(question: string, roleContext: ZacRoleContext): ZacAnalysisVerdict | null {
    const q = normalise(question);

    // A comparison is a comparison whatever it compares.
    if (COMPARISON.test(q)) {
      return certain('comparison', 'comparison_request');
    }

    // "Why is X…" wants a cause, which needs the metric plus its context.
    if (DIAGNOSTIC.test(q)) {
      return certain('diagnostic', 'diagnostic_request');
    }

    // A single named metric with no breadth marker. The breadth guard is what
    // stops "what's my rebooking AND where should I focus overall" collapsing
    // to one tool.
    if (
      NAMED_METRIC.test(q) &&
      !BREADTH.test(q) &&
      !PRIORITISATION.test(q) &&
      !PRIORITISATION_SHAPE.test(q)
    ) {
      return certain('specific_metric', 'direct_metric_request');
    }

    // The pinned overview phrasing.
    if (BUSINESS_OVERVIEW.test(q) && !PRIORITISATION.test(q) && !PRIORITISATION_SHAPE.test(q)) {
      return certain('business_health', 'business_overview_request');
    }

    // Team-attention phrasing is pinned product behaviour for managers/owners.
    if (roleContext !== 'stylist' && (TEAM_PRIORITIES.test(q) || TEAM_PRIORITIES_SHAPE.test(q))) {
      return certain('team_priorities', 'team_priority_request');
    }

    return null;
  }

  /**
   * The no-model fallback. Broad prioritisation IS recognised here, but only
   * as a floor: these rules exist so a build without a provider key still
   * behaves sensibly, not as the mechanism the product depends on.
   */
  classifyHeuristic(question: string, roleContext: ZacRoleContext): ZacAnalysisVerdict {
    const q = normalise(question);

    if (roleContext !== 'stylist' && (TEAM_PRIORITIES.test(q) || TEAM_PRIORITIES_SHAPE.test(q))) {
      return heuristic('team_priorities', 'team_priority_request');
    }
    if (
      PRIORITISATION.test(q) ||
      PRIORITISATION_SHAPE.test(q) ||
      (BREADTH.test(q) && !NAMED_METRIC.test(q))
    ) {
      return heuristic('business_priorities', 'business_priority_request');
    }
    if (FOLLOWUP_EXPLANATION.test(q)) {
      return heuristic('explanation', 'followup_explanation');
    }
    if (NAMED_METRIC.test(q)) {
      return heuristic('specific_metric', 'direct_metric_request');
    }
    if (BUSINESS_OVERVIEW.test(q)) {
      return heuristic('business_health', 'business_overview_request');
    }
    // An unrecognised live-data question is an overview question: it is the
    // broadest safe answer, and it is never the capability summary — a
    // question ZAC could not categorise is not evidence that ZAC has no data.
    return heuristic('business_health', 'business_overview_request');
  }

  /**
   * Does this question carry ANY signal that it is about the business?
   *
   * Used to decide whether an unplaced live-data question is worth planning
   * evidence for. "Compare this month with last month" carries a comparison
   * shape and must never reach the capability summary; "tell me a story"
   * carries nothing, and gathering two reports for it would spend the user's
   * time to answer a question they did not ask.
   */
  hasAnalysisSignal(question: string): boolean {
    const q = normalise(question);
    return (
      NAMED_METRIC.test(q) ||
      BREADTH.test(q) ||
      PRIORITISATION.test(q) ||
      PRIORITISATION_SHAPE.test(q) ||
      BUSINESS_OVERVIEW.test(q) ||
      DIAGNOSTIC.test(q) ||
      COMPARISON.test(q) ||
      TEAM_PRIORITIES.test(q) ||
      TEAM_PRIORITIES_SHAPE.test(q) ||
      FOLLOWUP_EXPLANATION.test(q)
    );
  }

  /** The reason code that belongs with an intent, for model verdicts. */
  reasonFor(intent: ZacAnalysisIntent): ZacAnalysisIntentReason {
    switch (intent) {
      case 'specific_metric':
        return 'direct_metric_request';
      case 'business_health':
        return 'business_overview_request';
      case 'business_priorities':
        return 'business_priority_request';
      case 'team_priorities':
        return 'team_priority_request';
      case 'diagnostic':
        return 'diagnostic_request';
      case 'comparison':
        return 'comparison_request';
      case 'explanation':
      default:
        return 'followup_explanation';
    }
  }
}

// -----------------------------------------------------------------------------
// Shapes. Intentionally narrow: these back the CERTAIN path, and anything a
// rule cannot be sure about belongs to the semantic layer.
// -----------------------------------------------------------------------------

/** An explicitly named Phase 1 metric. */
const NAMED_METRIC =
  /\b(rebooking|rebook rate|utilisation|utilization|revenue|takings?|turnover|turn over|sales|average bill|average booking value|average spend|spend per client|bookings?|appointments?|no[- ]?shows?|didn'?t turn up|cancellations?|retail attach|retail|commission|tills?)\b/

/** Markers that the question spans the business rather than one metric. */
const BREADTH =
  /\b(everything|all (?:the )?(?:data|information|info|figures|numbers|areas)|across (?:the|my|our) (?:business|salon|whole)|whole business|entire business|overall|across everything|anything you (?:can|have)|all the information|big picture|holistically|taking everything|all my (?:current )?figures|everything you (?:know|can see|have access to))\b/;

/** Asking to be told what matters most / where to spend attention. */
const PRIORITISATION =
  /\bpriorit(?:y|ies|ise|ize|izing|ising)\b|\bmost important\b|\btop (?:three|3|two|2|five|5)\b|\btop priorit\w*|\bfocus (?:on|first)\b|\bwhere (?:should|would|do|shall) i (?:focus|spend|start|begin|put)\b|\bwhat (?:should|would|shall) i (?:focus|work on|do|tackle|fix|sort|change|start)\b|\bneeds? (?:my |our )?attention\b|\bactually needs attention\b|\bbiggest\s+(?:opportunit\w*|gaps?|problems?|issues?|wins?|risks?|worries|drains?)\b|\bwhat matters most\b|\bcare about\b|\bwork on first\b|\bspend (?:my |your )?attention\b|\bif i only had\b|\bone hour\b|\bwhere are the biggest\b/

/**
 * Further prioritisation SHAPES — the way people actually ask to be told what
 * matters, with none of the vocabulary above.
 *
 * This list is a FLOOR, not the mechanism. It exists so a build with no model
 * still behaves sensibly; the semantic planner is what makes phrasings nobody
 * anticipated work, and no entry here should be read as the trigger for the
 * feature.
 */
const PRIORITISATION_SHAPE =
  /\bwhat would you (?:do|fix|sort|tackle|change|look at|start|bet|worry|point)\b|\bif you were (?:me|running|sat in|in my)\b|\bwhere (?:do|should|would) i start\b|\bwhat(?:'?s| is) the one thing\b|\bworth (?:my time|fixing|doing|my energy|sorting)\b|\bneeds? sorting\b|\bhurting (?:us|me|the business|my business)\b|\blow[- ]hanging fruit\b|\bshortlist\b|\brank (?:my|the|our)\b|\bleaking money\b|\bcosting me the most\b|\beasiest win\b|\bquick wins?\b|\btop of the list\b|\bwhich levers\b|\bwhere do i go from here\b|\bwhat now\b|\bgive me (?:three|3|two|2|a few|a couple|the) (?:things|areas)\b|\bnot (?:just )?one (?:kpi|number|metric)\b|\bdon'?t just give me\b|\bi want the (?:picture|whole picture)\b|\bwhat can wait\b|\bwhat should we put it towards\b/

/** An overview of the business as a whole. */
const BUSINESS_OVERVIEW =
  /\bhow(?:'s| is| are)?\s+(?:my|the|our)\s+(?:business|salon)\b|\bbusiness health\b|\bhow healthy\b|\boverview of (?:the|my|our) (?:business|salon)\b|\bhow are we doing\b|\bhow am i doing\b(?!.*\bcoaching\b)/;

/** A cause question. */
const DIAGNOSTIC =
  /\bwhy (?:is|are|was|were|has|have|did|do|does|would|arent|aren'?t|isn'?t)\b|\bwhat(?:'?s| is) (?:causing|driving|behind|going on|gone wrong|happened)\b|\bwhat caused\b|\breason for\b|\bhow come\b|\bany idea (?:why|what)\b|\bget to the bottom of\b|\bwork out what\b|\bhave a dig\b|\bdig into it\b|\bwhere(?:'?s| is) the (?:drop|dip|fall|decline)\b[^.?!]{0,30}\bcoming from\b|\bexplain that\b|\bcant work out (?:where|why|what)\b|\bmakes no sense\b/

/** An explicit comparison against another period. */
const COMPARISON =
  /\bcompare[ds]?\b|\bcomparison\b|\bversus\b|\bvs\.?\b|\bagainst last\b|\bbetter or worse\b|\b(?:this|last) (?:month|week|quarter|year)\s+(?:compared|vs|versus|against)\b|\bhow does (?:this|it) compare\b/;

/** Team-attention phrasing. */
const TEAM_PRIORITIES =
  /\b(?:which|who|whos|who'?s|what) (?:of )?(?:my |the |our )?(?:team members?|stylists?|staff|colleagues?|girls|lads|team)\b[^.?!]{0,40}\b(?:need|needs|attention|focus|help|support|coach|struggling|behind|slipping)|\bcoach (?:the )?team on\b|\bwhere should i focus my coaching\b|\bwho (?:needs|should i) (?:coach|help|support)\b/

/**
 * People-shaped prioritisation, in the words managers actually use. A WHO/WHICH
 * question whose object is a person needing something — support, coaching, a
 * word, an eye kept on them — is a team question however it is phrased.
 */
const TEAM_PRIORITIES_SHAPE =
  /\b(?:who|whos|who'?s|whom)\b[^.?!]{0,60}\b(?:struggling|struggles|behind|slipping|weakest|need(?:s|ing)? (?:a word|support|help|coaching|attention|me)|coming on|quietly|keep(?:ing)? an eye|watch(?:ing)? out|sugar coat)\b|\b(?:which|any) of (?:the|my|them|these)\b[^.?!]{0,50}\b(?:need|support|coaching|word|attention|struggling|behind)\b|\bspot me the ones\b|\bwho would you (?:put in front of|pick|choose|prioritise|prioritize|send)\b|\bwho'?d get the most\b|\bwhere (?:do |should |would )?(?:my |the )?coaching (?:time|hours|effort)\b|\bcoaching (?:time|hours) (?:actually )?(?:need|go|goes)\b|\bmy attention best spent on the floor\b|\bone to ones?\b[^.?!]{0,40}\bwho\b/

/** A follow-up asking what drove a result already given. */
const FOLLOWUP_EXPLANATION =
  /\bwhat(?:'s| is) driving that\b|\bwhat does that mean\b|\bwhy does that matter\b|\bexplain that\b|\bwhat's behind (?:that|this)\b/;

function certain(intent: ZacAnalysisIntent, reasonCode: ZacAnalysisIntentReason): ZacAnalysisVerdict {
  return { intent, reasonCode, certain: true };
}

function heuristic(
  intent: ZacAnalysisIntent,
  reasonCode: ZacAnalysisIntentReason,
): ZacAnalysisVerdict {
  return { intent, reasonCode, certain: false };
}

function normalise(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
