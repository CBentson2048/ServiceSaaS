import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { CommunicationsModule } from '../communications/communications.module';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OwnerTaxSettingsModule } from '../owner-tax-settings/owner-tax-settings.module';
import { RebookingModule } from '../rebooking/rebooking.module';
import { StripeModule } from '../stripe/stripe.module';
import {
  LabAppointmentsController,
  LabSessionAppointmentsController,
  MobileAppointmentsController,
} from './lab-appointments.controller';
import { LabAppointmentsService } from './lab-appointments.service';

@Module({
  imports: [AuthModule, AuditModule, LabSessionModule, RebookingModule, OwnerTaxSettingsModule, CommunicationsModule, StripeModule, NotificationsModule],
  controllers: [LabAppointmentsController, LabSessionAppointmentsController, MobileAppointmentsController],
  providers: [LabAppointmentsService],
  exports: [LabAppointmentsService],
})
export class LabAppointmentsModule {}
