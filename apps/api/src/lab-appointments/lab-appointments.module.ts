import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { OwnerTaxSettingsModule } from '../owner-tax-settings/owner-tax-settings.module';
import { RebookingModule } from '../rebooking/rebooking.module';
import { LabAppointmentsController, LabSessionAppointmentsController } from './lab-appointments.controller';
import { LabAppointmentsService } from './lab-appointments.service';

@Module({
  imports: [AuthModule, LabSessionModule, RebookingModule, OwnerTaxSettingsModule, CommunicationsModule],
  controllers: [LabAppointmentsController, LabSessionAppointmentsController],
  providers: [LabAppointmentsService],
})
export class LabAppointmentsModule {}
