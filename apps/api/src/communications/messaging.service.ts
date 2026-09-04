import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CommunicationPreference } from '@sheer/domain';
import { CommunicationSettingsService } from './communication-settings.service';
import { resolveChannelPlan, type ChannelPlan, type DeliveryChannel } from './channel-policy';
import { WhatsAppTemplateConfig } from './whatsapp-template.config';
import {
  NOTIFICATION_EVENT_COLUMNS,
  type MessageClass,
  type NotificationEventRow,
  type NotificationSubject,
  type SnapshotContent,
} from './notification-subject';
import { NotificationSubjectRegistry } from './notification-subject.registry';
import { OptOutService } from './opt-out.service';

/**
 * One message to one client. The caller says what to send and to whom; the messaging layer decides
 * the channel, the fallback chain and the timing.
 */
export interface SendMessageRequest {
  businessId: string;
  locationId: string;
  clientProfileId: string;
  /** Stable identifier written to `event_key` / `message_logs.message_type` (e.g. `campaign:winback`). */
  eventKey: string;
  /**
   * The message content, snapshotted onto the event. Required for client-addressed messages.
   * Omit for appointment-anchored messages — those render from the approved booking templates.
   */
  content?: SnapshotContent;
  /** `marketing` additionally requires `core.client_profiles.marketing_opt_in`. Defaults to transactional. */
  messageClass?: MessageClass;
  /** Idempotency key. A second send with the same key (per channel) is a no-op, not a duplicate message. */
  dedupeKey?: string;
  /** When to deliver. Defaults to now. */
  scheduledFor?: Date;
  /** Optional appointment anchor — makes this an appointment-subject message. */
  appointmentId?: string;
  /**
   * Narrow the delivery chain for this message — nothing more. Treated as an additional starting
   * point in the canonical WhatsApp → SMS → Email order: the message starts at whichever of this
   * and the client's own stored preference sits FURTHER DOWN the chain.
   *
   * A campaign configured "email only" therefore reaches an email-preferring client on email and a
   * WhatsApp-preferring client on email, while a campaign configured "WhatsApp" can never drag an
   * email-preferring client back up to WhatsApp. Callers cannot widen a chain, reorder it, or skip
   * a channel in the middle of it — WhatsApp-first stays canonical and stays here.
   *
   * Snapshotted onto the event, so every fallback the dispatcher later queues honours it too.
   */
  channelPreference?: CommunicationPreference;
  /** Extra fields recorded on the event payload for audit. */
  metadata?: Record<string, unknown>;
}

export type SendMessageResult =
  | { status: 'queued'; eventId: string | null; channel: DeliveryChannel }
  | { status: 'duplicate'; channel: DeliveryChannel }
  | { status: 'skipped'; reason: string };

/** A queue write on an already-decided channel — used by the reminder scheduler and by escalation. */
export interface EnqueueOnChannelRequest {
  businessId: string;
  locationId: string;
  clientProfileId: string | null;
  appointmentId: string | null;
  channel: DeliveryChannel;
  eventKey: string;
  scheduledFor: Date;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  /**
   * The first event of this message's fallback chain (0108). Set by
   * NotificationEscalationService when it queues the next channel; omitted for
   * an originating send, which is its own root.
   *
   * This is what keeps a message with neither a dedupe key nor an appointment
   * anchored to ONE logical identity across the chain, so it costs one unit
   * rather than one per hop.
   */
  rootEventId?: string | null;
}

export type EnqueueOutcome =
  | { status: 'queued'; eventId: string | null }
  | { status: 'duplicate' };

