import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AcceptBookingResponse,
  AppointmentCompletionResponse,
  AppointmentPaymentConfirmationRequest,
  AppointmentPaymentConfirmationResponse,
  AuthUser,
  CancelAppointmentResponse,
  CheckInAppointmentResponse,
  ListStaffBookingsResponse,
  RejectBookingResponse,
  RescheduleAppointmentResponse,
  StaffBookingDetail,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabSessionService } from '../lab-session/lab-session.service';
import {
  CancelAppointmentDto,
  CreateStylistRebookingDto,
  LinkStylistRebookingDto,
  RejectBookingDto,
  RescheduleAppointmentDto,
} from './dto';
import { LabAppointmentsService } from './lab-appointments.service';

@Controller('lab/appointments')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager', 'stylist')
export class LabAppointmentsController {
  constructor(
    private readonly labAppointmentsService: LabAppointmentsService,
    private readonly labSessionService: LabSessionService,
  ) {}

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

  @Post(':id/accept')
  accept(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<AcceptBookingResponse> {
    return this.labAppointmentsService.accept(actor, id);
  }

  @Post(':id/reject')
  reject(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: RejectBookingDto,
  ): Promise<RejectBookingResponse> {
    return this.labAppointmentsService.reject(actor, id, body.reason);
  }

  @Post(':id/check-in')
  checkIn(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<CheckInAppointmentResponse> {
    return this.labAppointmentsService.checkIn(actor, id);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CancelAppointmentDto,
  ): Promise<CancelAppointmentResponse> {
    return this.labAppointmentsService.cancel(actor, id, body.reason);
  }

  @Post(':id/reschedule')
  reschedule(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: RescheduleAppointmentDto,
  ): Promise<RescheduleAppointmentResponse> {
    return this.labAppointmentsService.reschedule(actor, id, body);
  }

  @Post(':id/complete')
  complete(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<AppointmentCompletionResponse> {
    return this.labAppointmentsService.complete(actor, id);
  }

  @Post(':id/confirm-payment')
  confirmPayment(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: AppointmentPaymentConfirmationRequest,
  ): Promise<AppointmentPaymentConfirmationResponse> {
    return this.labAppointmentsService.confirmPayment(actor, id, body);
  }

  @Post(':id/rebooking')
  createRebooking(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CreateStylistRebookingDto,
  ): Promise<AppointmentCompletionResponse> {
    return this.labAppointmentsService.createStylistRebooking(actor, id, body);
  }

  @Post(':id/rebooking/link')
  linkRebooking(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: LinkStylistRebookingDto,
  ): Promise<AppointmentCompletionResponse> {
    return this.labAppointmentsService.linkStylistRebooking(actor, id, body);
  }
}

@Controller('lab/appointments/session')
export class LabSessionAppointmentsController {
  constructor(
    private readonly labAppointmentsService: LabAppointmentsService,
    private readonly labSessionService: LabSessionService,
  ) {}

  @Get(':sessionId/today')
  async today(@Param('sessionId') sessionId: string): Promise<ListStaffBookingsResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.labAppointmentsService.todayForLabSession(session);
  }

  @Get(':sessionId/:id')
  async detail(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<StaffBookingDetail> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.labAppointmentsService.detailForLabSession(session, id);
  }
}
