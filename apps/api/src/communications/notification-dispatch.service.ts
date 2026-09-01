import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  channelAllowedByPlan,
  type ChannelPlan,
  type DeliveryChannel,
} from './channel-policy';
import { MessagingService } from './messaging.service';
import { NotificationEscalationService } from './notification-escalation.service';
import { EMAIL_CHANNEL, SMS_CHANNEL, WHATSAPP_CHANNEL } from './notification.types';
import { MESSAGE_CAP_REACHED_REASON } from '@sheer/domain';
import { MessageUsageService } from '../message-usage/message-usage.service';
import {
  NOTIFICATION_EVENT_COLUMNS,
  readMessageClass,
  type NotificationEventRow,
  type NotificationSubject,
  type RenderedChannelMessage,
} from './notification-subject';
import { NotificationSubjectRegistry } from './notification-subject.registry';
import { normalizeE164, toWhatsAppAddress } from './phone';
import { MessageProviderRegistry } from './providers/message-provider.registry';
import { WhatsAppTemplateConfig } from './whatsapp-template.config';

const DELIVERY_CHANNELS: DeliveryChannel[] = [WHATSAPP_CHANNEL, SMS_CHANNEL, EMAIL_CHANNEL];

/**
 * Background poller that delivers due `comms.notification_events` over the WhatsApp → SMS → Email
 * chain.
 *
 * What a message is *about* is resolved through {@link NotificationSubjectRegistry}, so the same
 * queue, retry, logging and fallback machinery serves booking notifications, rebooking nudges and
 * campaigns alike. The dispatcher itself knows nothing about appointments, campaigns or providers.
 *
 * Robustness model (no external queue/cron dependency):
 *  - Concurrency / restart safety: each tick claims events with an atomic `status='queued'` +
 *    `locked_until` guarded UPDATE, so only one worker (or tick) owns an event at a time.
 *  - Idempotency: an event transitions queued → sent exactly once; the partial unique indexes
 *    prevent duplicate events — including duplicate fallbacks for the same failed notification.
 *  - Stale protection: the subject's send-time precheck (cancelled/rescheduled appointment, client
 *    already rebooked, marketing consent withdrawn) cancels the event instead of sending.
 *  - Channel policy: the primary channel is attempted first. A fallback (the next channel in the
 *    WhatsApp → SMS → Email chain) is enqueued only when the current channel is clearly
 *    ineligible/unavailable (sync) or has a real failure — never while it is merely pending. A
 *    "sent" (accepted-but-undelivered) message does NOT trigger a fallback here; the async status
 *    callback (Twilio) or bounce webhook (Resend) enqueues the fallback if the provider later
 *    reports a real failure.
 *  - Catch-up: each tick drains the due backlog in batches (bounded by `maxDrainBatches`) so reminders
 *    queued during downtime fire promptly on the next tick rather than one batch per interval.
 *  - Retries: transient failures requeue with backoff up to `maxAttempts`, then terminate as
 *    `failed` (and escalate to the next channel in the chain). Delivery is never faked.
 *  - Delivery state: an event that has handed over to a fallback is recorded as `fallback_pending`,
 *    distinguishing "this attempt is over but the message is still in flight" from a terminal
 *    `failed`/`cancelled`. The failed attempt's own `comms.message_logs` row stays `failed`/`skipped`.
 */
