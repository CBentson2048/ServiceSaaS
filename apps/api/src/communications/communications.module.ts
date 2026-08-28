import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { BookingNotificationService } from './booking-notification.service';
import { CommunicationSettingsService } from './communication-settings.service';
import { MessagingService } from './messaging.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationEscalationService } from './notification-escalation.service';
import { NotificationSubjectRegistry } from './notification-subject.registry';
import { OptOutService } from './opt-out.service';
import { RebookingNudgeService } from './rebooking-nudge.service';
import { EmailMessageProvider } from './providers/email-message.provider';
import { MessageProviderRegistry } from './providers/message-provider.registry';
import { SmsMessageProvider } from './providers/sms-message.provider';
import { WhatsAppMessageProvider } from './providers/whatsapp-message.provider';
import { ResendCallbackService } from './resend-callback.service';
import { ResendWebhookController } from './resend-webhook.controller';
import { SmsService } from './sms.service';
import { AppointmentSubjectResolver } from './subjects/appointment-subject.resolver';
import { ClientSubjectResolver } from './subjects/client-subject.resolver';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppTemplateConfig } from './whatsapp-template.config';

/**
 * Outbound client messaging.
 *
 * {@link MessagingService} is the single send API: every message — booking confirmations, reminders,
 * rebooking nudges, campaigns and client-intelligence alerts — is queued through it, and it is the
 * only writer to `comms.notification_events`. What a queued message is *about* is resolved through
 * {@link NotificationSubjectRegistry}, so the same durable dispatcher, retry policy, delivery
 * logging and WhatsApp → SMS → Email fallback chain serve every kind of message.
 *
 * Also hosts the delivery-status surfaces: the Resend email delivery/bounce webhook
 * (`POST /api/email/status`), whose bounces feed {@link NotificationEscalationService}.
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
    AppointmentSubjectResolver,
    ClientSubjectResolver,
    NotificationSubjectRegistry,
    OptOutService,
    CommunicationSettingsService,
    MessagingService,
    NotificationEscalationService,
    BookingNotificationService,
    RebookingNudgeService,
    NotificationDispatchService,
    ResendCallbackService,
  ],
  exports: [
    CommunicationSettingsService,
    MessagingService,
    NotificationEscalationService,
    OptOutService,
    BookingNotificationService,
    RebookingNudgeService,
    WhatsAppService,
    MessageProviderRegistry,
  ],
})
export class CommunicationsModule {}
