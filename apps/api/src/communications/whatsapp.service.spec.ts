import type { ConfigService } from '@nestjs/config';
import { normalizeWhatsAppAddress, WhatsAppService } from './whatsapp.service';

describe('normalizeWhatsAppAddress', () => {
  it('prefixes a bare E.164 number with whatsapp:', () => {
    expect(normalizeWhatsAppAddress('+447700900123')).toBe('whatsapp:+447700900123');
  });

  it('strips spacing/punctuation and adds a leading +', () => {
    expect(normalizeWhatsAppAddress('44 (770) 090-0123')).toBe('whatsapp:+447700900123');
  });

  it('keeps an already-prefixed address idempotent', () => {
    expect(normalizeWhatsAppAddress('whatsapp:+447700900123')).toBe('whatsapp:+447700900123');
  });

  it('rejects empty or junk input', () => {
    expect(normalizeWhatsAppAddress('')).toBeUndefined();
    expect(normalizeWhatsAppAddress(null)).toBeUndefined();
    expect(normalizeWhatsAppAddress('not-a-phone')).toBeUndefined();
  });
});

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('WhatsAppService (fail-soft)', () => {
  it('is disabled and skips sending when credentials are absent', async () => {
    const svc = new WhatsAppService(configWith({}));
    expect(svc.isEnabled).toBe(false);
    const result = await svc.send({ to: '+447700900123', body: 'hi' });
    expect(result).toEqual({ delivered: false, skipped: true });
  });

  it('reports an invalid recipient without throwing', async () => {
    const svc = new WhatsAppService(
      configWith({
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_WHATSAPP_FROM: '+14155238886',
      }),
    );
    expect(svc.isEnabled).toBe(true);
    const result = await svc.send({ to: 'garbage', body: 'hi' });
    expect(result.delivered).toBe(false);
    expect(result.error).toBeDefined();
  });
});
