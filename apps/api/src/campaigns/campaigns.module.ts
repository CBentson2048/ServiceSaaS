import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignEvaluatorService } from './campaign-evaluator.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

/**
 * Campaign configuration & automated marketing (V1.1, Wrike 4507283957).
 *
 * DELIBERATELY A LEAF — and this is the mechanism behind Wrike section 35, not
 * just a comment about it. This module imports Auth, Audit and Communications,
 * and NO other module imports it. Booking, StaffBooking, PublicBooking, Bills,
 * Eod, Crm, Inventory and the Lab have no dependency on it, so campaign code
 * cannot execute inside a booking, a checkout or a bill. If every line here
 * threw, appointments would still be created and bills would still be settled.
 *
 * The dependency on CommunicationsModule is one-way and is the whole point:
 * campaigns CONSUME the existing messaging abstraction (MessagingService) rather
 * than becoming a second one. Nothing in this module talks to Twilio, Resend or
 * any other provider, opens a provider connection, or writes to
 * `comms.notification_events` directly.
 */
@Module({
  imports: [AuthModule, AuditModule, CommunicationsModule],
  controllers: [CampaignsController],
  providers: [CampaignAudienceService, CampaignEvaluatorService, CampaignsService],
})
export class CampaignsModule {}
