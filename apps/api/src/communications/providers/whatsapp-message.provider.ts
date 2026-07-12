import { Injectable } from '@nestjs/common';
import type { DeliveryChannel } from '../channel-policy';
import { WHATSAPP_CHANNEL } from '../notification.types';
import { WhatsAppService } from '../whatsapp.service';
import type { MessageProvider, OutboundMessage, ProviderSendResult } from './message-provider';

/** WhatsApp channel adapter — wraps {@link WhatsAppService} (Twilio) behind the abstraction. */
@Injectable()
export class WhatsAppMessageProvider implements MessageProvider {
  readonly channel: DeliveryChannel = WHATSAPP_CHANNEL;

  constructor(private readonly whatsapp: WhatsAppService) {}

  get providerName(): string {
    return this.whatsapp.provider;
  }

  get isEnabled(): boolean {
    return this.whatsapp.isEnabled;
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    return this.whatsapp.send({
      to: message.to,
      contentSid: message.templateId,
      contentVariables: message.templateVariables,
      body: message.body,
      statusCallback: message.statusCallbackUrl,
    });
  }
}
