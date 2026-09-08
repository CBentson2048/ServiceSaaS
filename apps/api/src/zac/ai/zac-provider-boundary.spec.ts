import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * THE IMPORT BOUNDARY, asserted rather than documented.
 *
 * The architectural rule of this refactor is one sentence: ZAC business and
 * orchestration code must not depend on OpenAI or Anthropic SDK types. A rule
 * that lives only in a document is a rule that decays on the first busy
 * afternoon, so it is a test.
 *
 * The allowlist is deliberately tiny and explicit. Adding a file to it is a
 * deliberate act with a reviewer attached — which is the point.
 */

const ZAC_ROOT = join(__dirname, '..');

/**
 * The ONLY files permitted to import a provider SDK. Each is a vendor adapter:
 * its whole job is to translate between a ZAC contract and one vendor's API.
 */
const PROVIDER_ADAPTERS: readonly string[] = [
  'models/providers/anthropic-zac-provider.ts',
  'models/providers/openai-semantic-provider.ts',
  'models/providers/openai-zac-provider.ts',
];

/** Their specs mock the SDK, which necessarily names it. */
const ADAPTER_SPECS: readonly string[] = [
  'models/providers/anthropic-zac-provider.spec.ts',
  'models/providers/openai-semantic-provider.spec.ts',
  'models/providers/openai-zac-provider.spec.ts',
];

const SDK_IMPORT = /^\s*import\s[^;]*?from\s+['"](openai|@anthropic-ai\/[^'"]+)['"]/m;

/**
 * Repo-relative path with POSIX separators.
 *
 * `relative()` returns the HOST's separators, so on Windows every path came
 * back as `models\providers\...` and matched neither the allowlist
 * constants below nor `startsWith('intelligence/')`. The sweep then reported
 * every adapter as an unlisted offender and the intelligence layer as almost
 * empty — a boundary test that fails on one OS and passes on another is worse
 * than none, because the failure is assumed to be the platform's fault.
 */
function repoPath(file: string): string {
  return relative(ZAC_ROOT, file).split(sep).join('/');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('provider SDK imports are confined to provider adapters', () => {
  const files = walk(ZAC_ROOT).map((file) => ({
    path: repoPath(file),
    source: readFileSync(file, 'utf8'),
  }));

  it('finds the ZAC tree (guards against a silently empty sweep)', () => {
    // A boundary test that scans nothing passes forever.
    expect(files.length).toBeGreaterThan(50);
  });

  it('lets no file outside the adapter allowlist import a provider SDK', () => {
    const allowed = new Set([...PROVIDER_ADAPTERS, ...ADAPTER_SPECS]);
    const offenders = files
      .filter((file) => SDK_IMPORT.test(file.source))
      .map((file) => file.path)
      .filter((path) => !allowed.has(path));

    expect(offenders).toEqual([]);
  });

  it('keeps every allowlisted adapter real — an allowlist of dead paths proves nothing', () => {
    for (const adapter of PROVIDER_ADAPTERS) {
      const file = files.find((candidate) => candidate.path === adapter);
      expect(file).toBeDefined();
      expect(SDK_IMPORT.test(file!.source)).toBe(true);
    }
  });

  it('keeps the Workstream 1 intelligence layer entirely provider-free', () => {
    // The signal framework is deterministic business intelligence. A provider
    // SDK — or even a provider NAME — appearing there would mean an AI vendor
    // had reached into metric definitions, evaluators or the lifecycle.
    const intelligence = files.filter(
      (file) => file.path.startsWith('intelligence/') || file.path.endsWith('intelligence-signal.store.ts'),
    );
    expect(intelligence.length).toBeGreaterThan(10);
    for (const file of intelligence) {
      expect(SDK_IMPORT.test(file.source)).toBe(false);
      expect(file.source).not.toMatch(/\bAnthropic\b|\bOpenAI\b/);
    }
  });

  it('keeps provider selection out of orchestration', () => {
    // The resolver is the one place that may branch on a vendor. If this
    // appeared in the orchestration, a provider comparison would be measuring
    // a workload that changes shape depending on the thing being measured.
    const orchestration = files.filter(
      (file) =>
        (file.path.startsWith('analysis/') ||
          file.path.startsWith('routing/') ||
          file.path === 'zac.service.ts') &&
        !file.path.endsWith('.spec.ts'),
    );
    for (const file of orchestration) {
      expect(file.source).not.toMatch(/===\s*'openai'|===\s*'anthropic'/);
    }
  });
});
