import type { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('SmsService (fail-soft)', () => {
  it('is disabled and skips when credentials/sender are absent', async () => {
    const svc = new SmsService(configWith({}));
    expect(svc.isEnabled).toBe(false);
    expect(await svc.send({ to: '+447725485160', body: 'hi' })).toEqual({ accepted: false, skipped: true });
  });

  it('is enabled with a From number or a Messaging Service', () => {
    expect(
      new SmsService(configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+441234567890' }))
        .isEnabled,
    ).toBe(true);
    expect(
      new SmsService(
        configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1' }),
      ).isEnabled,
    ).toBe(true);
  });

  it('sends a plain-E.164 SMS with a body and StatusCallback (no whatsapp: prefix)', async () => {
    const svc = new SmsService(
      configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+441234567890' }),
    );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201 }));

    const result = await svc.send({
      to: '+447725485160',
      body: 'Your appointment is confirmed',
      statusCallback: 'https://api.example.com/api/twilio/messaging/status',
    });

    expect(result).toEqual({ accepted: true, providerMessageId: 'SM1', providerStatus: 'queued' });
    const body = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.get('To')).toBe('+447725485160'); // plain E.164, NOT whatsapp:
    expect(body.get('From')).toBe('+441234567890');
    expect(body.get('Body')).toBe('Your appointment is confirmed');
    expect(body.get('StatusCallback')).toBe('https://api.example.com/api/twilio/messaging/status');
    fetchMock.mockRestore();
  });

  it('rejects an invalid recipient without throwing', async () => {
    const svc = new SmsService(
      configWith({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+441234567890' }),
    );
    const result = await svc.send({ to: 'nope', body: 'hi' });
    expect(result.accepted).toBe(false);
    expect(result.error).toBeDefined();
  });
});
