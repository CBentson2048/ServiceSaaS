import { Injectable } from '@nestjs/common';
import type { DeliveryChannel } from '../channel-policy';
import { EmailMessageProvider } from './email-message.provider';
import type { MessageProvider } from './message-provider';
import { SmsMessageProvider } from './sms-message.provider';
import { WhatsAppMessageProvider } from './whatsapp-message.provider';

/**
 * Resolves the {@link MessageProvider} for a channel. This is the single seam the
 * dispatcher uses to send, so swapping a provider (e.g. Twilio → another SMS
 * vendor) is a matter of registering a different adapter here — no changes to the
 * dispatch/core logic and no provider-specific fields in core tables.
 */
@Injectable()
export class MessageProviderRegistry {
  private readonly byChannel = new Map<DeliveryChannel, MessageProvider>();

  constructor(
    whatsapp: WhatsAppMessageProvider,
    sms: SmsMessageProvider,
    email: EmailMessageProvider,
  ) {
    this.register(whatsapp);
    this.register(sms);
    this.register(email);
  }

  register(provider: MessageProvider): void {
    this.byChannel.set(provider.channel, provider);
  }

  forChannel(channel: DeliveryChannel): MessageProvider | undefined {
    return this.byChannel.get(channel);
  }

  isChannelEnabled(channel: DeliveryChannel): boolean {
    return this.forChannel(channel)?.isEnabled ?? false;
  }

  providerName(channel: DeliveryChannel): string | undefined {
    return this.forChannel(channel)?.providerName;
  }

  /** True when at least one channel has a configured provider (else the poller idles). */
  get anyEnabled(): boolean {
    for (const provider of this.byChannel.values()) {
      if (provider.isEnabled) return true;
    }
    return false;
  }
}
