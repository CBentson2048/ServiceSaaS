import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { EXPO_PUSH_CHUNK_SIZE, ExpoPushProvider, type ExpoPushMessage } from './expo-push.provider';

/**
 * Drains comms.push_deliveries and sends each queued attempt to the push provider.
 *
 * ---------------------------------------------------------------------------
 * WHY A POLLER AND NOT AN INLINE SEND
 * ---------------------------------------------------------------------------
 * Check-in is a front-desk action and is latency-sensitive. Putting a third-party
 * HTTP call on that path would make reception wait for Expo, and a dangling
 * promise would lose every in-flight push on deploy or crash. A claim-based poller
 * over a table means the attempt survives a restart, retries with a bound, and can
 * be inspected afterwards. This mirrors NotificationDispatchService, which already
 * drains comms.notification_events the same way — same lease-based claim, same
 * bounded drain, same unref'd timer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SERVICE MUST NEVER DO
 * ---------------------------------------------------------------------------
 * Fail a check-in, or fail a notification. It runs on its own timer, entirely
 * outside any request. comms.notifications is the durable record the stylist
 * actually reads; everything here is a best-effort delivery channel on top of it.
 * If this service is disabled, broken, or the provider is down, the arrival alert
 * still appears in the app.
 *
 * Log a push token. Rows are joined to comms.user_devices to read the token, and
 * that value is passed to the provider and then dropped. Every log line here
 * carries ids only.
 */

interface DueRow {
  id: string;
  notification_id: string;
  user_device_id: string;
  user_profile_id: string;
  attempts: number;
}

