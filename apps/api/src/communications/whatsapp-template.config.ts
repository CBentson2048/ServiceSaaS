import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationEventKey } from './notification.types';

/**
 * Resolves the approved Twilio Content template SID for each notification event from env/config —
 * template IDs are never hardcoded (Phase 4). When a SID is not configured for an event the
 * dispatcher falls back to a freeform body, which is only useful with the Twilio sandbox in dev.
 *
 * Also exposes the `StatusCallback` URL passed on every send so Twilio can post delivery updates.
 */
@Injectable()
export class WhatsAppTemplateConfig {
  private readonly logger = new Logger(WhatsAppTemplateConfig.name);
  private readonly contentSids: Partial<Record<NotificationEventKey, string>>;
  /**
   * Public delivery-status callback URL passed on every send. Only set when the configured URL is
   * publicly reachable — Twilio rejects the WHOLE message (error 21609) if `StatusCallback` points at
   * localhost/a private host, so in local dev we omit it (delivery receipts can't reach localhost
   * anyway) and the send still goes through.
   */
  readonly statusCallbackUrl?: string;

  constructor(config: ConfigService) {
    // Resolve the documented `TWILIO_WHATSAPP_*_CONTENT_SID` name first, then accept the legacy
    // `TWILIO_TEMPLATE_BOOKING_*_SID` name some deployments use — so an existing env that set the
    // approved templates under either convention is honoured (a mismatch here silently falls back to
    // freeform, which Twilio rejects for business-initiated WhatsApp).
    const sid = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = config.get<string>(key)?.trim();
        if (value) return value;
      }
      return undefined;
    };
    this.contentSids = {
      [NotificationEventKey.BookingConfirmation]: sid(
        'TWILIO_WHATSAPP_CONFIRMATION_CONTENT_SID',
        'TWILIO_TEMPLATE_BOOKING_CONFIRMATION_SID',
      ),
      [NotificationEventKey.Reminder24h]: sid(
        'TWILIO_WHATSAPP_REMINDER_24H_CONTENT_SID',
        'TWILIO_TEMPLATE_BOOKING_REMINDER_24H_SID',
      ),
      [NotificationEventKey.Reminder48h]: sid(
        'TWILIO_WHATSAPP_REMINDER_48H_CONTENT_SID',
        'TWILIO_TEMPLATE_BOOKING_REMINDER_48H_SID',
      ),
      [NotificationEventKey.Reminder1w]: sid(
        'TWILIO_WHATSAPP_REMINDER_1W_CONTENT_SID',
        'TWILIO_TEMPLATE_BOOKING_REMINDER_1W_SID',
      ),
      [NotificationEventKey.RebookingNudge]: sid(
        'TWILIO_WHATSAPP_REBOOKING_NUDGE_CONTENT_SID',
        'TWILIO_TEMPLATE_REBOOKING_NUDGE_SID',
      ),
    };
    const configuredCallback = config.get<string>('TWILIO_STATUS_CALLBACK_URL')?.trim() || undefined;
    this.statusCallbackUrl = publicUrlOrUndefined(configuredCallback);
    if (configuredCallback && !this.statusCallbackUrl) {
      this.logger.warn(
        `TWILIO_STATUS_CALLBACK_URL (${configuredCallback}) is not publicly reachable; omitting StatusCallback ` +
          'from sends (Twilio rejects non-public callback URLs). Delivery receipts/async fallback are disabled ' +
          'until a public URL (e.g. a tunnel or your deployed API) is configured.',
      );
    }

    this.logConfigurationSummary();
  }

  /** Approved Content template SID for an event, or undefined when not configured. */
  contentSidFor(eventKey: NotificationEventKey | string): string | undefined {
    return this.contentSids[eventKey as NotificationEventKey];
  }

  /**
   * Logs, at startup, which notification events have an approved Content template SID configured and
   * which do not — so it is immediately obvious from the boot logs whether WhatsApp sends will use
   * the predefined templates or silently fall back to a freeform body. SIDs are masked (they are not
   * secret credentials, but there is no reason to print them in full).
   */
  private logConfigurationSummary(): void {
    const entries = Object.entries(this.contentSids) as Array<[string, string | undefined]>;
    const summary = entries
      .map(([eventKey, sid]) => `${eventKey}=${sid ? maskSid(sid) : 'MISSING'}`)
      .join(', ');
    const missing = entries.filter(([, sid]) => !sid).map(([eventKey]) => eventKey);

    this.logger.log(`WhatsApp Content templates: ${summary}`);
    if (missing.length > 0) {
      this.logger.warn(
        `No approved WhatsApp Content template SID configured for: ${missing.join(', ')}. ` +
          'These events fall back to a freeform body, which WhatsApp rejects for business-initiated ' +
          'messages outside the 24h session window. Set TWILIO_WHATSAPP_<EVENT>_CONTENT_SID (or the ' +
          'legacy TWILIO_TEMPLATE_BOOKING_<EVENT>_SID) in the running environment — note the deployed ' +
          'env (e.g. Railway) does not read apps/api/.env, so these must be set there too.',
      );
    }
  }
}

/** Mask a Content SID for logs: keep the `HX` + first 2 chars, hide the rest. */
function maskSid(sid: string): string {
  return sid.length > 6 ? `${sid.slice(0, 4)}…(${sid.length} chars)` : 'set';
}

/**
 * Return the URL only when it is a syntactically valid http(s) URL whose host is publicly reachable
 * (not localhost / loopback / a private LAN range). Twilio rejects a send outright when StatusCallback
 * is not publicly reachable, so we treat such URLs as "no callback" rather than letting them fail sends.
 */
export function publicUrlOrUndefined(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let host: string;
  let protocol: string;
  try {
    const parsed = new URL(raw);
    host = parsed.hostname.toLowerCase();
    protocol = parsed.protocol;
  } catch {
    return undefined;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return undefined;
  const isNonPublic =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return isNonPublic ? undefined : raw;
}
