import { Controller, Get, Param, Query } from '@nestjs/common';
import { LabAppointmentsService } from './lab-appointments.service';

@Controller('lab/appointments')
export class LabAppointmentsController {
  constructor(private readonly labAppointmentsService: LabAppointmentsService) {}

  @Get('today')
  today(@Query('locationId') locationId?: string) {
    return this.labAppointmentsService.today(locationId);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.labAppointmentsService.detail(id);
  }
}
