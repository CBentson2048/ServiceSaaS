/**
 * The routing inspector renders the API's closed routing enums through the
 * label registry in @sheer/domain. This pins the two vocabularies to each
 * other in BOTH directions, so a new server value cannot ship without a label
 * and a client label cannot name a value the server never sends.
 */
import {
  ZAC_ANALYSIS_INTENT_LABELS,
  ZAC_CLASSIFICATION_SOURCE_LABELS,
  ZAC_CONFIDENCE_BUCKET_LABELS,
  ZAC_FALLBACK_REASON_LABELS,
  ZAC_INFORMATION_SOURCE_LABELS,
  ZAC_REQUEST_MODE_LABELS,
  ZAC_ROUTING_MODE_LABELS,
  ZAC_SEMANTIC_FAILURE_KIND_LABELS,
} from '@sheer/domain';
import { ZAC_ANALYSIS_INTENTS } from '../analysis/zac-analysis.types';
import type { ZacSemanticFailureKind } from '../models/zac-semantic-health.service';
import {
  ZAC_CONFIDENCE_BUCKETS,
  ZAC_INFORMATION_SOURCES,
  ZAC_REQUEST_MODES,
  ZAC_ROUTING_MODES,
} from './zac-request-mode.types';
import type { ZacClassificationSource, ZacClassifierFailure } from './zac-request-mode.types';

describe('routing inspector contract (@sheer/domain labels ↔ API enums)', () => {
  it('labels exactly the request modes the server can return', () => {
    expect(Object.keys(ZAC_REQUEST_MODE_LABELS).sort()).toEqual([...ZAC_REQUEST_MODES].sort());
  });

  it('labels exactly the analysis intents the router and planner can return', () => {
    expect(Object.keys(ZAC_ANALYSIS_INTENT_LABELS).sort()).toEqual([...ZAC_ANALYSIS_INTENTS].sort());
  });

  it('labels exactly the information sources, routing modes and confidence buckets', () => {
    expect(Object.keys(ZAC_INFORMATION_SOURCE_LABELS).sort()).toEqual(
      [...ZAC_INFORMATION_SOURCES].sort(),
    );
    expect(Object.keys(ZAC_ROUTING_MODE_LABELS).sort()).toEqual([...ZAC_ROUTING_MODES].sort());
    expect(Object.keys(ZAC_CONFIDENCE_BUCKET_LABELS).sort()).toEqual(
      [...ZAC_CONFIDENCE_BUCKETS].sort(),
    );
  });

  it('labels every classification source, classifier failure and shadow failure kind (type-level)', () => {
    // These enums are types without a runtime list; the assignments below only
    // compile when the label maps cover them exactly, in both directions.
    const sources: Record<ZacClassificationSource, string> = ZAC_CLASSIFICATION_SOURCE_LABELS;
    const sourcesBack: Record<keyof typeof ZAC_CLASSIFICATION_SOURCE_LABELS, string> =
      {} as Record<ZacClassificationSource, string>;
    const failures: Record<ZacClassifierFailure, string> = ZAC_FALLBACK_REASON_LABELS;
    const failuresBack: Record<keyof typeof ZAC_FALLBACK_REASON_LABELS, string> =
      {} as Record<ZacClassifierFailure, string>;
    const kinds: Record<ZacSemanticFailureKind, string> = ZAC_SEMANTIC_FAILURE_KIND_LABELS;
    const kindsBack: Record<keyof typeof ZAC_SEMANTIC_FAILURE_KIND_LABELS, string> =
      {} as Record<ZacSemanticFailureKind, string>;
    expect([sources, sourcesBack, failures, failuresBack, kinds, kindsBack]).toHaveLength(6);
  });

  it('uses the spec wording for the human labels', () => {
    expect(ZAC_REQUEST_MODE_LABELS.qlooqo_data).toBe('QLOOQO Data');
    expect(ZAC_REQUEST_MODE_LABELS.general_advice).toBe('General Knowledge / Advice');
    expect(ZAC_REQUEST_MODE_LABELS.permission_capability).toBe('Permission / Capability');
    expect(ZAC_ANALYSIS_INTENT_LABELS.business_priorities).toBe('Business Priorities');
    expect(ZAC_FALLBACK_REASON_LABELS.classification_timeout).toBe('Provider timeout');
    expect(ZAC_FALLBACK_REASON_LABELS.classification_invalid).toBe('Semantic validation failure');
  });
});
