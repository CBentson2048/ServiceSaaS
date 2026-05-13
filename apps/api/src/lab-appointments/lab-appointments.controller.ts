import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, ListStaffBookingsResponse, StaffBookingDetail } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabAppointmentsService } from './lab-appointments.service';

@Controller('lab/appointments')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager', 'stylist')
export class LabAppointmentsController {
  constructor(private readonly labAppointmentsService: LabAppointmentsService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query('locationId') locationId?: string,
  ): Promise<ListStaffBookingsResponse> {
    return this.labAppointmentsService.list(actor, locationId);
  }

  @Get('today')
  today(
    @CurrentUser() actor: AuthUser,
    @Query('locationId') locationId?: string,
  ): Promise<ListStaffBookingsResponse> {
    return this.labAppointmentsService.today(actor, locationId);
  }

  @Get(':id')
  detail(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<StaffBookingDetail> {
    return this.labAppointmentsService.detail(actor, id);
  }
}
