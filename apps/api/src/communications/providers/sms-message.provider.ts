import { Injectable } from '@nestjs/common';
import type { DeliveryChannel } from '../channel-policy';
import { SMS_CHANNEL } from '../notification.types';
import { SmsService } from '../sms.service';
import type { MessageProvider, OutboundMessage, ProviderSendResult } from './message-provider';

/** SMS channel adapter — wraps {@link SmsService} (Twilio) behind the abstraction. */
@Injectable()
export class SmsMessageProvider implements MessageProvider {
  readonly channel: DeliveryChannel = SMS_CHANNEL;

  constructor(private readonly sms: SmsService) {}

  get providerName(): string {
    return this.sms.provider;
  }

  get isEnabled(): boolean {
    return this.sms.isEnabled;
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    return this.sms.send({
      to: message.to,
      body: message.body ?? '',
      statusCallback: message.statusCallbackUrl,
    });
  }
}
