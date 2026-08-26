import { ZAC_ANALYSIS_PLANNER_SCHEMA } from '../analysis/zac-analysis-planner.prompt';
import { ZAC_PRIORITY_SYNTHESIS_SCHEMA } from '../analysis/zac-priority-synthesis.prompt';
import { ZAC_SEMANTIC_ROUTER_SCHEMA } from '../routing/zac-semantic-router.prompt';

/**
 * Strict tool schemas are validated by the API, and it rejects more than plain
 * JSON Schema does. This suite exists because it did:
 *
 *   400 tools.0.custom: For 'number' type, properties maximum, minimum are not
 *       supported
 *
 * Every semantic routing call was failing on that, and the provider's
 * fail-soft contract turned a 400 into `provider_unavailable` — so ZAC
 * silently ran on its deterministic floor while /zac/health still reported
 * `semantic_routing: true`. Nothing user-visible said anything was wrong.
 *
 * A bound in a schema is not where a bound belongs anyway: `confidence` is
 * clamped in `validate()` and the tool cap is enforced in `validatePlan()`,
 * both of which run on untrusted output regardless of what the schema said.
 */
const UNSUPPORTED_KEYWORDS = ['minimum', 'maximum', 'maxItems', 'minItems', 'multipleOf'] as const;

const SCHEMAS: Array<[string, unknown]> = [
  ['semantic router', ZAC_SEMANTIC_ROUTER_SCHEMA],
  ['analysis planner', ZAC_ANALYSIS_PLANNER_SCHEMA],
  ['priority synthesis', ZAC_PRIORITY_SYNTHESIS_SCHEMA],
];

/** Every keyword used anywhere in the schema, with the path that used it. */
function collectKeywords(node: unknown, path = '$'): Array<[string, string]> {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => collectKeywords(item, `${path}[${index}]`));
  }
  if (node === null || typeof node !== 'object') return [];
  const found: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    found.push([key, `${path}.${key}`]);
    found.push(...collectKeywords(value, `${path}.${key}`));
  }
  return found;
}

describe('strict tool schemas', () => {
  it.each(SCHEMAS)('%s uses no keyword the API rejects', (_name, schema) => {
    const offenders = collectKeywords(schema)
      .filter(([key]) => (UNSUPPORTED_KEYWORDS as readonly string[]).includes(key))
      .map(([, path]) => path);

    expect(offenders).toEqual([]);
  });

  it.each(SCHEMAS)('%s is a closed object with required properties', (_name, schema) => {
    const root = schema as { type?: string; additionalProperties?: boolean; required?: string[] };
    expect(root.type).toBe('object');
    // Closed objects are what make "the model cannot add a field" true.
    expect(root.additionalProperties).toBe(false);
    expect(Array.isArray(root.required)).toBe(true);
    expect(root.required?.length).toBeGreaterThan(0);
  });

  it('every required property is actually declared', () => {
    for (const [, schema] of SCHEMAS) {
      const root = schema as { required?: string[]; properties?: Record<string, unknown> };
      for (const key of root.required ?? []) {
        expect(Object.keys(root.properties ?? {})).toContain(key);
      }
    }
  });
});
