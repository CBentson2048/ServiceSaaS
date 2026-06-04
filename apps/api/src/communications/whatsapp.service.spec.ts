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
    expect(result).toEqual({ accepted: false, skipped: true });
  });

  it('is enabled with a Messaging Service even without a From number', () => {
    const svc = new WhatsAppService(
      configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG1' }),
    );
    expect(svc.isEnabled).toBe(true);
  });

  it('reports an invalid recipient without throwing', async () => {
    const svc = new WhatsAppService(
      configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: '+14155238886' }),
    );
    expect(svc.isEnabled).toBe(true);
    const result = await svc.send({ to: 'garbage', body: 'hi' });
    expect(result.accepted).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects a send with neither content SID nor body', async () => {
    const svc = new WhatsAppService(
      configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: '+14155238886' }),
    );
    const result = await svc.send({ to: '+447700900123' });
    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/content template/i);
  });

  it('sends via Content SID + ContentVariables through the Messaging Service with a StatusCallback', async () => {
    const svc = new WhatsAppService(
      configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG1' }),
    );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ sid: 'SM123', status: 'queued' }), { status: 201 }),
      );

    const result = await svc.send({
      to: '+447700900123',
      contentSid: 'HX123',
      contentVariables: { '1': 'Sam', '2': 'Sheer Soho' },
      body: 'fallback ignored',
      statusCallback: 'https://api.example.com/api/twilio/messaging/status',
    });

    expect(result).toEqual({ accepted: true, providerMessageId: 'SM123', providerStatus: 'queued' });
    const sentBody = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(sentBody.get('To')).toBe('whatsapp:+447700900123');
    expect(sentBody.get('MessagingServiceSid')).toBe('MG1');
    expect(sentBody.get('ContentSid')).toBe('HX123');
    expect(sentBody.get('ContentVariables')).toBe(JSON.stringify({ '1': 'Sam', '2': 'Sheer Soho' }));
    expect(sentBody.get('StatusCallback')).toBe('https://api.example.com/api/twilio/messaging/status');
    expect(sentBody.get('From')).toBeNull(); // Messaging Service preferred over From
    expect(sentBody.get('Body')).toBeNull(); // Content template path does not send a freeform body
    fetchMock.mockRestore();
  });

  it('falls back to a freeform Body with a From number when no Content SID is configured', async () => {
    const svc = new WhatsAppService(
      configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_FROM: '+14155238886' }),
    );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sid: 'SM9', status: 'queued' }), { status: 201 }));

    await svc.send({ to: '+447700900123', body: 'hello there' });

    const sentBody = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(sentBody.get('From')).toBe('whatsapp:+14155238886');
    expect(sentBody.get('Body')).toBe('hello there');
    expect(sentBody.get('ContentSid')).toBeNull();
    fetchMock.mockRestore();
  });
});
