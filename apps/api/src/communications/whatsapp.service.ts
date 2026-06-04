import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyTwilioSignature } from '../twilio/twilio-signature';
import { toWhatsAppAddress } from './phone';

export interface SendWhatsAppInput {
  /** Recipient phone in E.164 (e.g. `+447700900123`). The `whatsapp:` prefix is added here. */
  to: string;
  /**
   * Approved Twilio Content template SID (`HXxx...`). When present the message is sent via the
   * Content API with {@link contentVariables} — the production path. WhatsApp business-initiated
   * messages outside the 24h session window require an approved template.
   */
  contentSid?: string;
  /** Positional Content template variables, keyed `"1"`, `"2"`, … serialised to `ContentVariables`. */
  contentVariables?: Record<string, string>;
  /** Freeform body — fallback only when no {@link contentSid} is configured (e.g. Twilio sandbox in dev). */
  body?: string;
  /** Public URL Twilio posts delivery-status callbacks to. */
  statusCallback?: string;
}

export interface SendWhatsAppResult {
  /** True when Twilio accepted the message for delivery (NOT proof of delivery — see status callbacks). */
  accepted: boolean;
  /** Twilio message SID when accepted. */
  providerMessageId?: string;
  /** Twilio message status (`queued` | `accepted` | `sent` | ...) at accept time. */
  providerStatus?: string;
  /** Set when the send failed or was skipped (missing credentials / send error). */
  error?: string;
  /** True when Twilio credentials are absent and we logged instead of sending. */
  skipped?: boolean;
}

/**
 * Thin wrapper around the Twilio WhatsApp REST API. Uses `fetch` (Node 20+) directly rather than
 * the Twilio SDK to avoid adding a dependency, mirroring the deliberately fail-soft contract of
 * {@link EmailService}: callers always receive a result and never see exceptions.
 *
 * Production sends use an **approved Content template SID + ContentVariables** (never a hardcoded
 * body) and route through a **Messaging Service** when configured, with a **StatusCallback** so
 * delivery state is tracked truthfully via {@link TwilioCallbackService}. A successful send only
 * means Twilio *accepted* the message — `comms.message_logs` is advanced to `delivered`/`failed`/
 * `undelivered`/`read` later by the status webhook.
 *
 * Credentials (all optional in dev — when the sender/credentials are absent the service is log-only):
 *  - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
 *  - TWILIO_MESSAGING_SERVICE_SID (preferred sender) or TWILIO_WHATSAPP_FROM
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly accountSid?: string;
  private readonly authTokenValue?: string;
  private readonly from?: string;
  private readonly messagingServiceSid?: string;

  readonly provider = 'twilio';

  constructor(config: ConfigService) {
    this.accountSid = config.get<string>('TWILIO_ACCOUNT_SID')?.trim() || undefined;
    this.authTokenValue = config.get<string>('TWILIO_AUTH_TOKEN')?.trim() || undefined;
    this.from = normalizeWhatsAppAddress(config.get<string>('TWILIO_WHATSAPP_FROM'));
    this.messagingServiceSid = config.get<string>('TWILIO_MESSAGING_SERVICE_SID')?.trim() || undefined;

    if (!this.isEnabled) {
      this.logger.warn(
        'Twilio WhatsApp credentials are not fully set. WhatsAppService is in log-only mode; messages will not be delivered.',
      );
    }
  }

  /** Enabled once we have credentials and at least one sender (Messaging Service or From number). */
  get isEnabled(): boolean {
    return Boolean(this.accountSid && this.authTokenValue && (this.messagingServiceSid || this.from));
  }

  /** Auth token for webhook signature verification (never logged). Undefined when unconfigured. */
  get authToken(): string | undefined {
    return this.authTokenValue;
  }

  /** Verify an inbound Twilio webhook signature (delegates to the pure util). */
  verifyWebhookSignature(
    signatureHeader: string | undefined,
    candidateUrls: Array<string | undefined>,
    params: Record<string, string>,
  ): boolean {
    if (!this.authTokenValue) return false;
    return verifyTwilioSignature(this.authTokenValue, signatureHeader, candidateUrls, params);
  }

  async send(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
    const to = normalizeWhatsAppAddress(input.to);
    if (!to) {
      return { accepted: false, error: 'Recipient phone number is missing or invalid' };
    }
    if (!input.contentSid && !input.body?.trim()) {
      return { accepted: false, error: 'No content template SID or fallback body provided' };
    }

    if (!this.isEnabled) {
      this.logger.log(
        `[whatsapp:skipped] to=${to} template=${input.contentSid ?? '(body)'} (Twilio credentials unset)`,
      );
      return { accepted: false, skipped: true };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authTokenValue}`).toString('base64');

    const form = new URLSearchParams({ To: to });
    // Sender: prefer the Messaging Service; otherwise the single From number.
    if (this.messagingServiceSid) form.set('MessagingServiceSid', this.messagingServiceSid);
    else form.set('From', this.from!);

    if (input.contentSid) {
      form.set('ContentSid', input.contentSid);
      if (input.contentVariables && Object.keys(input.contentVariables).length > 0) {
        form.set('ContentVariables', JSON.stringify(input.contentVariables));
      }
    } else {
      form.set('Body', input.body!);
    }

    if (input.statusCallback) form.set('StatusCallback', input.statusCallback);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        sid?: string;
        status?: string;
        message?: string;
        code?: number;
      };

      if (!response.ok) {
        const message = payload.message ?? `Twilio responded ${response.status}`;
        this.logger.error(`WhatsApp send failed for ${to}: ${message}`);
        return { accepted: false, error: message, providerStatus: payload.status };
      }

      return {
        accepted: true,
        providerMessageId: payload.sid,
        providerStatus: payload.status,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`WhatsApp send threw for ${to}: ${message}`);
      return { accepted: false, error: message };
    }
  }
}

/** Normalise a phone/address into Twilio's `whatsapp:+E164` form. Returns undefined when unusable. */
export function normalizeWhatsAppAddress(raw: string | undefined | null): string | undefined {
  return toWhatsAppAddress(raw);
}