interface DeliveryContext {
  id: string;
  attempts: number;
  deviceId: string;
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/** How long a claimed row stays owned by this worker before another may retry it. */
const LOCK_TTL_MS = 120_000;

@Injectable()
export class PushDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDispatchService.name);
  private readonly admin: SupabaseClient;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly maxDrainBatches: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly provider: ExpoPushProvider,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    this.enabled = (config.get<string>('PUSH_DISPATCH_ENABLED') ?? 'true').toLowerCase() !== 'false';
    // 15s rather than the outbound dispatcher's 60s: an arrival alert is worth
    // little if it lands after the client has been taken through to the chair.
    this.intervalMs = clampInt(config.get('PUSH_DISPATCH_INTERVAL_MS'), 15_000, 5_000, 600_000);
    this.batchSize = clampInt(config.get('PUSH_DISPATCH_BATCH_SIZE'), 50, 1, EXPO_PUSH_CHUNK_SIZE);
    this.maxAttempts = clampInt(config.get('PUSH_DISPATCH_MAX_ATTEMPTS'), 3, 1, 10);
    this.maxDrainBatches = clampInt(config.get('PUSH_DISPATCH_MAX_DRAIN_BATCHES'), 20, 1, 1_000);
  }

  onModuleInit(): void {
    if (!this.enabled || !this.provider.enabled) {
      this.logger.log(
        'Push dispatch is disabled; in-app notifications are unaffected. ' +
          '(PUSH_DISPATCH_ENABLED / EXPO_PUSH_ENABLED)',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // unref so a poller can never hold the process open during shutdown.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(`Push dispatch poller started (every ${this.intervalMs}ms).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drain the queued backlog in bounded batches. Public so tests and any future
   * admin surface can trigger a drain without waiting for the interval.
   *
   * NEVER THROWS: an unhandled rejection inside a setInterval callback would take
   * the process down, and a push backlog is not worth an API restart.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let pass = 0; pass < this.maxDrainBatches; pass++) {
        const due = await this.fetchDue();
        if (due.length === 0) break;

        const claimed: DueRow[] = [];
        for (const row of due) {
          if (await this.claim(row)) claimed.push(row);
        }
        if (claimed.length === 0) break; // all taken by another worker

        await this.processBatch(claimed);
        if (due.length < this.batchSize) break;
      }
    } catch (err) {
      this.logger.error(`push dispatch tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async fetchDue(): Promise<DueRow[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.admin
      .schema('comms')
      .from('push_deliveries')
      .select('id,notification_id,user_device_id,user_profile_id,attempts')
      .eq('status', 'queued')
      .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
      .order('created_at', { ascending: true })
      .limit(this.batchSize)
      .returns<DueRow[]>();

    if (error) throw new Error(`fetch due push deliveries failed: ${error.message}`);
    return data ?? [];
  }

  /** Take ownership by stamping the lease, conditional on the row still being queued. */
  private async claim(row: DueRow): Promise<boolean> {
    const now = new Date();
    const { data, error } = await this.admin
      .schema('comms')
      .from('push_deliveries')
      .update({
        locked_until: new Date(now.getTime() + LOCK_TTL_MS).toISOString(),
        processing_started_at: now.toISOString(),
        attempts: row.attempts + 1,
      })
      .eq('id', row.id)
      .eq('status', 'queued')
      .lt('attempts', this.maxAttempts)
      .select('id')
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`claim push delivery ${row.id} failed: ${error.message}`);
      return false;
    }
    if (!data) {
      // Either another worker won it, or it has exhausted its attempts. The latter
      // must not sit queued forever, so retire it here.
      await this.retireIfExhausted(row);
      return false;
    }
    return true;
  }

  private async retireIfExhausted(row: DueRow): Promise<void> {
    if (row.attempts < this.maxAttempts) return;
    await this.finish(row.id, {
      status: 'failed',
      last_error: `giving up after ${row.attempts} attempts`,
    });
  }

  /**
   * Resolve each claimed row to a live token, send in one provider call, then
   * record every outcome.
   *
   * The device is re-read at send time on purpose: a stylist may have logged out
   * between enqueue and now, and pushing to a handset that has since been disabled
   * is exactly the leak the `enabled` flag exists to prevent.
   */
  private async processBatch(rows: DueRow[]): Promise<void> {
    const contexts = await this.resolve(rows);
    if (contexts.length === 0) return;

    const messages: ExpoPushMessage[] = contexts.map((c) => ({
      token: c.token,
      title: c.title,
      body: c.body,
      data: c.data,
    }));

    const results = await this.provider.send(messages);

    for (let i = 0; i < contexts.length; i++) {
      const context = contexts[i];
      const result = results[i];
      if (!result) continue;

      if (result.ok) {
        await this.finish(context.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          provider_receipt_id: result.receiptId ?? null,
          last_error: null,
        });
        continue;
      }

      if (result.deviceUnregistered) {
        // The OS told Expo this address is dead (app uninstalled, or notifications
        // revoked). Retiring the device stops every future notification queuing a
        // delivery that can only fail, and the row is 'skipped' not 'failed'
        // because nothing went wrong on our side.
        await this.disableDevice(context.deviceId);
        await this.finish(context.id, {
          status: 'skipped',
          last_error: 'DeviceNotRegistered',
        });
        continue;
      }

      const exhausted = !result.retryable || context.attempts >= this.maxAttempts;
      await this.finish(context.id, {
        status: exhausted ? 'failed' : 'queued',
        // Releasing the lease hands a retryable row straight back to the next tick.
        locked_until: exhausted ? undefined : null,
        last_error: (result.errorCode ?? result.error ?? 'push failed').slice(0, 500),
      });
      this.logger.warn(
        `push delivery ${context.id} (notification ${rows[i]?.notification_id}) ` +
          `${exhausted ? 'failed permanently' : 'will retry'}: ${result.errorCode ?? result.error}`,
      );
    }
  }

  /**
   * Join each claimed row to its device and notification content. Two batched
   * queries, never one per row.
   */
  private async resolve(rows: DueRow[]): Promise<DeliveryContext[]> {
    const deviceIds = [...new Set(rows.map((r) => r.user_device_id))];
    const notificationIds = [...new Set(rows.map((r) => r.notification_id))];

    const [devices, notifications] = await Promise.all([
      this.admin
        .schema('comms')
        .from('user_devices')
        .select('id,push_token,enabled')
        .in('id', deviceIds)
        .returns<Array<{ id: string; push_token: string | null; enabled: boolean }>>(),
      this.admin
        .schema('comms')
        .from('notifications')
        .select('id,type,title,body,entity_type,entity_id,action_path')
        .in('id', notificationIds)
        .returns<
          Array<{
            id: string;
            type: string;
            title: string;
            body: string;
            entity_type: string | null;
            entity_id: string | null;
            action_path: string | null;
          }>
        >(),
    ]);

    if (devices.error || notifications.error) {
      throw new Error(
        `resolve push batch failed: ${devices.error?.message ?? notifications.error?.message}`,
      );
    }

    const deviceById = new Map((devices.data ?? []).map((d) => [d.id, d]));
    const notificationById = new Map((notifications.data ?? []).map((n) => [n.id, n]));

    const contexts: DeliveryContext[] = [];
    for (const row of rows) {
      const device = deviceById.get(row.user_device_id);
      const notification = notificationById.get(row.notification_id);

      if (!device || !device.enabled || !device.push_token) {
        await this.finish(row.id, {
          status: 'skipped',
          last_error: 'device disabled or has no token at send time',
        });
        continue;
      }
      if (!notification) {
        await this.finish(row.id, { status: 'skipped', last_error: 'notification no longer exists' });
        continue;
      }

      contexts.push({
        id: row.id,
        attempts: row.attempts + 1,
        deviceId: device.id,
        token: device.push_token,
        // Title and body are reused verbatim from the persisted notification, which
        // is what makes the lock-screen content identical to the in-app content and
        // subject to the same minimisation rule. Nothing extra is composed here.
        title: notification.title,
        body: notification.body,
        data: {
          notificationId: notification.id,
          type: notification.type,
          ...(notification.entity_type ? { entityType: notification.entity_type } : {}),
          ...(notification.entity_id ? { entityId: notification.entity_id } : {}),
          ...(notification.action_path ? { actionPath: notification.action_path } : {}),
        },
      });
    }
    return contexts;
  }

  private async disableDevice(deviceId: string): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('user_devices')
      .update({ enabled: false, push_token: null })
      .eq('id', deviceId);
    if (error) {
      this.logger.error(`disable unregistered device ${deviceId} failed: ${error.message}`);
      return;
    }
    this.logger.log(`disabled device ${deviceId}: provider reported DeviceNotRegistered`);
  }

  private async finish(
    id: string,
    patch: {
      status: string;
      sent_at?: string;
      provider_receipt_id?: string | null;
      last_error?: string | null;
      locked_until?: string | null;
    },
  ): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('push_deliveries')
      .update(patch)
      .eq('id', id);
    if (error) {
      this.logger.error(`record push delivery ${id} outcome failed: ${error.message}`);
    }
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
