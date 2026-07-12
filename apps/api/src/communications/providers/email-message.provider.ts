import { Injectable } from '@nestjs/common';
import { EmailService } from '../../email/email.service';
import type { DeliveryChannel } from '../channel-policy';
import { EMAIL_CHANNEL } from '../notification.types';
import type { MessageProvider, OutboundMessage, ProviderSendResult } from './message-provider';

/**
 * Email channel adapter — wraps {@link EmailService} (Resend) behind the
 * abstraction and normalises its `{ delivered, id }` result to the shared
 * `{ accepted, providerMessageId }` contract so the dispatcher is provider-agnostic.
 */
@Injectable()
export class EmailMessageProvider implements MessageProvider {
  readonly channel: DeliveryChannel = EMAIL_CHANNEL;
  readonly providerName = 'resend';

  constructor(private readonly email: EmailService) {}

  get isEnabled(): boolean {
    return this.email.isEnabled;
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    const result = await this.email.send({
      to: message.to,
      subject: message.subject ?? '',
      html: message.html ?? '',
      text: message.text,
      tags: message.tags,
    });
    return {
      accepted: result.delivered,
      providerMessageId: result.id,
      error: result.error,
      skipped: result.skipped,
    };
  }
}
