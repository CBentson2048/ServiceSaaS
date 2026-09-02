import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageUsageService } from './message-usage.service';

/**
 * Automatic accounting recovery (Wrike 4507284256, section 1).
 *
 * THE GAP THIS CLOSES. A provider can accept a message, `status='sent'` and
 * `sent_at` can commit, and the accounting write can then fail — they are three
 * separate PostgREST requests and cannot be one transaction, because the API has
 * no SQL driver and a provider call could not join a database transaction even if
 * it did. The event is terminal `sent` at that point, and the dispatcher only
 * ever re-reads `status='queued'`, so nothing revisited it. The repair routine
 * existed but had no trigger: an already-sent message could stay unaccounted
 * forever unless a human went looking.
 *
 * WHAT IT IS NOT: a sender. It never calls a provider, never opens a provider
 * connection and never enqueues a message. It reads events already durably marked
 * sent and re-runs the idempotent recorder. It therefore CANNOT cause a message
 * to be delivered twice, because it cannot cause a message to be delivered at
 * all — which is the property that makes running it automatically safe.
 *
 * MULTI-INSTANCE SAFETY IS NOT A LOCK. `comms.message_usage_entries`'
 * UNIQUE (business_id, logical_message_key) makes double counting impossible, so
 * two instances ticking at the same moment is a WASTE problem, not a correctness
 * one: the loser's calls return counted=false and change nothing. The
 * dispatcher's `locked_until` claim exists because a provider call is NOT
 * idempotent — a second worker there would send a second real message. That
 * reason is absent here, and borrowing `notification_events.locked_until` would
 * collide with the dispatcher's own use of the column. No advisory lock either:
 * 0104 records the house position ("no advisory locks, no leader election, no
 * external scheduler") and there is not one pg_advisory_* call in the repo.
 *
 * NO SEPARATE SUPABASE CLIENT, deliberately. The anti-join and the recorder are
 * one thought and both live on MessageUsageService, which already owns the
 * accounting service-role client. This class is a timer, a guard and a bound.
 */
@Injectable()
export class MessageUsageRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageUsageRecoveryService.name);

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxDrainBatches: number;
  private readonly graceSeconds: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly usage: MessageUsageService,
  ) {
    this.enabled = (config.get<string>('MESSAGE_USAGE_RECOVERY_ENABLED') ?? 'true').toLowerCase() !== 'false';
    // Every 15 minutes by default. Recovery is a repair, not a deadline: a unit
    // counted a quarter of an hour late is indistinguishable on an invoice, and
    // polling harder would scan the same anti-join for nothing.
    this.intervalMs = clampInt(config.get('MESSAGE_USAGE_RECOVERY_INTERVAL_MS'), 900_000, 60_000, 3_600_000);
    this.batchSize = clampInt(config.get('MESSAGE_USAGE_RECOVERY_BATCH_SIZE'), 200, 1, 1_000);
    this.maxDrainBatches = clampInt(config.get('MESSAGE_USAGE_RECOVERY_MAX_DRAIN_BATCHES'), 5, 1, 100);
    // Never race the recordSend that markAccepted is running right now: a message
    // accepted seconds ago is not yet evidence of a failure.
    this.graceSeconds = clampInt(config.get('MESSAGE_USAGE_RECOVERY_GRACE_SECONDS'), 300, 0, 86_400);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Message usage recovery is disabled (MESSAGE_USAGE_RECOVERY_ENABLED=false).');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(`Message usage recovery started (every ${this.intervalMs}ms).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drain the unaccounted backlog in bounded batches. Public so a test or an
   * operator surface can trigger it without waiting for the interval.
   *
   * NEVER THROWS. An unhandled rejection inside a setInterval callback would take
   * the whole API process down, and an uncounted message is not worth a restart.
   *
   * THE CURSOR IS LOAD-BEARING, not an optimisation. A row this pass failed to
   * record is still unaccounted, so without a keyset the next pass would fetch
   * the same rows forever and never reach the ones behind them. Stepping past it
   * leaves it for the NEXT TICK — which is exactly the required "retry on a
   * future run" behaviour, with no retry counter to maintain.
   */
  async tick(): Promise<void> {
    if (this.running) return; // prevent overlapping ticks
    this.running = true;
    try {
      let cursor: { sentAt: string; id: string } | null = null;
      let found = 0;
      let recorded = 0;
      let failed = 0;

      for (let pass = 0; pass < this.maxDrainBatches; pass++) {
        const outcome = await this.usage.recoverUnaccountedSends({
          limit: this.batchSize,
          graceSeconds: this.graceSeconds,
          after: cursor,
        });
        found += outcome.found;
        recorded += outcome.recorded;
        failed += outcome.failed;
        // A short page means the backlog is drained; no cursor means nothing to
        // resume from. Either way, stop rather than spin.
        if (outcome.found < this.batchSize || !outcome.cursor) break;
        cursor = outcome.cursor;
      }

      if (found > 0) {
        // WARN, not LOG. Recovery working is not the same as nothing being
        // wrong: every row found is a send whose accounting write was lost, and
        // that is worth seeing in a log search even though it was repaired.
        this.logger.warn(
          `message usage recovery: ${recorded} recorded, ${failed} still failing, of ${found} unaccounted sends`,
        );
      }
    } catch (err) {
      this.logger.error(`message usage recovery tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
