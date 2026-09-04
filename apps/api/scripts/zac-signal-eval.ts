/**
 * ZAC Phase 2 signal evaluation — the Workstream 1 acceptance harness.
 *
 *   pnpm --filter @sheer/api zac-signal-eval
 *
 * Runs the versioned labelled dataset through the REAL Workstream 1 pipeline
 * (observation → evaluator → reconciler → signal service) over an in-memory
 * repository and prints a scorecard: per-category accuracy, the hard
 * invariants, and EVERY failed case with expected vs actual.
 *
 * Deterministic. No network, no model, no provider. Signal intelligence is
 * business logic; provider benchmarking is a separate concern
 * (scripts/zac-provider-benchmark.ts).
 *
 * Exit code 1 when any case or any hard invariant fails, so it can gate a
 * release.
 */
/* eslint-disable no-console -- this script's entire output contract is stdout. */
import { execSync } from 'node:child_process';
import {
  SIGNAL_FRAMEWORK_VERSION,
  formatSignalEvalReport,
  loadSignalEvalDataset,
  runSignalEval,
  signalEvalGatesPass,
} from '../src/zac/intelligence/eval/signal-eval';

function commitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const dataset = loadSignalEvalDataset();
  const { metrics } = await runSignalEval(dataset);
  const report = formatSignalEvalReport(metrics, {
    commit: commitSha(),
    timestamp: new Date().toISOString(),
  });
  console.log(report);
  console.log('');
  console.log(`framework ${SIGNAL_FRAMEWORK_VERSION} · steps evaluated: ${dataset.cases.reduce((n, c) => n + c.steps.length, 0)}`);
  process.exit(signalEvalGatesPass(metrics) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
