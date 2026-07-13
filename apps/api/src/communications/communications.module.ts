import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { BookingNotificationService } from './booking-notification.service';
import { CommunicationSettingsService } from './communication-settings.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { EmailMessageProvider } from './providers/email-message.provider';
import { MessageProviderRegistry } from './providers/message-provider.registry';
import { SmsMessageProvider } from './providers/sms-message.provider';
import { WhatsAppMessageProvider } from './providers/whatsapp-message.provider';
import { ResendCallbackService } from './resend-callback.service';
import { ResendWebhookController } from './resend-webhook.controller';
import { SmsService } from './sms.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppTemplateConfig } from './whatsapp-template.config';

/**
 * Booking notifications: owner-configurable confirmation + reminder rules, a scheduling engine that
 * reconciles the `comms.notification_events` queue, and a background dispatcher that delivers due
 * events over the WhatsApp → Email → SMS chain with full message logging in `comms.message_logs`.
 * Hosts the Resend email delivery/bounce webhook (`POST /api/email/status`) so email status is
 * tracked and a bounce escalates to SMS.
 *
 * Exports the settings + scheduling services so the owner settings API and the booking flow can drive
 * them; the dispatcher runs autonomously on a timer.
 */
@Module({
  imports: [EmailModule],
  controllers: [ResendWebhookController],
  providers: [
    WhatsAppService,
    SmsService,
    WhatsAppTemplateConfig,
    WhatsAppMessageProvider,
    SmsMessageProvider,
    EmailMessageProvider,
    MessageProviderRegistry,
    CommunicationSettingsService,
    BookingNotificationService,
    NotificationDispatchService,
    ResendCallbackService,
  ],
  exports: [CommunicationSettingsService, BookingNotificationService, WhatsAppService, MessageProviderRegistry],
})
export class CommunicationsModule {}
