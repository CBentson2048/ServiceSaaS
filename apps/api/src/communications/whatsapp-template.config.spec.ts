import type { ConfigService } from '@nestjs/config';
import { WhatsAppTemplateConfig, publicUrlOrUndefined } from './whatsapp-template.config';
import { NotificationEventKey } from './notification.types';

function configFrom(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('WhatsAppTemplateConfig', () => {
  it('resolves the documented TWILIO_WHATSAPP_*_CONTENT_SID names', () => {
    const cfg = new WhatsAppTemplateConfig(
      configFrom({
        TWILIO_WHATSAPP_CONFIRMATION_CONTENT_SID: 'HXconfirm',
        TWILIO_WHATSAPP_REMINDER_2H_CONTENT_SID: 'HX2h',
        TWILIO_WHATSAPP_REMINDER_24H_CONTENT_SID: 'HX24',
        TWILIO_STATUS_CALLBACK_URL: 'https://cb',
      }),
    );
    expect(cfg.contentSidFor(NotificationEventKey.BookingConfirmation)).toBe('HXconfirm');
    expect(cfg.contentSidFor(NotificationEventKey.Reminder2h)).toBe('HX2h');
    expect(cfg.contentSidFor(NotificationEventKey.Reminder24h)).toBe('HX24');
    expect(cfg.statusCallbackUrl).toBe('https://cb');
  });

  it('falls back to the legacy TWILIO_TEMPLATE_BOOKING_*_SID names', () => {
    const cfg = new WhatsAppTemplateConfig(
      configFrom({
        TWILIO_TEMPLATE_BOOKING_CONFIRMATION_SID: 'HXlegacyConfirm',
        TWILIO_TEMPLATE_BOOKING_REMINDER_24H_SID: 'HXlegacy24',
        TWILIO_TEMPLATE_BOOKING_REMINDER_48H_SID: 'HXlegacy48',
      }),
    );
    expect(cfg.contentSidFor(NotificationEventKey.BookingConfirmation)).toBe('HXlegacyConfirm');
    expect(cfg.contentSidFor(NotificationEventKey.Reminder24h)).toBe('HXlegacy24');
    expect(cfg.contentSidFor(NotificationEventKey.Reminder48h)).toBe('HXlegacy48');
  });

  it('prefers the documented name over the legacy alias when both are set', () => {
    const cfg = new WhatsAppTemplateConfig(
      configFrom({
        TWILIO_WHATSAPP_CONFIRMATION_CONTENT_SID: 'HXnew',
        TWILIO_TEMPLATE_BOOKING_CONFIRMATION_SID: 'HXold',
      }),
    );
    expect(cfg.contentSidFor(NotificationEventKey.BookingConfirmation)).toBe('HXnew');
  });

  it('returns undefined for an event with no configured template (→ freeform fallback)', () => {
    const cfg = new WhatsAppTemplateConfig(configFrom({}));
    expect(cfg.contentSidFor(NotificationEventKey.Reminder1w)).toBeUndefined();
  });

  it('omits a non-public StatusCallback URL (Twilio rejects them) but keeps a public one', () => {
    const local = new WhatsAppTemplateConfig(
      configFrom({ TWILIO_STATUS_CALLBACK_URL: 'http://localhost:3001/api/twilio/messaging/status' }),
    );
    expect(local.statusCallbackUrl).toBeUndefined();

    const prod = new WhatsAppTemplateConfig(
      configFrom({ TWILIO_STATUS_CALLBACK_URL: 'https://api.example.com/api/twilio/messaging/status' }),
    );
    expect(prod.statusCallbackUrl).toBe('https://api.example.com/api/twilio/messaging/status');
  });
});

describe('publicUrlOrUndefined', () => {
  it('accepts public http(s) URLs', () => {
    expect(publicUrlOrUndefined('https://api.example.com/cb')).toBe('https://api.example.com/cb');
    expect(publicUrlOrUndefined('http://example.com/cb')).toBe('http://example.com/cb');
  });

  it('rejects localhost, loopback, private ranges, non-http and junk', () => {
    expect(publicUrlOrUndefined('http://localhost:3001/cb')).toBeUndefined();
    expect(publicUrlOrUndefined('http://127.0.0.1/cb')).toBeUndefined();
    expect(publicUrlOrUndefined('https://192.168.1.10/cb')).toBeUndefined();
    expect(publicUrlOrUndefined('https://10.0.0.5/cb')).toBeUndefined();
    expect(publicUrlOrUndefined('https://api.local/cb')).toBeUndefined();
    expect(publicUrlOrUndefined('ftp://example.com/cb')).toBeUndefined();
    expect(publicUrlOrUndefined('not a url')).toBeUndefined();
    expect(publicUrlOrUndefined(undefined)).toBeUndefined();
  });
});