@Injectable()
export class NotificationDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDispatchService.name);
  private readonly admin: SupabaseClient;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly maxDrainBatches: number;
  private static readonly LOCK_TTL_MS = 5 * 60 * 1000;
  private static readonly RETRY_BACKOFF_MS = 5 * 60 * 1000;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly providers: MessageProviderRegistry,
    private readonly templates: WhatsAppTemplateConfig,
    private readonly subjects: NotificationSubjectRegistry,
    private readonly messaging: MessagingService,
    private readonly escalation: NotificationEscalationService,
    private readonly messageUsage: MessageUsageService,
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
    // How many full batches a single tick may drain before yielding to the next interval. Lets a
    // backlog accumulated during downtime clear quickly without starving the event loop.
    this.maxDrainBatches = clampInt(config.get('COMMS_DISPATCH_MAX_DRAIN_BATCHES'), 20, 1, 1_000);
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

  /** Drain the due-event backlog (in bounded batches). Public so it can be triggered/tested directly. */
  async tick(): Promise<void> {
    if (this.running) return; // prevent overlapping ticks
    // log-only mode for every channel — don't churn the queue
    if (!this.providers.anyEnabled) return;
    this.running = true;
    try {
      // Keep processing full batches so a backlog (e.g. accumulated during downtime, or lazy
      // fallback events queued earlier in this same drain) is cleared promptly rather than one
      // batch per interval. Bounded by maxDrainBatches to avoid monopolising the event loop.
      for (let pass = 0; pass < this.maxDrainBatches; pass++) {
        const due = await this.fetchDueCandidates();
        if (due.length === 0) break;
        let processed = 0;
        for (const candidate of due) {
          const claimed = await this.claim(candidate);
          if (claimed) {
            await this.process(claimed);
            processed++;
          }
        }
        // Nothing claimable (all locked by another worker/tick) or the queue is drained → stop.
        if (processed === 0 || due.length < this.batchSize) break;
      }
    } catch (err) {
      this.logger.error(`dispatch tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async fetchDueCandidates(): Promise<NotificationEventRow[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .select(NOTIFICATION_EVENT_COLUMNS)
      .eq('status', 'queued')
      .in('channel', DELIVERY_CHANNELS)
      .lte('scheduled_for', nowIso)
      .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
      .order('scheduled_for', { ascending: true })
      .limit(this.batchSize)
      .returns<NotificationEventRow[]>();

    if (error) throw new Error(`fetch due events failed: ${error.message}`);
    return data ?? [];
  }

  /** Atomically take ownership of an event. Returns the row only if this worker won the claim. */
  private async claim(candidate: NotificationEventRow): Promise<NotificationEventRow | null> {
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
      .select(NOTIFICATION_EVENT_COLUMNS)
      .returns<NotificationEventRow[]>();

    if (error) {
      this.logger.error(`claim event ${candidate.id} failed: ${error.message}`);
      return null;
    }
    return data && data.length === 1 ? data[0] : null;
  }

  private async process(event: NotificationEventRow): Promise<void> {
    const channel = event.channel as DeliveryChannel;
    if (!DELIVERY_CHANNELS.includes(channel)) {
      await this.cancelEvent(event.id); // unknown channel
      return;
    }

    // What is this message about? An appointment, a client, or nothing we can still identify.
    const subject = await this.subjects.resolve(event);
    if (!subject) {
      await this.cancelEvent(event.id);
      return;
    }

    // Send-time suppression: cancelled/rescheduled appointment, client already rebooked, marketing
    // consent withdrawn since the message was queued.
    const blocked = await subject.precheck(new Date(), 'dispatch');
    if (blocked) {
      if (blocked.logSkip) await this.logSkippedAttempt(event, subject, channel, blocked.reason);
      await this.cancelEvent(event.id);
      return;
    }

    const plan = await this.messaging.resolvePlan(subject);
    await this.attempt(event, subject, channel, plan);
  }

  /**
   * One delivery attempt on one channel. Identical for every channel and every kind of message —
   * the differences (approved template vs freeform, address form, email subject/HTML) come from the
   * subject's rendering and from the provider adapter, not from branching here.
   */
  private async attempt(
    event: NotificationEventRow,
    subject: NotificationSubject,
    channel: DeliveryChannel,
    plan: ChannelPlan,
  ): Promise<void> {
    const provider = this.providers.forChannel(channel);
    const viable = Boolean(provider?.isEnabled) && channelAllowedByPlan(plan, channel);
    if (!viable || !provider) {
      // Ineligible/unavailable now → escalate to the next channel in the chain, or skip truthfully.
      await this.escalateOrSkip(event, subject, channel, plan);
      return;
    }

    const recipient = this.recipientFor(channel, subject);
    if (!recipient) {
      await this.escalateOrSkip(event, subject, channel, plan);
      return;
    }

    const rendered = subject.render(channel);
    if (channel === WHATSAPP_CHANNEL && !rendered.templateId) {
      // No approved Content template → we can only send a freeform body, which WhatsApp rejects for
      // business-initiated messages outside the 24h session window. Make it loud so a missing
      // template SID in the running env is obvious rather than silent.
      this.logger.warn(
        `WhatsApp ${event.event_key} for event ${event.id} has no approved Content template configured; ` +
          'sending a freeform body (delivers only inside the 24h session window).',
      );
    }

    // ENFORCEMENT, before the provider is touched (Wrike 4507284256 §24/§38).
    // Only a `block_at_cap` plan ever refuses; the shipped default tracks and
    // records an overage instead, so a salon is never unexpectedly silenced. A
    // refusal is recorded with its own structured reason — never disguised as a
    // provider failure — and the originating booking/checkout is unaffected
    // because nothing upstream awaits this dispatcher at all.
    const capDecision = await this.messageUsage.checkCap(event.business_id, channel);
    if (!capDecision.allow) {
      await this.skipEvent(event, subject, channel, MESSAGE_CAP_REACHED_REASON);
      return;
    }

    const logId = await this.ensureMessageLog(event, subject, channel, rendered);
    const result = await provider.send({
      to: recipient,
      body: rendered.body,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      templateId: rendered.templateId,
      templateVariables: rendered.templateVariables,
      statusCallbackUrl: channel === EMAIL_CHANNEL ? undefined : this.templates.statusCallbackUrl,
      ...(channel === EMAIL_CHANNEL ? { tags: [{ name: 'type', value: event.event_key }] } : {}),
    });

    if (result.accepted) {
      // The provider *accepted* the message → `sent`, NOT `delivered`. The status webhook advances it
      // to delivered/failed/undelivered/read once the real outcome is known. An accepted message is
      // never counted as delivered, and never triggers a fallback.
      await this.markAccepted(event, logId, provider.providerName, result.providerMessageId, result.providerStatus);
    } else if (result.skipped) {
      // Sender lost its config between scheduling and dispatch → escalate to the next channel / skip.
      await this.escalateOrSkip(event, subject, channel, plan);
    } else {
      // A real send failure. Retry; on terminal failure escalate to the next channel in the chain.
      await this.markFailed(event, subject, logId, result.error ?? `${channel} send failed`, plan);
    }
  }

  /**
   * The current channel is ineligible/unavailable. Escalate to the next channel in the
   * WhatsApp → SMS → Email chain when there is one (recording a truthful `skipped` attempt for the
   * current channel first, so CRM history shows every attempt), otherwise record a terminal skip.
   * This is the synchronous-ineligibility counterpart of {@link markFailed}'s terminal escalation.
   */
  private async escalateOrSkip(
    event: NotificationEventRow,
    subject: NotificationSubject,
    channel: DeliveryChannel,
    plan: ChannelPlan,
  ): Promise<void> {
    const reason = this.channelUnavailableReason(channel, plan);
    const next = await this.escalation.escalateWithSubject(event, subject, plan, channel, reason);
    if (next) {
      // Escalation has already moved the event to `fallback_pending`; all that is owed here is a
      // truthful record of the attempt that could not be made.
      await this.logSkippedAttempt(event, subject, channel, `${reason}; falling back to ${next}`);
    } else {
      await this.skipEvent(event, subject, channel, reason);
    }
  }

  private channelUnavailableReason(channel: DeliveryChannel, plan: ChannelPlan): string {
    if (this.senderDisabled(channel)) return `${channel} sender not configured`;
    if (!plan.deliverable) return plan.skipReason;
    return `${channel} is not an eligible channel for this client`;
  }

  private senderDisabled(channel: DeliveryChannel): boolean {
    return !this.providers.isChannelEnabled(channel);
  }

  private recipientFor(channel: DeliveryChannel, subject: NotificationSubject): string | null {
    if (channel === EMAIL_CHANNEL) return subject.email ?? null;
    if (channel === WHATSAPP_CHANNEL) return toWhatsAppAddress(subject.phone) ?? subject.phone ?? null;
    return normalizeE164(subject.phone) ?? subject.phone ?? null;
  }

  private providerFor(channel: DeliveryChannel): string {
    return this.providers.providerName(channel) ?? 'unknown';
  }

  /** Find the existing message log for retries, or create one in `queued` state. */
  private async ensureMessageLog(
    event: NotificationEventRow,
    subject: NotificationSubject,
    channel: DeliveryChannel,
    rendered: RenderedChannelMessage,
  ): Promise<string | null> {
    if (event.message_log_id) return event.message_log_id;

    const payload = event.payload_json ?? {};
    const contentSid = rendered.templateId;

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
        provider: this.providerFor(channel),
        delivery_status: 'queued',
        message_type: event.event_key,
        // Template reference: the approved Content SID when configured (WhatsApp), else the event key.
        template_key: contentSid ?? event.event_key,
        recipient: this.recipientFor(channel, subject),
        content_preview: rendered.preview,
        scheduled_for: event.scheduled_for,
        metadata: {
          primary_intended_channel: (payload['primary_channel'] as string) ?? channel,
          fallback: payload['fallback'] === true,
          ...(payload['fallback_reason'] ? { fallback_reason: payload['fallback_reason'] } : {}),
          subject_kind: subject.kind,
          // For WhatsApp, record whether an approved Content template was used (vs a freeform body
          // fallback) so it is auditable per message in CRM history.
          ...(channel === WHATSAPP_CHANNEL ? { used_template: Boolean(contentSid) } : {}),
        },
        payload_snapshot: {
          content_sid: contentSid ?? null,
          content_variables: rendered.templateVariables,
          fallback_body: contentSid ? undefined : rendered.body,
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
   * The provider *accepted* the message. The log moves to `sent` (NOT `delivered`) — the status
   * webhook advances it to delivered/failed/undelivered/read once the real outcome is reported. We
   * never count an accepted message as delivered.
   */
  private async markAccepted(
    event: NotificationEventRow,
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

    // ACCOUNTING (Wrike 4507284256). This is the platform's single "a provider
    // accepted a client message" transition, so recording here is what makes the
    // allowance platform-wide: campaigns, confirmations, reminders and nudges all
    // pass through it without a line of caller-side code.
    //
    // Exactly once per LOGICAL message — the recorder keys on identity that is
    // stable across retries of this event AND across the WhatsApp → SMS → Email
    // fallback chain, so a message that failed over costs one unit, not two.
    //
    // Never throws: the message HAS been sent, and failing here must not make the
    // dispatcher re-send it. A failure is logged with the logical key and is
    // recoverable from `sent_at` via MessageUsageService.backfillUnrecordedSends.
    await this.messageUsage.recordSend({
      eventId: event.id,
      businessId: event.business_id,
      dedupeKey: event.dedupe_key,
      appointmentId: event.appointment_id,
      eventKey: event.event_key,
      channel: event.channel,
      messageClass: readMessageClass(event.payload_json),
    });
  }

  /**
   * Recipient/channel was ineligible and there is no further channel. Record a truthful `skipped`
   * message log (with the reason) and retire the event — never fake a send.
   */
  private async skipEvent(
    event: NotificationEventRow,
    subject: NotificationSubject,
    channel: DeliveryChannel,
    reason: string,
  ): Promise<void> {
    if (!event.message_log_id) await this.logSkippedAttempt(event, subject, channel, reason);
    await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'cancelled', last_error_message: `skipped: ${reason}`.slice(0, 500), locked_until: null })
      .eq('id', event.id);
    this.logger.log(`event ${event.id} (${channel}) skipped (not delivered): ${reason}`);
  }

  /** Insert a truthful `skipped` message-log row for one channel attempt (keeps CRM history honest). */
  private async logSkippedAttempt(
    event: NotificationEventRow,
    subject: NotificationSubject,
    channel: DeliveryChannel,
    reason: string,
  ): Promise<void> {
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
        provider: this.providerFor(channel),
        delivery_status: 'skipped',
        message_type: event.event_key,
        template_key: event.event_key,
        recipient: this.recipientFor(channel, subject),
        content_preview: `Skipped (${channel}): ${reason}`,
        error_message: reason,
        scheduled_for: event.scheduled_for,
        metadata: {
          skipped: true,
          channel,
          reason,
          subject_kind: subject.kind,
          primary_intended_channel: (event.payload_json?.['primary_channel'] as string) ?? channel,
        },
        payload_snapshot: { skipped: true, reason, ...(event.payload_json ?? {}) },
      });
    if (error) this.logger.error(`skip log for event ${event.id} failed: ${error.message}`);
  }

  /**
   * A real send failure. Records the failure on the log and requeues with backoff up to maxAttempts.
   * On terminal failure, escalates to the next channel in the WhatsApp → SMS → Email chain; the event
   * then reads `fallback_pending` when a successor was queued and `failed` when the chain is
   * exhausted.
   */
  private async markFailed(
    event: NotificationEventRow,
    subject: NotificationSubject,
    logId: string | null,
    errorMessage: string,
    plan: ChannelPlan,
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

    if (!terminal) {
      // Requeue with backoff so we don't hammer the provider on the next tick.
      const retryLock = new Date(Date.now() + NotificationDispatchService.RETRY_BACKOFF_MS).toISOString();
      await this.admin
        .schema('comms')
        .from('notification_events')
        .update({ status: 'queued', last_error_message: errorMessage.slice(0, 500), locked_until: retryLock })
        .eq('id', event.id);
      return;
    }

    this.logger.warn(
      `event ${event.id} (${event.channel}) failed permanently after ${event.attempts} attempts: ${errorMessage}`,
    );

    // Real, persistent failure → escalate to the next channel in the chain (idempotent enqueue).
    // Returns null when the failed channel is already last in the chain (e.g. email).
    const reason = `${event.channel} delivery failed: ${errorMessage.slice(0, 160)}`;
    const next = await this.escalation.escalateWithSubject(
      event,
      subject,
      plan,
      event.channel as DeliveryChannel,
      reason,
    );

    // A successful escalation has already moved the event to `fallback_pending`.
    if (next) return;
    await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'failed', last_error_message: errorMessage.slice(0, 500), locked_until: null })
      .eq('id', event.id);
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
