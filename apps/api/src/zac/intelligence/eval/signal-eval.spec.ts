import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIGNAL_EVAL_DATASET_VERSION,
  formatSignalEvalReport,
  loadSignalEvalDataset,
  runSignalEval,
  signalEvalGatesPass,
} from './signal-eval';

/**
 * The Workstream 1 evaluation gate.
 *
 * This is the dataset-driven counterpart to the A–L unit fixtures: the SAME
 * real pipeline (observation → evaluator → reconciler → service visibility)
 * over an in-memory repository, scored per check so no aggregate hides a
 * failure. It runs in CI and it is what `pnpm --filter @sheer/api
 * zac-signal-eval` prints.
 *
 * Deterministic, no network, no model, no provider. It must stay that way.
 */
describe('ZAC Phase 2 signal evaluation harness', () => {
  const dataset = loadSignalEvalDataset();

  it('loads a versioned dataset with meaningful coverage', () => {
    expect(dataset.version).toBe(SIGNAL_EVAL_DATASET_VERSION);
    expect(dataset.cases.length).toBeGreaterThanOrEqual(50);
    const domains = new Set(dataset.cases.map((c) => c.domain));
    expect([...domains].sort()).toEqual(['dedupe', 'lifecycle', 'rebooking', 'scoping', 'utilisation']);
  });

  it('passes every case and every hard invariant', async () => {
    const { metrics } = await runSignalEval(dataset);
    const report = formatSignalEvalReport(metrics, { commit: 'jest', timestamp: 'jest' });
    // The full scorecard is the failure message: a red build must say WHICH
    // case, WHICH step, expected what and got what.
    if (!signalEvalGatesPass(metrics)) {
      throw new Error(`\n${report}`);
    }
    expect(metrics.failed).toBe(0);
    for (const [invariant, failures] of Object.entries(metrics.invariantFailures)) {
      expect({ invariant, failures }).toEqual({ invariant, failures: 0 });
    }
  });

  it('asserts every scorecard category at least once — an unasserted metric is not measured', async () => {
    const { metrics } = await runSignalEval(dataset);
    const unasserted = Object.entries(metrics.accuracy)
      .filter(([category, a]) => a.asserted === 0 && category !== 'limitations')
      .map(([category]) => category);
    expect(unasserted).toEqual([]);
  });

  it('never consults a model provider', () => {
    // The harness module and the framework it exercises must have no path to
    // a provider SDK. The broader import-boundary test covers the tree; this
    // pins the harness itself.
    const source = readFileSync(join(__dirname, 'signal-eval.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"](openai|@anthropic-ai)/);
    expect(source).not.toContain('ZAC_AI_PROVIDER');
  });
});
