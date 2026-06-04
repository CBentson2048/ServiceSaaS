import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { TwilioCallbackService } from './twilio-callback.service';
import { TwilioController } from './twilio.controller';

/**
 * Twilio webhook surface: delivery-status callbacks and inbound WhatsApp replies. Reuses the
 * {@link WhatsAppService} (exported by CommunicationsModule) for auth-token-backed signature
 * verification — there is a single source of Twilio credentials.
 */
@Module({
  imports: [CommunicationsModule],
  controllers: [TwilioController],
  providers: [TwilioCallbackService],
})
export class TwilioModule {}
