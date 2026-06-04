import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { BookingNotificationService } from './booking-notification.service';
import { CommunicationSettingsService } from './communication-settings.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { SmsService } from './sms.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppTemplateConfig } from './whatsapp-template.config';

/**
 * Booking notifications: owner-configurable confirmation + reminder rules, a scheduling engine that
 * reconciles the `comms.notification_events` queue, and a background dispatcher that delivers due
 * events over WhatsApp (primary), SMS (fallback), or email (when the client prefers email) with full
 * message logging in `comms.message_logs`.
 *
 * Exports the settings + scheduling services so the owner settings API and the booking flow can drive
 * them; the dispatcher runs autonomously on a timer.
 */
@Module({
  imports: [EmailModule],
  providers: [
    WhatsAppService,
    SmsService,
    WhatsAppTemplateConfig,
    CommunicationSettingsService,
    BookingNotificationService,
    NotificationDispatchService,
  ],
  exports: [CommunicationSettingsService, BookingNotificationService, WhatsAppService],
})
export class CommunicationsModule {}
