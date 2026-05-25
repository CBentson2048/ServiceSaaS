import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { LabAppointmentsController, LabSessionAppointmentsController } from './lab-appointments.controller';
import { LabAppointmentsService } from './lab-appointments.service';

@Module({
  imports: [AuthModule, LabSessionModule],
  controllers: [LabAppointmentsController, LabSessionAppointmentsController],
  providers: [LabAppointmentsService],
})
export class LabAppointmentsModule {}
