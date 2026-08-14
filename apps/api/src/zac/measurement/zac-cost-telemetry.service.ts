import { Injectable, Logger } from '@nestjs/common';
import type { ZacRoleContext } from '../context/zac-context.types';

/**
 * One cost event per model call. Safe operational metadata ONLY — never prompt,
 * answer, memory or evidence text. Shape mirrors the authored (unapplied)
 * `zac.cost_events` table so the Week 2 switch to DB persistence is mechanical.
 */
export interface ZacCostEvent {
  trace_id: string;
  conversation_id: string | null;
  business_id: string;
  location_id: string | null;
  actor_user_id: string;
  role_context: ZacRoleContext;
  provider: string;
  model: string;
  task_type: 'qa';
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number;
  latency_ms: number;
  tool_calls_used: number;
  cache_hit: boolean;
}

/** Measurement-spine vocabulary emitted from the very first interaction. */
export type ZacSpineEventName =
  | 'conversation_started'
  | 'question_asked'
  | 'answer_delivered'
  | 'source_used'
  | 'cost_recorded'
  /** Live narration failed (refusal/unavailable); the deterministic answer served instead. */
  | 'model_fallback';

export interface ZacSpineEventMetadata {
  trace_id: string;
  business_id: string;
  actor_user_id: string;
  role_context: ZacRoleContext;
  [key: string]: string | number | boolean | null;
}

/**
 * Week 1 cost/measurement foundation. Events go to the structured log until the
 * `zac` storage migration is applied (then this switches to fail-soft DB writes
 * of the same shapes). A telemetry failure must never break an answer, but it
 * emits a distinct high-severity signal instead of vanishing silently.
 */
@Injectable()
export class ZacCostTelemetryService {
  private readonly logger = new Logger(ZacCostTelemetryService.name);

  recordCostEvent(event: ZacCostEvent): void {
    try {
      this.logger.log(JSON.stringify({ event: 'zac.cost_event', ...event }));
    } catch (error) {
      this.logger.error(
        `zac cost event write failed (trace ${event.trace_id}): ${(error as Error).message}`,
      );
    }
  }

  recordSpineEvent(name: ZacSpineEventName, metadata: ZacSpineEventMetadata): void {
    try {
      this.logger.log(JSON.stringify({ event: `zac.spine.${name}`, ...metadata }));
    } catch (error) {
      this.logger.error(`zac spine event ${name} write failed: ${(error as Error).message}`);
    }
  }
}
