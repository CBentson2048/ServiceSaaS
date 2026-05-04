import { Module } from '@nestjs/common';
import { LabAppointmentsController } from './lab-appointments.controller';
import { LabAppointmentsService } from './lab-appointments.service';

@Module({
  controllers: [LabAppointmentsController],
  providers: [LabAppointmentsService],
})
export class LabAppointmentsModule {}
