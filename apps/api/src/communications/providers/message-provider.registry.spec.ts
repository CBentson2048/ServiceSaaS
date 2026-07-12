import type { EmailService } from '../../email/email.service';
import type { SmsService } from '../sms.service';
import type { WhatsAppService } from '../whatsapp.service';
import { EmailMessageProvider } from './email-message.provider';
import { MessageProviderRegistry } from './message-provider.registry';
import { SmsMessageProvider } from './sms-message.provider';
import { WhatsAppMessageProvider } from './whatsapp-message.provider';

function fakeWhatsApp(enabled = true) {
  return {
    provider: 'twilio',
    isEnabled: enabled,
    send: jest.fn().mockResolvedValue({ accepted: true, providerMessageId: 'SM1', providerStatus: 'queued' }),
  } as unknown as WhatsAppService;
}

function fakeSms(enabled = true) {
  return {
    provider: 'twilio',
    isEnabled: enabled,
    send: jest.fn().mockResolvedValue({ accepted: true, providerMessageId: 'SMS1' }),
  } as unknown as SmsService;
}

function fakeEmail(enabled = true, result: Record<string, unknown> = { delivered: true, id: 'resend-1' }) {
  return {
    isEnabled: enabled,
    send: jest.fn().mockResolvedValue(result),
  } as unknown as EmailService;
}

describe('MessageProviderRegistry', () => {
  it('resolves a provider per channel and reports channel enablement + provider name', () => {
    const registry = new MessageProviderRegistry(
      new WhatsAppMessageProvider(fakeWhatsApp(true)),
      new SmsMessageProvider(fakeSms(false)),
      new EmailMessageProvider(fakeEmail(true)),
    );

    expect(registry.forChannel('whatsapp')?.channel).toBe('whatsapp');
    expect(registry.forChannel('sms')?.channel).toBe('sms');
    expect(registry.forChannel('email')?.channel).toBe('email');

    expect(registry.isChannelEnabled('whatsapp')).toBe(true);
    expect(registry.isChannelEnabled('sms')).toBe(false);
    expect(registry.providerName('whatsapp')).toBe('twilio');
    expect(registry.providerName('email')).toBe('resend');
    expect(registry.anyEnabled).toBe(true);
  });

  it('reports anyEnabled=false when every provider is unconfigured', () => {
    const registry = new MessageProviderRegistry(
      new WhatsAppMessageProvider(fakeWhatsApp(false)),
      new SmsMessageProvider(fakeSms(false)),
      new EmailMessageProvider(fakeEmail(false)),
    );
    expect(registry.anyEnabled).toBe(false);
  });

  it('lets a channel provider be swapped without touching the registry consumers', async () => {
    const registry = new MessageProviderRegistry(
      new WhatsAppMessageProvider(fakeWhatsApp(true)),
      new SmsMessageProvider(fakeSms(true)),
      new EmailMessageProvider(fakeEmail(true)),
    );

    const swapped = {
      channel: 'sms' as const,
      providerName: 'vonage',
      isEnabled: true,
      send: jest.fn().mockResolvedValue({ accepted: true, providerMessageId: 'VN1' }),
    };
    registry.register(swapped);

    expect(registry.providerName('sms')).toBe('vonage');
    const result = await registry.forChannel('sms')!.send({ to: '+447700900123', body: 'hi' });
    expect(result).toEqual({ accepted: true, providerMessageId: 'VN1' });
  });
});

describe('channel adapters map to the normalised ProviderSendResult', () => {
  it('WhatsApp adapter forwards template + callback and passes the result through', async () => {
    const service = fakeWhatsApp(true);
    const provider = new WhatsAppMessageProvider(service);

    const result = await provider.send({
      to: '+447700900123',
      templateId: 'HX1',
      templateVariables: { '1': 'Sam' },
      statusCallbackUrl: 'https://cb',
    });

    expect(service.send).toHaveBeenCalledWith({
      to: '+447700900123',
      contentSid: 'HX1',
      contentVariables: { '1': 'Sam' },
      body: undefined,
      statusCallback: 'https://cb',
    });
    expect(result.accepted).toBe(true);
    expect(result.providerMessageId).toBe('SM1');
  });

  it('Email adapter normalises Resend { delivered, id } → { accepted, providerMessageId }', async () => {
    const delivered = new EmailMessageProvider(fakeEmail(true, { delivered: true, id: 'resend-9' }));
    expect(await delivered.send({ to: 'a@b.com', subject: 's', html: '<p>x</p>' })).toEqual({
      accepted: true,
      providerMessageId: 'resend-9',
      error: undefined,
      skipped: undefined,
    });

    const failed = new EmailMessageProvider(fakeEmail(true, { delivered: false, error: 'bounced' }));
    expect(await failed.send({ to: 'a@b.com', subject: 's', html: '<p>x</p>' })).toEqual({
      accepted: false,
      providerMessageId: undefined,
      error: 'bounced',
      skipped: undefined,
    });
  });
});
