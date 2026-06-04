import { Injectable } from '@nestjs/common';
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
  private readonly contentSids: Partial<Record<NotificationEventKey, string>>;
  readonly statusCallbackUrl?: string;

  constructor(config: ConfigService) {
    this.contentSids = {
      [NotificationEventKey.BookingConfirmation]:
        config.get<string>('TWILIO_WHATSAPP_CONFIRMATION_CONTENT_SID')?.trim() || undefined,
      [NotificationEventKey.Reminder24h]:
        config.get<string>('TWILIO_WHATSAPP_REMINDER_24H_CONTENT_SID')?.trim() || undefined,
      [NotificationEventKey.Reminder48h]:
        config.get<string>('TWILIO_WHATSAPP_REMINDER_48H_CONTENT_SID')?.trim() || undefined,
      [NotificationEventKey.Reminder1w]:
        config.get<string>('TWILIO_WHATSAPP_REMINDER_1W_CONTENT_SID')?.trim() || undefined,
    };
    this.statusCallbackUrl = config.get<string>('TWILIO_STATUS_CALLBACK_URL')?.trim() || undefined;
  }

  /** Approved Content template SID for an event, or undefined when not configured. */
  contentSidFor(eventKey: NotificationEventKey | string): string | undefined {
    return this.contentSids[eventKey as NotificationEventKey];
  }
}
