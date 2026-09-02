/**
 * The v2 structured-output schema contract. The previous semantic router
 * silently 400ed for WEEKS because its schema carried keywords the API
 * rejects — so the v2 schema is held to an ALLOWLIST (not a blocklist) at
 * boot and here: only affirmatively-known-safe keywords, every object closed,
 * every property required, no numeric types at all. Plus the guarantee that
 * every enum in the wire schema matches the closed server-side enums the
 * router validates against — a drifted enum would make the API "guarantee"
 * values the server then discards.
 */

import {
  ZacSemanticHealthService,
  findStrictSchemaViolations,
} from './zac-semantic-health.service';
import {
  ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA,
} from '../routing/zac-semantic-router.prompt';
import {
  ZAC_CONFIDENCE_BUCKETS,
  ZAC_INFORMATION_SOURCES,
  ZAC_REQUEST_MODES,
  ZAC_ROUTER_ANALYSIS_INTENTS,
  ZAC_ROUTING_REASON_CODES,
} from '../routing/zac-request-mode.types';
import { ZAC_RESOURCE_CATEGORIES } from '../policy/zac-policy.types';

describe('v2 semantic route schema contract', () => {
  it('passes the strict allowlist validator', () => {
    expect(findStrictSchemaViolations('router v2', ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA)).toEqual([]);
  });

  it('is validated at BOOT by the health service, not on first traffic', () => {
    const health = new ZacSemanticHealthService();
    expect(health.schemaValid).toBe(true);
    expect(health.schemaIssues).toEqual([]);
  });

  it('requires every declared property (the strict-mode contract)', () => {
    const schema = ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA;
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it('mirrors the closed server-side enums exactly — no drift in either direction', () => {
    const properties = ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA.properties;
    expect([...properties.mode.enum]).toEqual([...ZAC_REQUEST_MODES]);
    expect([...properties.analysis_intent.enum]).toEqual([...ZAC_ROUTER_ANALYSIS_INTENTS]);
    expect([...properties.information_source.enum]).toEqual([...ZAC_INFORMATION_SOURCES]);
    expect([...properties.confidence.enum]).toEqual([...ZAC_CONFIDENCE_BUCKETS]);
    expect([...properties.reason_code.enum]).toEqual([...ZAC_ROUTING_REASON_CODES]);
    expect([...properties.resource_category.enum]).toEqual([...ZAC_RESOURCE_CATEGORIES]);
  });

  it('carries no numeric field anywhere — the keyword class that 400ed silently', () => {
    const types: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (typeof record.type === 'string') types.push(record.type);
      Object.values(record).forEach(walk);
    };
    walk(ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA);
    expect(types).not.toContain('number');
    expect(types).not.toContain('integer');
  });
});

describe('findStrictSchemaViolations', () => {
  const valid = {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { type: 'string', enum: ['a', 'b'] }, live: { type: 'boolean' } },
    required: ['kind', 'live'],
  };

  it('accepts the strict subset', () => {
    expect(findStrictSchemaViolations('t', valid)).toEqual([]);
  });

  it.each([
    ['numeric bounds', { ...valid, properties: { ...valid.properties, kind: { type: 'number', minimum: 0 } } }],
    ['open objects', { ...valid, additionalProperties: undefined }],
    ['optional properties', { ...valid, required: ['kind'] }],
    ['unknown required names', { ...valid, required: ['kind', 'live', 'ghost'] }],
    ['pattern keywords', { ...valid, properties: { ...valid.properties, kind: { type: 'string', pattern: '^a' } } }],
    ['refs', { ...valid, properties: { ...valid.properties, kind: { $ref: '#/defs/kind' } } }],
    ['bare number types', { ...valid, properties: { ...valid.properties, live: { type: 'number' } } }],
    ['empty enums', { ...valid, properties: { ...valid.properties, kind: { type: 'string', enum: [] } } }],
  ])('rejects %s', (_label, schema) => {
    expect(findStrictSchemaViolations('t', schema).length).toBeGreaterThan(0);
  });

  it('walks nested arrays and objects', () => {
    const nested = {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { score: { type: 'number' } },
            required: ['score'],
          },
        },
      },
      required: ['items'],
    };
    const problems = findStrictSchemaViolations('t', nested);
    expect(problems.some((p) => p.includes('items.properties.score'))).toBe(true);
  });
});
