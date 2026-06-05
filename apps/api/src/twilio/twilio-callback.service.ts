import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BookingNotificationService } from '../communications/booking-notification.service';
import type { DeliveryChannel } from '../communications/channel-policy';
import { SMS_CHANNEL, WHATSAPP_CHANNEL } from '../communications/notification.types';
import { normalizeWhatsAppAddress, WhatsAppService } from '../communications/whatsapp.service';
import { isFailureStatus, mapTwilioStatus, shouldApplyStatus } from './twilio-status';

interface MessageLogRow {
  id: string;
  channel: string | null;
  message_type: string | null;
  delivery_status: string | null;
  notification_event_id: string | null;
  business_id: string;
  location_id: string;
  client_profile_id: string | null;
  appointment_id: string | null;
}

const LOG_COLUMNS =
  'id,channel,message_type,delivery_status,notification_event_id,business_id,location_id,client_profile_id,appointment_id';

/** Twilio status-callback form fields (application/x-www-form-urlencoded). */
export interface TwilioStatusCallback {
  MessageSid?: string;
  MessageStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

/** Twilio inbound-message form fields. */
export interface TwilioInboundMessage {
  MessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
}

/**
 * Applies Twilio delivery-status callbacks and inbound replies to `comms.message_logs`, keeping the
 * CRM message history truthful. Lookups are by provider message SID (indexed), so callbacks are
 * idempotent under replay; out-of-order callbacks never downgrade a more-advanced status.
 */
@Injectable()
export class TwilioCallbackService {
  private readonly logger = new Logger(TwilioCallbackService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly whatsapp: WhatsAppService,
    private readonly booking: BookingNotificationService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Verify an inbound Twilio webhook against the request's reconstructed and/or configured URL. */
  verifySignature(
    signature: string | undefined,
    candidateUrls: Array<string | undefined>,
    params: Record<string, string>,
  ): boolean {
    return this.whatsapp.verifyWebhookSignature(signature, candidateUrls, params);
  }

  /** Apply a delivery-status callback to the matching message log (and its notification event). */
  async handleStatusCallback(body: TwilioStatusCallback): Promise<void> {
    const sid = body.MessageSid?.trim();
    if (!sid) {
      this.logger.warn('Twilio status callback missing MessageSid; ignoring.');
      return;
    }

    const mapped = mapTwilioStatus(body.MessageStatus);
    if (!mapped) {
      this.logger.log(`Twilio status callback for ${sid} has untracked status ${body.MessageStatus}; ignoring.`);
      return;
    }

    const log = await this.findLogBySid(sid);
    if (!log) {
      // Callback for a message we didn't log (or logged without a SID yet) — nothing to update.
      this.logger.warn(`No message log found for Twilio SID ${sid}; status ${mapped} dropped.`);
      return;
    }

    if (!shouldApplyStatus(log.delivery_status, mapped)) {
      return; // out-of-order / replayed callback — don't downgrade.
    }

    const nowIso = new Date().toISOString();
    const errorMessage = isFailureStatus(mapped) ? buildError(body) : null;
    const update: Record<string, unknown> = {
      delivery_status: mapped,
      provider_status: body.MessageStatus ?? null,
    };
    if (mapped === 'delivered' || mapped === 'read') update.delivered_at = nowIso;
    if (isFailureStatus(mapped)) {
      update.failed_at = nowIso;
      update.error_message = errorMessage;
    }

    const { error } = await this.admin.schema('comms').from('message_logs').update(update).eq('id', log.id);
    if (error) {
      this.logger.error(`update message_log ${log.id} from callback failed: ${error.message}`);
      return;
    }

    // Mirror the terminal/forward delivery state onto the notification event so it stays truthful.
    if (log.notification_event_id) {
      await this.admin
        .schema('comms')
        .from('notification_events')
        .update({ status: mapped, ...(errorMessage ? { last_error_message: errorMessage.slice(0, 500) } : {}) })
        .eq('id', log.notification_event_id);
    }

    // Async real failure (Twilio reported failed/undelivered) → escalate to the next channel in the
    // WhatsApp → Email → SMS chain for the same notification. This is the only place a
    // delivered-then-failed (or accepted-then-undelivered) message triggers a fallback; a
    // merely-pending message never reaches here. Idempotent via the fallback event's unique index.
    // A failure on the last channel (SMS) finds no next channel and is a no-op.
    if (isFailureStatus(mapped) && log.appointment_id && log.message_type && log.channel) {
      await this.booking.escalateToNextChannelSafe(
        log.appointment_id,
        log.message_type,
        log.channel as DeliveryChannel,
        `${log.channel} ${mapped}${errorMessage ? `: ${errorMessage}` : ''}`,
      );
    }
  }

  /**
   * Log an inbound WhatsApp reply. Minimal today (Phase 9): we record it against the same
   * business/location/client as the most recent outbound message to that number, so it shows up in
   * the client's CRM message history. Future two-way logic can build on this row.
   */
  async handleInboundMessage(body: TwilioInboundMessage): Promise<void> {
    const from = body.From?.trim();
    if (!from) {
      this.logger.warn('Twilio inbound message missing From; ignoring.');
      return;
    }

    const context = await this.findInboundContext(from);
    if (!context) {
      // We can't attribute the reply to a business/location (message_logs requires both), so we
      // log it for visibility but don't persist a dangling row.
      this.logger.warn(`Inbound WhatsApp from ${maskPhone(from)} could not be matched to a client; not persisted.`);
      return;
    }

    const channel = /^whatsapp:/i.test(from) ? WHATSAPP_CHANNEL : SMS_CHANNEL;
    const { error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .insert({
        business_id: context.business_id,
        location_id: context.location_id,
        client_profile_id: context.client_profile_id,
        appointment_id: context.appointment_id,
        channel,
        direction: 'inbound',
        provider: this.whatsapp.provider,
        provider_message_id: body.MessageSid ?? null,
        delivery_status: 'delivered',
        message_type: 'inbound_reply',
        recipient: from,
        content_preview: (body.Body ?? '').slice(0, 200),
        payload_snapshot: { direction: 'inbound', from, to: body.To ?? null, body: body.Body ?? '' },
        delivered_at: new Date().toISOString(),
      });
    if (error) this.logger.error(`insert inbound message_log failed: ${error.message}`);
  }

  private async findLogBySid(sid: string): Promise<MessageLogRow | null> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .select(LOG_COLUMNS)
      .eq('provider', this.whatsapp.provider)
      .eq('provider_message_id', sid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<MessageLogRow>();
    if (error) {
      this.logger.error(`lookup message_log by sid ${sid} failed: ${error.message}`);
      return null;
    }
    return data ?? null;
  }

  /** Best-effort: attribute an inbound reply via the latest outbound message to that number. */
  private async findInboundContext(from: string): Promise<MessageLogRow | null> {
    const normalized = normalizeWhatsAppAddress(from);
    const candidates = [from, normalized, normalized?.replace(/^whatsapp:/, '')].filter(
      (v): v is string => Boolean(v),
    );
    const { data, error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .select(LOG_COLUMNS)
      .eq('direction', 'outbound')
      .in('recipient', candidates)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<MessageLogRow>();
    if (error) {
      this.logger.error(`lookup inbound context for ${maskPhone(from)} failed: ${error.message}`);
      return null;
    }
    return data ?? null;
  }
}

function buildError(body: TwilioStatusCallback): string {
  const parts = [body.ErrorCode && `code ${body.ErrorCode}`, body.ErrorMessage].filter(Boolean);
  return parts.length ? parts.join(': ') : 'Delivery failed';
}

function maskPhone(value: string): string {
  return value.replace(/\d(?=\d{4})/g, '*');
}
