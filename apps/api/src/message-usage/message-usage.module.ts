import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MessageUsageController } from './message-usage.controller';
import { MessageUsageRecoveryService } from './message-usage-recovery.service';
import { MessageUsageService } from './message-usage.service';

/**
 * Tier-based message usage accounting (V1.1, Wrike 4507284256).
 *
 * Imports Auth only, and is imported by CommunicationsModule so the dispatcher
 * can record usage at its single "provider accepted" transition. That one-way
 * edge is what makes the layer platform-wide: campaigns, booking confirmations,
 * reminders and rebooking nudges all consume the allowance without importing
 * this module or knowing it exists.
 *
 * Also hosts MessageUsageRecoveryService, the timer that repairs accounting gaps
 * for messages a provider already accepted. It is a provider, not an export:
 * nothing outside this module may reach into it, and because Nest caches module
 * instances, the fact that both AppModule and CommunicationsModule import this
 * module still yields exactly one timer per process.
 */
@Module({
  imports: [AuthModule],
  controllers: [MessageUsageController],
  providers: [MessageUsageService, MessageUsageRecoveryService],
  exports: [MessageUsageService],
})
export class MessageUsageModule {}