/**
 * The single send API (Wrike #4507284095).
 *
 * Every outbound client message — booking confirmations, reminders, rebooking nudges, campaigns and
 * client-intelligence alerts — is queued through this service, and nothing else writes to
 * `comms.notification_events`. That is what makes the abstraction real rather than nominal: channel
 * policy, marketing consent and opt-out are applied in one place, on one code path, so a campaign
 * cannot accidentally acquire different rules from a reminder.
 *
 * `send` is asynchronous by design. It hands the message to the durable dispatcher and returns the
 * chosen primary channel; it does not block on the provider. Delivery outcome — including the
 * WhatsApp → SMS → Email fallback — is recorded against `comms.message_logs` as it happens.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly subjects: NotificationSubjectRegistry,
    private readonly settingsService: CommunicationSettingsService,
    private readonly optOuts: OptOutService,
    private readonly whatsappTemplates: WhatsAppTemplateConfig,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Queue one message. Resolves the WhatsApp → SMS → Email chain for this client and this location,
   * queues the message on the first eligible channel, and lets the dispatcher walk the rest of the
   * chain only if that channel actually fails.
   *
   * Returns `skipped` (with a reason) rather than throwing when the message should not be sent —
   * no eligible channel, consent withdrawn, every channel opted out. Callers treat that as a normal
   * outcome; it is recorded truthfully rather than being retried forever.
   */
  async send(request: SendMessageRequest): Promise<SendMessageResult> {
    if (!request.appointmentId && !request.content?.body?.trim()) {
      throw new Error('send requires content.body for a message that is not anchored to an appointment');
    }

    const now = new Date();
    const messageClass: MessageClass = request.messageClass ?? 'transactional';
    const payload = this.buildPayload(request, messageClass, now);

    const subject = await this.subjects.resolve(this.provisionalEvent(request, payload));
    if (!subject) return { status: 'skipped', reason: 'message subject could not be resolved' };

    const blocked = await subject.precheck(now, 'enqueue');
    if (blocked) return { status: 'skipped', reason: blocked.reason };

    const plan = await this.resolvePlan(subject, request.eventKey);
    if (!plan.deliverable) return { status: 'skipped', reason: plan.skipReason };

    const outcome = await this.enqueueOnChannel({
      businessId: request.businessId,
      locationId: request.locationId,
      clientProfileId: request.clientProfileId,
      appointmentId: request.appointmentId ?? null,
      channel: plan.primary,
      eventKey: request.eventKey,
      scheduledFor: request.scheduledFor ?? now,
      payload: { ...payload, ...subject.payloadSnapshot(), channel: plan.primary },
      dedupeKey: request.dedupeKey ?? null,
    });

    if (outcome.status === 'duplicate') return { status: 'duplicate', channel: plan.primary };
    return { status: 'queued', eventId: outcome.eventId, channel: plan.primary };
  }

  /**
   * Write one event on a channel the caller has already chosen. Used by the reminder scheduler
   * (which resolves the plan once and reuses it across a whole reminder set) and by escalation
   * (which is queueing the specific next channel in the chain). Duplicate keys are the idempotent
   * outcome, not an error.
   */
  async enqueueOnChannel(request: EnqueueOnChannelRequest): Promise<EnqueueOutcome> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .insert({
        business_id: request.businessId,
        location_id: request.locationId,
        client_profile_id: request.clientProfileId,
        appointment_id: request.appointmentId,
        channel: request.channel,
        event_key: request.eventKey,
        status: 'queued',
        scheduled_for: request.scheduledFor.toISOString(),
        payload_json: request.payload,
        ...(request.dedupeKey ? { dedupe_key: request.dedupeKey } : {}),
        ...(request.rootEventId ? { root_event_id: request.rootEventId } : {}),
      })
      .select('id')
      .maybeSingle<{ id: string }>();

    if (error) {
      // The partial unique indexes — (appointment_id, event_key, channel) for booking events,
      // (business_id, dedupe_key, channel) for everything else — reject a duplicate. That is the
      // desired idempotent outcome, not a failure.
      if (isUniqueViolation(error)) return { status: 'duplicate' };
      throw new Error(`insert notification_event failed: ${error.message}`);
    }
    return { status: 'queued', eventId: data?.id ?? null };
  }

  /**
   * The delivery chain for a subject: location settings + client preference + contact validity, with
   * the client's recorded opt-outs removed. The one place opt-out enters channel selection, so
   * reminders, nudges, campaigns and fallbacks all honour it identically.
   */
  async resolvePlan(subject: NotificationSubject, eventKey?: string): Promise<ChannelPlan> {
    const settings = await this.settingsService.getForLocation(subject.businessId, subject.locationId);
    const optOuts = await this.optOuts.channelsFor(subject.businessId, subject.clientProfileId);

    // Consent is not something to assume when it could not be checked. A transactional reminder
    // still goes out on a degraded read; a marketing message is withheld.
    if (optOuts.degraded && subject.messageClass === 'marketing') {
      return { deliverable: false, skipReason: 'could not confirm messaging opt-outs; marketing message withheld' };
    }

    return resolveChannelPlan(settings, subject.preference, {
      ...subject.contact(),
      optedOutChannels: optOuts.channels,
      unsupportedChannels: this.unsupportedChannelsFor(subject, eventKey),
    });
  }

  /**
   * Channels that cannot carry THIS message as a matter of provider capability.
   *
   * PROACTIVE WHATSAPP MARKETING NEEDS AN APPROVED TEMPLATE. A business-initiated
   * WhatsApp message outside an open conversation window is only accepted
   * against one, so sending free-form would be rejected by the provider — and
   * deliberately attempting it is not something to do on purpose. With no
   * approved template configured for the event, WhatsApp is simply not a
   * capable channel for it, and the canonical WhatsApp → SMS → Email chain
   * falls through to the next permitted one on its own.
   *
   * Transactional messages are untouched: they render from the approved booking
   * templates already, and a reminder must not stop going out because a
   * marketing template is missing.
   */
  private unsupportedChannelsFor(
    subject: NotificationSubject,
    eventKey?: string,
  ): DeliveryChannel[] {
    if (subject.messageClass !== 'marketing') return [];
    if (!eventKey) return ['whatsapp'];
    return this.whatsappTemplates.contentSidFor(eventKey) ? [] : ['whatsapp'];
  }

  /**
   * The attempt on this event's channel is over and a successor is queued. `fallback_pending` says
   * exactly that: not delivered, not terminally failed, still in flight one channel down. The failed
   * attempt's own `comms.message_logs` row keeps its truthful `failed`/`skipped` state.
   */
  async markFallbackPending(eventId: string, reason: string): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .update({
        status: 'fallback_pending',
        last_error_message: reason.slice(0, 500),
        locked_until: null,
      })
      .eq('id', eventId);
    if (error) this.logger.error(`mark event ${eventId} fallback_pending failed: ${error.message}`);
  }

  /** Load one queued event by id (used by the escalation path). */
  async findEvent(eventId: string): Promise<NotificationEventRow | null> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .select(NOTIFICATION_EVENT_COLUMNS)
      .eq('id', eventId)
      .maybeSingle<NotificationEventRow>();
    if (error) {
      this.logger.error(`load notification_event ${eventId} failed: ${error.message}`);
      return null;
    }
    return data ?? null;
  }

  private buildPayload(
    request: SendMessageRequest,
    messageClass: MessageClass,
    now: Date,
  ): Record<string, unknown> {
    return {
      ...(request.metadata ?? {}),
      event_key: request.eventKey,
      message_class: messageClass,
      generated_at: now.toISOString(),
      ...(request.channelPreference ? { channel_preference: request.channelPreference } : {}),
      ...(request.content ? { content: request.content } : {}),
    };
  }

  /**
   * A stand-in event row so the subject can be resolved (and its consent/eligibility rules applied)
   * *before* anything is written to the queue. It carries the same payload the real row will.
   */
  private provisionalEvent(
    request: SendMessageRequest,
    payload: Record<string, unknown>,
  ): NotificationEventRow {
    return {
      id: 'pending',
      business_id: request.businessId,
      location_id: request.locationId,
      client_profile_id: request.clientProfileId,
      appointment_id: request.appointmentId ?? null,
      channel: 'whatsapp',
      event_key: request.eventKey,
      status: 'queued',
      scheduled_for: (request.scheduledFor ?? new Date()).toISOString(),
      attempts: 0,
      message_log_id: null,
      payload_json: payload,
      dedupe_key: request.dedupeKey ?? null,
    };
  }
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key value/i.test(error.message ?? '');
}
