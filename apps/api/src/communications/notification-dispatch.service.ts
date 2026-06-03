import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  INACTIVE_APPOINTMENT_STATUSES,
  loadAppointmentContext,
  type AppointmentNotificationContext,
} from './appointment-context';
import { NotificationEventKey, WHATSAPP_CHANNEL } from './notification.types';
import { isReminderStale } from './reminder-schedule';
import { renderNotification, type RenderedMessage } from './notification.templates';
import { WhatsAppService } from './whatsapp.service';

interface DueEventRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string | null;
  appointment_id: string | null;
  channel: string;
  event_key: string;
  status: string;
  scheduled_for: string | null;
  attempts: number;
  message_log_id: string | null;
  payload_json: Record<string, unknown> | null;
}

const REMINDER_KEYS = new Set<string>([
  NotificationEventKey.Reminder24h,
  NotificationEventKey.Reminder48h,
  NotificationEventKey.Reminder1w,
]);

/**
 * Background poller that delivers due `comms.notification_events` over WhatsApp.
 *
 * Robustness model (no external queue/cron dependency):
 *  - Concurrency / restart safety: each tick claims events with an atomic
 *    `status='queued'` + `locked_until` guarded UPDATE, so only one worker (or tick)
 *    owns an event at a time; crashed locks expire after `LOCK_TTL_MS`.
 *  - Idempotency: an event transitions queued → sent exactly once; the partial unique
 *    index prevents duplicate events upstream.
 *  - Stale protection: before sending, the live appointment is re-validated — cancelled/
 *    no-show or rescheduled (start time changed) appointments cancel the event instead
 *    of sending.
 *  - Retries: failures requeue with a backoff up to `maxAttempts`, then terminate as
 *    `failed`. Delivery is never faked — the message log reflects the true outcome.
 */
