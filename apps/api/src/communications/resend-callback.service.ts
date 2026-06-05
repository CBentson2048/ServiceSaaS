import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BookingNotificationService } from './booking-notification.service';
import { EMAIL_CHANNEL } from './notification.types';
import { mapResendEvent, shouldApplyEmailStatus } from './resend-status';

const EMAIL_PROVIDER = 'resend';

interface EmailLogRow {
  id: string;
  channel: string | null;
  message_type: string | null;
  delivery_status: string | null;
  notification_event_id: string | null;
  appointment_id: string | null;
}

const LOG_COLUMNS = 'id,channel,message_type,delivery_status,notification_event_id,appointment_id';

/** Resend webhook payload (Svix-wrapped). We only need the type and the provider message id. */
export interface ResendWebhookEvent {
  type?: string;
  data?: { email_id?: string };
}

/**
 * Applies Resend email delivery/bounce webhooks to `comms.message_logs`, keeping CRM history
 * truthful, and — critically for the WhatsApp → Email → SMS chain — escalates to the next channel
 * (SMS) when an email **hard-bounces**. A merely-accepted ("sent") or delivered email never triggers
 * SMS. Lookups are by provider message id (indexed), so callbacks are idempotent under replay and a
 * later out-of-order status never downgrades a more-advanced one.
 */
@Injectable()
export class ResendCallbackService {
  private readonly logger = new Logger(ResendCallbackService.name);
  private readonly admin: SupabaseClient;

  constructor(
    private readonly config: ConfigService,
    private readonly booking: BookingNotificationService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Resend (Svix) webhook signing secret — `whsec_…`. Undefined ⇒ webhook is rejected (secure default). */
  get webhookSecret(): string | undefined {
    return this.config.get<string>('RESEND_WEBHOOK_SECRET')?.trim() || undefined;
  }

  async handleEvent(event: ResendWebhookEvent): Promise<void> {
    const emailId = event.data?.email_id?.trim();
    const mapped = mapResendEvent(event.type);
    if (!emailId) {
      this.logger.warn('Resend webhook missing data.email_id; ignoring.');
      return;
    }
    if (!mapped) {
      this.logger.log(`Resend webhook ${event.type} for ${emailId} is untracked; ignoring.`);
      return;
    }

    const log = await this.findLogByProviderId(emailId);
    if (!log) {
      this.logger.warn(`No email message log found for Resend id ${emailId}; ${mapped.status} dropped.`);
      return;
    }
    if (!shouldApplyEmailStatus(log.delivery_status, mapped.status)) {
      return; // out-of-order / replayed callback — don't downgrade.
    }

    const nowIso = new Date().toISOString();
    const update: Record<string, unknown> = { delivery_status: mapped.status, provider_status: event.type ?? null };
    if (mapped.status === 'delivered') update.delivered_at = nowIso;
    if (mapped.status === 'failed') {
      update.failed_at = nowIso;
      update.error_message = `Resend ${event.type ?? 'failure'}`.slice(0, 500);
    }

    const { error } = await this.admin.schema('comms').from('message_logs').update(update).eq('id', log.id);
    if (error) {
      this.logger.error(`update email message_log ${log.id} from webhook failed: ${error.message}`);
      return;
    }

    // Mirror the delivery state onto the notification event so it stays truthful.
    if (log.notification_event_id) {
      await this.admin
        .schema('comms')
        .from('notification_events')
        .update({
          status: mapped.status,
          ...(mapped.status === 'failed' ? { last_error_message: `Resend ${event.type ?? 'failure'}`.slice(0, 500) } : {}),
        })
        .eq('id', log.notification_event_id);
    }

    // Hard bounce → escalate to the next channel (SMS) for the same notification. Idempotent via the
    // fallback event's unique index. Spam complaints do NOT escalate (the email arrived).
    if (mapped.escalate && log.channel === EMAIL_CHANNEL && log.appointment_id && log.message_type) {
      await this.booking.escalateToNextChannelSafe(
        log.appointment_id,
        log.message_type,
        EMAIL_CHANNEL,
        `email ${event.type ?? 'bounced'}`,
      );
    }
  }

  private async findLogByProviderId(emailId: string): Promise<EmailLogRow | null> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .select(LOG_COLUMNS)
      .eq('provider', EMAIL_PROVIDER)
      .eq('provider_message_id', emailId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<EmailLogRow>();
    if (error) {
      this.logger.error(`lookup email message_log by id ${emailId} failed: ${error.message}`);
      return null;
    }
    return data ?? null;
  }
}
