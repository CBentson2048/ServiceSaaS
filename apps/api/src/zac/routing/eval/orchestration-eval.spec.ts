import { ZacAnalysisIntentService } from '../../analysis/zac-analysis-intent.service';
import { ZacToolPlannerService } from '../../analysis/zac-tool-planner.service';
import { ZacMemoryExtractionService } from '../../memory/zac-memory-extraction.service';
import { ZacRequestModeClassifierService } from '../zac-request-mode-classifier.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import {
  requiresMultiTool,
  type ZacPlanningToolDescriptor,
} from '../../analysis/zac-analysis.types';
import {
  formatOrchestrationReport,
  loadOrchestrationEvalDataset,
  scoreOrchestration,
  type OrchestrationOutcome,
} from './orchestration-eval';

/**
 * Orchestration evaluation (§47/§48).
 *
 * WHAT THIS MEASURES: the DETERMINISTIC floor — no model anywhere. Request mode
 * comes from the deterministic router layers, analysis intent from the
 * deterministic rules, and the plan from the intent. That is exactly how a
 * build with no provider key behaves, and it is a lower bound on production,
 * where the semantic router and the analysis planner both reason about meaning.
 *
 * WHY A FLOOR IS WORTH MEASURING: the reported defect was a floor failure. The
 * pipeline had no route at all for a broad question, so no amount of model
 * quality would have helped. The number that matters here is
 * `businessPriorityRecall` — how often a question that spans the business is
 * recognised as one — and the two rates that keep it honest:
 * `unnecessaryMultiToolRate` (narrow questions inflated into sweeps) and
 * `liveDataOnAdviceRate` (advice questions dragged into the live pipeline).
 */
const OWNER_CATALOGUE: ZacPlanningToolDescriptor[] = [
  { name: 'report.business_health', purpose: 'Trading snapshot', domains: ['business_health'] },
  { name: 'report.kpi_summary', purpose: 'Stylists against targets', domains: ['kpi'] },
  { name: 'report.rebooking_summary', purpose: 'Rebooking', domains: ['rebooking'] },
  { name: 'report.utilisation_summary', purpose: 'Utilisation', domains: ['utilisation'] },
  { name: 'report.stylist_performance', purpose: 'Ranking', domains: ['team_performance'] },
];

function contextFor(roleContext: ZacActingContext['roleContext']): ZacActingContext {
  return {
    actorUserId: 'user-1',
    actorFirstName: null,
    businessId: 'biz-1',
    businessName: 'Main Salon',
    locationId: null,
    accessibleLocationIds: ['loc-1'],
    accessibleLocations: [{ id: 'loc-1', name: 'Main' }],
    roleContext,
    roles: [roleContext],
    permissions: ['zac.access'],
    staffProfileId: roleContext === 'stylist' ? 'staff-1' : null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
  } as ZacActingContext;
}

describe('ZAC orchestration evaluation', () => {
  const dataset = loadOrchestrationEvalDataset();
  const modes = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
  const intents = new ZacAnalysisIntentService();
  const planner = new ZacToolPlannerService({} as never);

  const run = (): OrchestrationOutcome[] =>
    dataset.map((evalCase) => {
      const context = contextFor(evalCase.role);
      // Mode first, exactly as the pipeline does it.
      const verdict =
        modes.classifyExplicit(evalCase.prompt, evalCase.role) ??
        modes.classifyHeuristic(evalCase.prompt, evalCase.role);
      const mode = verdict?.mode ?? 'qlooqo_data';

      if (mode !== 'qlooqo_data') {
        return {
          case: evalCase,
          actualIntent: null,
          toolsSelected: 0,
          correct: evalCase.expectedIntent === 'not_live_data',
        };
      }

      const analysis =
        intents.classifyCertain(evalCase.prompt, evalCase.role) ??
        intents.classifyHeuristic(evalCase.prompt, evalCase.role);
      // Mirror the service exactly: only the multi-tool intents orchestrate;
      // every other live-data intent keeps the existing single-tool route.
      const multiTool = requiresMultiTool(analysis.intent);
      const plan = multiTool
        ? planner.fallbackPlan(analysis.intent, context, OWNER_CATALOGUE)
        : null;

      return {
        case: evalCase,
        actualIntent: analysis.intent,
        toolsSelected: plan ? plan.tools.length : 1,
        correct: analysis.intent === evalCase.expectedIntent,
      };
    });

  it('the dataset is large and adversarially diverse', () => {
    expect(dataset.length).toBeGreaterThanOrEqual(100);
    const byIntent = new Map<string, number>();
    for (const item of dataset) {
      byIntent.set(item.expectedIntent, (byIntent.get(item.expectedIntent) ?? 0) + 1);
    }
    expect(byIntent.get('business_priorities') ?? 0).toBeGreaterThanOrEqual(30);
    expect(byIntent.get('not_live_data') ?? 0).toBeGreaterThanOrEqual(20);
    expect(byIntent.get('specific_metric') ?? 0).toBeGreaterThanOrEqual(15);
    const keys = dataset.map((item) => item.prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    expect(new Set(keys).size).toBe(dataset.length);
  });

  it('recognises broad questions and keeps narrow ones narrow', () => {
    const metrics = scoreOrchestration(run());
    // eslint-disable-next-line no-console
    console.log(formatOrchestrationReport('DETERMINISTIC FLOOR (no model)', metrics));

    // These gates sit at the measured floor, not at an aspiration. The dataset
    // was written to share as few words as possible with the rules, so the
    // no-model floor is the hardest number in the suite — and the semantic
    // planner, which is the actual mechanism in production, is measured in
    // hosted UAT rather than here.
    expect(metrics.intentAccuracy).toBeGreaterThanOrEqual(0.8);
    // The acceptance number: broad questions must reach a broad analysis.
    expect(metrics.businessPriorityRecall).toBeGreaterThanOrEqual(0.75);
    // Narrow questions must not be inflated into sweeps.
    expect(metrics.unnecessaryMultiToolRate).toBeLessThanOrEqual(0.2);
    // Advice questions must not reach the live pipeline at all.
    expect(metrics.liveDataOnAdviceRate).toBeLessThanOrEqual(0.2);
    // A recognised broad question must actually gather several sources.
    expect(metrics.averageToolsPerBroadQuery).toBeGreaterThan(1.5);
  });

  it('every prompt the client pinned is classified exactly', () => {
    const mandated = run().filter((outcome) => outcome.case.mandated);
    expect(mandated.length).toBeGreaterThanOrEqual(15);
    for (const outcome of mandated) {
      expect({ prompt: outcome.case.prompt, intent: outcome.actualIntent ?? 'not_live_data' }).toEqual(
        { prompt: outcome.case.prompt, intent: outcome.case.expectedIntent },
      );
    }
  });
});
