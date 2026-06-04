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
import { BookingNotificationService } from './booking-notification.service';
import { resolveChannelPlan, smsAllowedByPlan, type ChannelPlan, type DeliveryChannel } from './channel-policy';
import { CommunicationSettingsService } from './communication-settings.service';
import { NotificationEventKey, REMINDER_EVENT_KEYS, SMS_CHANNEL, WHATSAPP_CHANNEL } from './notification.types';
import { isReminderStale } from './reminder-schedule';
import {
  buildContentVariables,
  renderNotification,
  type NotificationContext,
  type RenderedMessage,
} from './notification.templates';
import { normalizeE164, toWhatsAppAddress } from './phone';
import { WhatsAppService } from './whatsapp.service';
import { SmsService } from './sms.service';
import { WhatsAppTemplateConfig } from './whatsapp-template.config';

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

/**
 * Background poller that delivers due `comms.notification_events` over WhatsApp (primary) and SMS
 * (fallback).
 *
 * Robustness model (no external queue/cron dependency):
 *  - Concurrency / restart safety: each tick claims events with an atomic `status='queued'` +
 *    `locked_until` guarded UPDATE, so only one worker (or tick) owns an event at a time.
 *  - Idempotency: an event transitions queued → sent exactly once; the partial unique index
 *    (appointment_id, event_key, channel) prevents duplicate events — including duplicate SMS
 *    fallbacks for the same failed WhatsApp notification.
 *  - Stale protection: cancelled/no-show or rescheduled (start time moved) appointments cancel the
 *    event instead of sending.
 *  - Channel policy: WhatsApp is attempted first. SMS fallback is enqueued only when WhatsApp is
 *    clearly ineligible/unavailable (sync) or has a real failure — never while WhatsApp is merely
 *    pending. A "sent" (accepted-but-undelivered) WhatsApp message does NOT trigger SMS here; the
 *    async status callback enqueues the fallback if Twilio later reports failed/undelivered.
 *  - Retries: transient failures requeue with backoff up to `maxAttempts`, then terminate as
 *    `failed` (and, for WhatsApp, enqueue the SMS fallback). Delivery is never faked.
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
  private static readonly EVENT_COLUMNS =
    'id,business_id,location_id,client_profile_id,appointment_id,channel,event_key,status,scheduled_for,attempts,message_log_id,payload_json';

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly whatsapp: WhatsAppService,
    private readonly sms: SmsService,
    private readonly templates: WhatsAppTemplateConfig,
    private readonly settingsService: CommunicationSettingsService,
    private readonly booking: BookingNotificationService,
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
    if (!this.whatsapp.isEnabled && !this.sms.isEnabled) return; // log-only mode — don't churn the queue
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
      .select(NotificationDispatchService.EVENT_COLUMNS)
      .eq('status', 'queued')
      .in('channel', [WHATSAPP_CHANNEL, SMS_CHANNEL])
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
      .select(NotificationDispatchService.EVENT_COLUMNS)
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

    // Scheduling correction (cancelled/no-show/rescheduled/passed) → cancel silently for ANY channel.
    if (this.isSchedulingCancelled(event, context)) {
      await this.cancelEvent(event.id);
      return;
    }

    const settings = await this.settingsService.getForLocation(event.business_id, event.location_id);
    const phoneValid = Boolean(normalizeE164(context.clientPhone));
    const plan = resolveChannelPlan(settings, context.communicationPreference, phoneValid);

    if (event.channel === WHATSAPP_CHANNEL) return this.processWhatsApp(event, context, plan);
    if (event.channel === SMS_CHANNEL) return this.processSms(event, context, plan);
    await this.cancelEvent(event.id); // unknown channel
  }

  /** Cancellation/reschedule/passed checks that apply to every channel. */
  private isSchedulingCancelled(event: DueEventRow, context: AppointmentNotificationContext): boolean {
    if (INACTIVE_APPOINTMENT_STATUSES.has(context.appointment.status)) return true;
    if (REMINDER_EVENT_KEYS.has(event.event_key)) {
      if (isReminderStale(event.payload_json?.['appointment_start'], context.appointment.scheduled_start_at)) {
        return true;
      }
      if (new Date(context.appointment.scheduled_start_at).getTime() <= Date.now()) return true;
    }
    return false;
  }

  private async processWhatsApp(
    event: DueEventRow,
    context: AppointmentNotificationContext,
    plan: ChannelPlan,
  ): Promise<void> {
    const whatsappViable = this.whatsapp.isEnabled && plan.deliverable && plan.primary === WHATSAPP_CHANNEL;
    if (!whatsappViable) {
      const reason = this.whatsappUnavailableReason(plan);
      // WhatsApp ineligible/unavailable now. Fall back to SMS if the policy allows it; else skip truthfully.
      if (smsAllowedByPlan(plan) && this.sms.isEnabled) {
        await this.logSkippedAttempt(event, context, WHATSAPP_CHANNEL, `${reason}; falling back to SMS`);
        await this.booking.enqueueSmsFallbackSafe(event.appointment_id!, event.event_key, reason);
        await this.cancelEvent(event.id);
      } else {
        await this.skipEvent(event, context, WHATSAPP_CHANNEL, reason);
      }
      return;
    }

    const eventKey = event.event_key as NotificationEventKey;
    const renderCtx = this.renderContext(context);
    const message = renderNotification(eventKey, renderCtx);
    const contentSid = this.templates.contentSidFor(eventKey);
    const contentVariables = buildContentVariables(renderCtx);

    const logId = await this.ensureMessageLog(event, context, WHATSAPP_CHANNEL, message, contentSid, contentVariables);
    const result = await this.whatsapp.send({
      to: context.clientPhone!,
      contentSid,
      contentVariables,
      body: message.body,
      statusCallback: this.templates.statusCallbackUrl,
    });

    if (result.accepted) {
      await this.markAccepted(event, logId, this.whatsapp.provider, result.providerMessageId, result.providerStatus);
    } else {
      // A real send failure. Retry; on terminal failure fall back to SMS (if allowed).
      await this.markFailed(event, logId, result.error ?? 'WhatsApp send failed', plan);
    }
  }

  private async processSms(
    event: DueEventRow,
    context: AppointmentNotificationContext,
    plan: ChannelPlan,
  ): Promise<void> {
    const smsViable = this.sms.isEnabled && smsAllowedByPlan(plan);
    if (!smsViable) {
      const reason = !this.sms.isEnabled
        ? 'SMS sender not configured'
        : plan.deliverable
          ? 'SMS is not an eligible channel for this client'
          : plan.skipReason;
      await this.skipEvent(event, context, SMS_CHANNEL, reason);
      return;
    }

    const eventKey = event.event_key as NotificationEventKey;
    const renderCtx = this.renderContext(context);
    const message = renderNotification(eventKey, renderCtx);

    const logId = await this.ensureMessageLog(event, context, SMS_CHANNEL, message, undefined, buildContentVariables(renderCtx));
    const result = await this.sms.send({
      to: context.clientPhone!,
      body: message.body,
      statusCallback: this.templates.statusCallbackUrl,
    });

    if (result.accepted) {
      await this.markAccepted(event, logId, this.sms.provider, result.providerMessageId, result.providerStatus);
    } else {
      // SMS is the last channel — no further fallback.
      await this.markFailed(event, logId, result.error ?? 'SMS send failed');
    }
  }

  private whatsappUnavailableReason(plan: ChannelPlan): string {
    if (!this.whatsapp.isEnabled) return 'WhatsApp sender not configured';
    if (!plan.deliverable) return plan.skipReason;
    return 'WhatsApp is not the eligible channel for this client';
  }

  private renderContext(context: AppointmentNotificationContext): NotificationContext {
    return {
      clientFirstName: context.clientFirstName,
      locationName: context.locationName,
      timezone: context.timezone,
      scheduledStartAt: context.appointment.scheduled_start_at,
      serviceNames: context.serviceNames,
      stylistName: context.stylistName,
    };
  }

  private recipientFor(channel: DeliveryChannel, phone: string | null | undefined): string | null {
    if (channel === WHATSAPP_CHANNEL) return toWhatsAppAddress(phone) ?? phone ?? null;
    return normalizeE164(phone) ?? phone ?? null;
  }

  /** Find the existing message log for retries, or create one in `queued` state. */
  private async ensureMessageLog(
    event: DueEventRow,
    context: AppointmentNotificationContext,
    channel: DeliveryChannel,
    message: RenderedMessage,
    contentSid: string | undefined,
    contentVariables: Record<string, string>,
  ): Promise<string | null> {
    if (event.message_log_id) return event.message_log_id;

    const payload = event.payload_json ?? {};
    const provider = channel === WHATSAPP_CHANNEL ? this.whatsapp.provider : this.sms.provider;

    const { data, error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .insert({
        business_id: event.business_id,
        location_id: event.location_id,
        client_profile_id: event.client_profile_id,
        notification_event_id: event.id,
        appointment_id: event.appointment_id,
        channel,
        direction: 'outbound',
        provider,
        delivery_status: 'queued',
        message_type: event.event_key,
        // Template reference: the approved Content SID when configured (WhatsApp), else the event key.
        template_key: contentSid ?? event.event_key,
        recipient: this.recipientFor(channel, context.clientPhone),
        content_preview: message.preview,
        scheduled_for: event.scheduled_for,
        metadata: {
          primary_intended_channel: (payload['primary_channel'] as string) ?? channel,
          fallback: payload['fallback'] === true,
          ...(payload['fallback_reason'] ? { fallback_reason: payload['fallback_reason'] } : {}),
        },
        payload_snapshot: {
          content_sid: contentSid ?? null,
          content_variables: contentVariables,
          fallback_body: contentSid ? undefined : message.body,
          ...payload,
        },
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

  /**
   * Twilio *accepted* the message. The log moves to `sent` (NOT `delivered`) — the status webhook
   * advances it to delivered/failed/undelivered/read once Twilio reports the real outcome. We never
   * count an accepted message as delivered.
   */
  private async markAccepted(
    event: DueEventRow,
    logId: string | null,
    provider: string,
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
          provider,
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

  /**
   * Recipient/channel was ineligible. Record a truthful `skipped` message log (with the reason) and
   * retire the event — never fake a send.
   */
  private async skipEvent(
    event: DueEventRow,
    context: AppointmentNotificationContext,
    channel: DeliveryChannel,
    reason: string,
  ): Promise<void> {
    if (!event.message_log_id) await this.logSkippedAttempt(event, context, channel, reason);
    await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'cancelled', last_error_message: `skipped: ${reason}`.slice(0, 500), locked_until: null })
      .eq('id', event.id);
    this.logger.log(`event ${event.id} (${channel}) skipped (not delivered): ${reason}`);
  }

  /** Insert a truthful `skipped` message-log row for one channel attempt (keeps CRM history honest). */
  private async logSkippedAttempt(
    event: DueEventRow,
    context: AppointmentNotificationContext,
    channel: DeliveryChannel,
    reason: string,
  ): Promise<void> {
    const provider = channel === WHATSAPP_CHANNEL ? this.whatsapp.provider : this.sms.provider;
    const { error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .insert({
        business_id: event.business_id,
        location_id: event.location_id,
        client_profile_id: event.client_profile_id,
        notification_event_id: event.id,
        appointment_id: event.appointment_id,
        channel,
        direction: 'outbound',
        provider,
        delivery_status: 'skipped',
        message_type: event.event_key,
        template_key: event.event_key,
        recipient: this.recipientFor(channel, context.clientPhone),
        content_preview: `Skipped (${channel}): ${reason}`,
        error_message: reason,
        scheduled_for: event.scheduled_for,
        metadata: {
          skipped: true,
          channel,
          reason,
          primary_intended_channel: (event.payload_json?.['primary_channel'] as string) ?? channel,
        },
        payload_snapshot: { skipped: true, reason, ...(event.payload_json ?? {}) },
      });
    if (error) this.logger.error(`skip log for event ${event.id} failed: ${error.message}`);
  }

  /**
   * A real send failure. Records the failure on the log and requeues with backoff up to maxAttempts.
   * On terminal failure for a WhatsApp event, enqueues the SMS fallback (when policy allows it).
   */
  private async markFailed(
    event: DueEventRow,
    logId: string | null,
    errorMessage: string,
    whatsappFallbackPlan?: ChannelPlan,
  ): Promise<void> {
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

      // WhatsApp had a real, persistent failure → fall back to SMS (idempotent enqueue).
      if (
        whatsappFallbackPlan &&
        event.appointment_id &&
        this.sms.isEnabled &&
        smsAllowedByPlan(whatsappFallbackPlan)
      ) {
        await this.booking.enqueueSmsFallbackSafe(
          event.appointment_id,
          event.event_key,
          `WhatsApp delivery failed: ${errorMessage.slice(0, 160)}`,
        );
      }
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
