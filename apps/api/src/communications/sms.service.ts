import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeE164 } from './phone';

export interface SendSmsInput {
  /** Recipient phone in E.164 (e.g. `+447700900123`). */
  to: string;
  /** SMS body. SMS has no template-approval requirement, so the rendered message body is sent directly. */
  body: string;
  /** Public URL Twilio posts delivery-status callbacks to. */
  statusCallback?: string;
}

export interface SendSmsResult {
  /** True when Twilio accepted the message for delivery (NOT proof of delivery — see status callbacks). */
  accepted: boolean;
  providerMessageId?: string;
  providerStatus?: string;
  error?: string;
  /** True when Twilio credentials are absent and we logged instead of sending. */
  skipped?: boolean;
}

/**
 * Twilio SMS sender — the fallback channel for booking notifications when WhatsApp is unavailable or
 * has a real failure. Same fail-soft contract and provider (`twilio`) as {@link WhatsAppService}, so
 * the dispatcher and CRM message log treat the two channels uniformly. Routes through the shared
 * Messaging Service when configured, otherwise a dedicated SMS From number.
 *
 * Credentials (optional in dev — log-only when the sender/credentials are absent):
 *  - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
 *  - TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_SMS_FROM
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly accountSid?: string;
  private readonly authToken?: string;
  private readonly from?: string;
  private readonly messagingServiceSid?: string;

  readonly provider = 'twilio';

  constructor(config: ConfigService) {
    this.accountSid = config.get<string>('TWILIO_ACCOUNT_SID')?.trim() || undefined;
    this.authToken = config.get<string>('TWILIO_AUTH_TOKEN')?.trim() || undefined;
    this.from = normalizeE164(config.get<string>('TWILIO_SMS_FROM'));
    this.messagingServiceSid = config.get<string>('TWILIO_MESSAGING_SERVICE_SID')?.trim() || undefined;

    if (!this.isEnabled) {
      this.logger.warn(
        'Twilio SMS credentials/sender are not fully set. SmsService is in log-only mode; SMS fallback will not be delivered.',
      );
    }
  }

  get isEnabled(): boolean {
    return Boolean(this.accountSid && this.authToken && (this.messagingServiceSid || this.from));
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const to = normalizeE164(input.to);
    if (!to) return { accepted: false, error: 'Recipient phone number is missing or invalid' };
    if (!input.body?.trim()) return { accepted: false, error: 'SMS body is empty' };

    if (!this.isEnabled) {
      this.logger.log(`[sms:skipped] to=${to} (Twilio credentials unset)`);
      return { accepted: false, skipped: true };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const form = new URLSearchParams({ To: to, Body: input.body });
    if (this.messagingServiceSid) form.set('MessagingServiceSid', this.messagingServiceSid);
    else form.set('From', this.from!);
    if (input.statusCallback) form.set('StatusCallback', input.statusCallback);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        sid?: string;
        status?: string;
        message?: string;
      };
      if (!response.ok) {
        const message = payload.message ?? `Twilio responded ${response.status}`;
        this.logger.error(`SMS send failed for ${to}: ${message}`);
        return { accepted: false, error: message, providerStatus: payload.status };
      }
      return { accepted: true, providerMessageId: payload.sid, providerStatus: payload.status };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`SMS send threw for ${to}: ${message}`);
      return { accepted: false, error: message };
    }
  }
}
