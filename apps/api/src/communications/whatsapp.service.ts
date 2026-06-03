import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SendWhatsAppInput {
  /** Recipient phone in E.164 (e.g. `+447700900123`). The `whatsapp:` prefix is added here. */
  to: string;
  body: string;
}

export interface SendWhatsAppResult {
  delivered: boolean;
  /** Twilio message SID when accepted. */
  providerMessageId?: string;
  /** Twilio message status (`queued` | `sent` | `accepted` | ...) when available. */
  providerStatus?: string;
  /** Set when delivery failed or was skipped (missing credentials / send error). */
  error?: string;
  /** True when Twilio credentials are absent and we logged instead of sending. */
  skipped?: boolean;
}

/**
 * Thin wrapper around the Twilio WhatsApp REST API. Uses `fetch` (Node 20+) directly
 * rather than the Twilio SDK to avoid adding a dependency, mirroring the deliberately
 * fail-soft contract of {@link EmailService}: callers always receive a result and never
 * see exceptions. A send is a best-effort side effect — the booking has already
 * succeeded and the message log records the true delivery state either way.
 *
 * Credentials (all optional in dev — when absent the service is log-only):
 *  - TWILIO_ACCOUNT_SID
 *  - TWILIO_AUTH_TOKEN
 *  - TWILIO_WHATSAPP_FROM   e.g. `+14155238886` (Twilio sandbox) — `whatsapp:` prefix added automatically
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly accountSid?: string;
  private readonly authToken?: string;
  private readonly from?: string;

  readonly provider = 'twilio';

  constructor(config: ConfigService) {
    this.accountSid = config.get<string>('TWILIO_ACCOUNT_SID')?.trim() || undefined;
    this.authToken = config.get<string>('TWILIO_AUTH_TOKEN')?.trim() || undefined;
    this.from = normalizeWhatsAppAddress(config.get<string>('TWILIO_WHATSAPP_FROM'));

    if (!this.isEnabled) {
      this.logger.warn(
        'Twilio WhatsApp credentials are not fully set. WhatsAppService is in log-only mode; messages will not be delivered.',
      );
    }
  }

  get isEnabled(): boolean {
    return Boolean(this.accountSid && this.authToken && this.from);
  }

  async send(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
    const to = normalizeWhatsAppAddress(input.to);
    if (!to) {
      return { delivered: false, error: 'Recipient phone number is missing or invalid' };
    }

    if (!this.isEnabled) {
      this.logger.log(
        `[whatsapp:skipped] to=${to} body=${JSON.stringify(input.body.slice(0, 80))} (Twilio credentials unset)`,
      );
      return { delivered: false, skipped: true };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const form = new URLSearchParams({ To: to, From: this.from!, Body: input.body });

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
        return { delivered: false, error: message, providerStatus: payload.status };
      }

      return {
        delivered: true,
        providerMessageId: payload.sid,
        providerStatus: payload.status,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`WhatsApp send threw for ${to}: ${message}`);
      return { delivered: false, error: message };
    }
  }
}

/** Normalise a phone/address into Twilio's `whatsapp:+E164` form. Returns undefined when unusable. */
export function normalizeWhatsAppAddress(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const withoutPrefix = trimmed.replace(/^whatsapp:/i, '').trim();
  if (!/^\+?[0-9][0-9\s()-]{5,}$/.test(withoutPrefix)) return undefined;
  const digits = withoutPrefix.replace(/[\s()-]/g, '');
  const e164 = digits.startsWith('+') ? digits : `+${digits}`;
  return `whatsapp:${e164}`;
}
