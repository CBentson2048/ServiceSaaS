import type { AuthUser, Permission, UserRole } from '@sheer/domain';
import type { ZacActingContext } from '../context/zac-context.types';
// Type-only imports from the response contract (erased at compile time, so the
// mutual type-only reference between these two files carries no runtime cycle).
import type {
  ZacConfidence,
  ZacEvidenceItem,
  ZacResponseType,
} from '../responses/zac-response.types';

export type ZacToolName =
  | 'context.business_summary'
  | 'context.location_summary'
  | 'context.capabilities'
  | 'report.business_health'
  | 'report.kpi_summary'
  | 'report.rebooking_summary'
  | 'report.utilisation_summary'
  | 'report.stylist_performance'
  | 'kpi.personal_coaching'
  | 'qlab.colour_analytics'
  | 'inventory.stock_status';

export type ZacToolDomain = 'context' | 'report' | 'kpi' | 'qlab' | 'inventory';

export type ZacToolResultStatus =
  | 'ok'
  | 'not_connected'
  | 'permission_denied'
  | 'unavailable'
  | 'error';

/**
 * Answer-first material a live tool supplies for the response builder: the
 * user-facing answer, why/evidence, honest limitations and the next useful
 * action. All text is PII-safe by construction. Skeleton/denied results omit
 * this block and the builder falls back to a safe explanation.
 */
export interface ZacToolPresentation {
  answer: string;
  evidence: ZacEvidenceItem[];
  confidence: ZacConfidence;
  limitations: string[];
  suggestedNextStep: string | null;
  responseType: ZacResponseType;
}

/**
 * What a tool hands back to the orchestrator. `data` is structured and PII-safe
 * (safe handles like client_code, never names/contact details); `explanation` is
 * role-appropriate text ZAC may relay verbatim, e.g. why data is unavailable.
 */
export interface ZacToolResult {
  status: ZacToolResultStatus;
  data: Record<string, unknown> | null;
  explanation: string;
  rowCount: number | null;
  presentation?: ZacToolPresentation;
}

/** Per-dispatch trace, persisted/logged as metadata only — never arguments or results. */
export interface ZacToolDispatchTrace {
  tool: ZacToolName;
  status: ZacToolResultStatus;
  latency_ms: number;
  row_count: number | null;
}

/**
 * The base contract every ZAC tool implements. Read-only is structural: the
 * registry refuses anything whose `readOnly` is not literally `true`, and no
 * write-capable contract exists to implement. Permissions declared here are
 * re-checked at dispatch time against the guard-verified actor — `zac.access`
 * alone never unlocks a tool.
 */
export interface ZacReadOnlyTool {
  readonly name: ZacToolName;
  readonly domain: ZacToolDomain;
  readonly description: string;
  /** Roles the tool may appear for. Never contains 'client'. */
  readonly allowedRoles: readonly UserRole[];
  /** ALL of these are required; re-checked at dispatch, never trusted from registration. */
  readonly requiredPermissions: readonly Permission[];
  /** When non-empty, at least ONE of these is additionally required (e.g. commission OR performance). */
  readonly anyOfPermissions: readonly Permission[];
  /** JSON-schema-shaped contracts for the model tool-use layer (wired Week 2+). */
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly readOnly: true;
  /** Fields stripped from output unless the actor holds the permission noted in the tool docs. */
  readonly sensitiveFields: readonly string[];
  readonly errorBehavior: 'fail_closed';
  readonly fallbackBehavior: 'state_unavailable';
  readonly piiLevel: 'none' | 'low' | 'high';
  readonly cachePolicy: { readonly ttlSeconds: number; readonly perTenant: true };
  readonly rateLimit: { readonly perMinute: number };
  /** True when the acting user must be the stylist the data belongs to (staffProfileId present). */
  readonly requiresStaffSelf: boolean;
  /** False until the tool is wired to its guarded QLOOQO service (Week 2+). */
  readonly enabled: boolean;
  /**
   * `actor` is the guard-verified AuthUser, passed through unchanged so live
   * tools can call existing guarded QLOOQO services (which re-check role and
   * scope themselves) — ZAC never opens its own business-data DB client.
   */
  execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult>;
}
