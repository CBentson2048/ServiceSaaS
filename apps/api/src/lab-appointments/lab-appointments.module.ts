import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabAppointmentsController } from './lab-appointments.controller';
import { LabAppointmentsService } from './lab-appointments.service';

@Module({
  imports: [AuthModule],
  controllers: [LabAppointmentsController],
  providers: [LabAppointmentsService],
})
export class LabAppointmentsModule {}