@Injectable()
export class NotificationDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDispatchService.name);
  private readonly admin: SupabaseClient;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private static readonly LOCK_TTL_MS = 5 * 60 * 1000;
  private static readonly RETRY_BACKOFF_MS = 5 * 60 * 1000;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly whatsapp: WhatsAppService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    this.enabled = (config.get<string>('COMMS_DISPATCH_ENABLED') ?? 'true').toLowerCase() !== 'false';
    this.intervalMs = clampInt(config.get('COMMS_DISPATCH_INTERVAL_MS'), 60_000, 5_000, 3_600_000);
    this.batchSize = clampInt(config.get('COMMS_DISPATCH_BATCH_SIZE'), 25, 1, 200);
    this.maxAttempts = clampInt(config.get('COMMS_DISPATCH_MAX_ATTEMPTS'), 3, 1, 10);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Notification dispatch is disabled (COMMS_DISPATCH_ENABLED=false).');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(`Notification dispatch poller started (every ${this.intervalMs}ms).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process one batch of due events. Public so it can be triggered/tested directly. */
  async tick(): Promise<void> {
    if (this.running) return; // prevent overlapping ticks
    if (!this.whatsapp.isEnabled) return; // log-only mode — don't churn the queue
    this.running = true;
    try {
      const due = await this.fetchDueCandidates();
      for (const candidate of due) {
        const claimed = await this.claim(candidate);
        if (claimed) await this.process(claimed);
      }
    } catch (err) {
      this.logger.error(`dispatch tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async fetchDueCandidates(): Promise<DueEventRow[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .select(
        'id,business_id,location_id,client_profile_id,appointment_id,channel,event_key,status,scheduled_for,attempts,message_log_id,payload_json',
      )
      .eq('status', 'queued')
      .eq('channel', WHATSAPP_CHANNEL)
      .lte('scheduled_for', nowIso)
      .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
      .order('scheduled_for', { ascending: true })
      .limit(this.batchSize)
      .returns<DueEventRow[]>();

    if (error) throw new Error(`fetch due events failed: ${error.message}`);
    return data ?? [];
  }

  /** Atomically take ownership of an event. Returns the row only if this worker won the claim. */
  private async claim(candidate: DueEventRow): Promise<DueEventRow | null> {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + NotificationDispatchService.LOCK_TTL_MS).toISOString();
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .update({
        locked_until: lockUntil,
        processing_started_at: now.toISOString(),
        attempts: candidate.attempts + 1,
      })
      .eq('id', candidate.id)
      .eq('status', 'queued')
      .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
      .select(
        'id,business_id,location_id,client_profile_id,appointment_id,channel,event_key,status,scheduled_for,attempts,message_log_id,payload_json',
      )
      .returns<DueEventRow[]>();

    if (error) {
      this.logger.error(`claim event ${candidate.id} failed: ${error.message}`);
      return null;
    }
    return data && data.length === 1 ? data[0] : null;
  }

  private async process(event: DueEventRow): Promise<void> {
    if (!event.appointment_id) {
      await this.cancelEvent(event.id);
      return;
    }

    const context = await loadAppointmentContext(this.admin, event.appointment_id);
    if (!context) {
      await this.cancelEvent(event.id);
      return;
    }

    if (!this.isStillDeliverable(event, context)) {
      await this.cancelEvent(event.id);
      return;
    }

    const message = renderNotification(event.event_key as NotificationEventKey, {
      clientFirstName: context.clientFirstName,
      locationName: context.locationName,
      timezone: context.timezone,
      scheduledStartAt: context.appointment.scheduled_start_at,
      serviceNames: context.serviceNames,
      stylistName: context.stylistName,
    });

    const logId = await this.ensureMessageLog(event, context, message);
    const result = await this.whatsapp.send({ to: context.clientPhone!, body: message.body });

    if (result.delivered) {
      await this.markDelivered(event, logId, result.providerMessageId, result.providerStatus);
    } else {
      await this.markFailed(event, logId, result.error ?? 'WhatsApp send failed');
    }
  }

  /** Re-validate the live appointment against the event before sending. */
  private isStillDeliverable(event: DueEventRow, context: AppointmentNotificationContext): boolean {
    if (INACTIVE_APPOINTMENT_STATUSES.has(context.appointment.status)) return false;

    // Channel preference may have changed since scheduling, or the phone removed.
    if (context.communicationPreference !== WHATSAPP_CHANNEL || !context.clientPhone?.trim()) return false;

    if (REMINDER_KEYS.has(event.event_key)) {
      // Rescheduled appointment → the snapshot no longer matches; this reminder is stale.
      if (isReminderStale(event.payload_json?.['appointment_start'], context.appointment.scheduled_start_at)) {
        return false;
      }
      // Appointment already started/passed → a "before" reminder is pointless.
      if (new Date(context.appointment.scheduled_start_at).getTime() <= Date.now()) return false;
    }

    return true;
  }

  /** Find the existing message log for retries, or create one in `queued` state. */
  private async ensureMessageLog(
    event: DueEventRow,
    context: AppointmentNotificationContext,
    message: RenderedMessage,
  ): Promise<string | null> {
    if (event.message_log_id) return event.message_log_id;

    const { data, error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .insert({
        business_id: event.business_id,
        location_id: event.location_id,
        client_profile_id: event.client_profile_id,
        notification_event_id: event.id,
        appointment_id: event.appointment_id,
        channel: WHATSAPP_CHANNEL,
        provider: this.whatsapp.provider,
        delivery_status: 'queued',
        message_type: event.event_key,
        template_key: event.event_key,
        recipient: context.clientPhone ?? null,
        content_preview: message.preview,
        scheduled_for: event.scheduled_for,
        payload_snapshot: { body: message.body, ...(event.payload_json ?? {}) },
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !data) {
      this.logger.error(`create message_log for event ${event.id} failed: ${error?.message ?? 'no row'}`);
      return null;
    }

    await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ message_log_id: data.id })
      .eq('id', event.id);

    return data.id;
  }

  private async markDelivered(
    event: DueEventRow,
    logId: string | null,
    providerMessageId?: string,
    providerStatus?: string,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    if (logId) {
      await this.admin
        .schema('comms')
        .from('message_logs')
        .update({
          delivery_status: 'sent',
          provider: this.whatsapp.provider,
          provider_message_id: providerMessageId ?? null,
          provider_status: providerStatus ?? null,
          sent_at: nowIso,
          error_message: null,
        })
        .eq('id', logId);
    }
    await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'sent', sent_at: nowIso, locked_until: null })
      .eq('id', event.id);
  }

  private async markFailed(event: DueEventRow, logId: string | null, errorMessage: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const terminal = event.attempts >= this.maxAttempts;

    if (logId) {
      await this.admin
        .schema('comms')
        .from('message_logs')
        .update({
          delivery_status: 'failed',
          error_message: errorMessage.slice(0, 500),
          failed_at: nowIso,
        })
        .eq('id', logId);
    }

    if (terminal) {
      await this.admin
        .schema('comms')
        .from('notification_events')
        .update({ status: 'failed', last_error_message: errorMessage.slice(0, 500), locked_until: null })
        .eq('id', event.id);
      this.logger.warn(`event ${event.id} failed permanently after ${event.attempts} attempts: ${errorMessage}`);
    } else {
      // Requeue with backoff so we don't hammer the provider on the next tick.
      const retryLock = new Date(Date.now() + NotificationDispatchService.RETRY_BACKOFF_MS).toISOString();
      await this.admin
        .schema('comms')
        .from('notification_events')
        .update({ status: 'queued', last_error_message: errorMessage.slice(0, 500), locked_until: retryLock })
        .eq('id', event.id);
    }
  }

  private async cancelEvent(eventId: string): Promise<void> {
    await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'cancelled', locked_until: null })
      .eq('id', eventId);
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
