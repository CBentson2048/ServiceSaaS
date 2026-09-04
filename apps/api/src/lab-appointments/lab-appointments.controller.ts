import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AcceptBookingResponse,
  AmendAppointmentServicesResponse,
  AppointmentServiceChangesResponse,
  AppointmentCompletionResponse,
  AppointmentPaymentConfirmationRequest,
  AppointmentPaymentConfirmationResponse,
  AuthUser,
  CancelAppointmentResponse,
  CheckInAppointmentResponse,
  ListStaffBookingsResponse,
  RejectBookingResponse,
  RescheduleAppointmentResponse,
  SheerLabAnalyticsRange,
  StaffBookingDetail,
  VisitBillResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabSessionService } from '../lab-session/lab-session.service';
import {
  AddAppointmentServiceDto,
  CancelAppointmentDto,
  CorrectNoShowDto,
  MarkNoShowDto,
  CreateStylistRebookingDto,
  LinkStylistRebookingDto,
  ReassignAppointmentServiceDto,
  RejectBookingDto,
  RemoveAppointmentServiceDto,
  RescheduleAppointmentDto,
} from './dto';
import { LabAppointmentsService } from './lab-appointments.service';

@Controller('lab/appointments')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('bookings.manage')
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

  /**
   * Mark a confirmed appointment as a no-show. The transition `no_show` has
   * always existed in the enum and been read across the product, but nothing
   * wrote it until now — see LabAppointmentsService.markNoShow.
   */
  @Post(':id/no-show')
  markNoShow(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: MarkNoShowDto,
  ): Promise<{ appointment: StaffBookingDetail }> {
    return this.labAppointmentsService.markNoShow(actor, id, body.reason);
  }

  /**
   * Undo an accidental no-show (Week 7). Manager authority, fully audited, and
   * it restores the status the appointment actually held rather than assuming
   * one. The original `booking.no_show` audit entry is left exactly as written.
   */
  @Post(':id/no-show/correct')
  correctNoShow(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CorrectNoShowDto,
  ): Promise<{ appointment: StaffBookingDetail }> {
    return this.labAppointmentsService.correctNoShow(actor, id, body.reason, body.restoreToStatus);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CancelAppointmentDto,
  ): Promise<CancelAppointmentResponse> {
    return this.labAppointmentsService.cancel(actor, id, body.reason, body.refundDeposit);
  }

  @Post(':id/reschedule')
  reschedule(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: RescheduleAppointmentDto,
  ): Promise<RescheduleAppointmentResponse> {
    return this.labAppointmentsService.reschedule(actor, id, body);
  }

  // ---------------------------------------------------------------------------
  // Post-check-in service lifecycle (0110). Line-level, never a replacement
  // array. Gated on its own permission on top of the controller's
  // bookings.manage — the method-level metadata overrides the class's, so both
  // keys are listed here. The service scopes stylists to their own column.
  // ---------------------------------------------------------------------------

  @Post(':id/services')
  @RequirePermissions('bookings.manage', 'bookings.services.modify_after_checkin')
  addService(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: AddAppointmentServiceDto,
  ): Promise<AmendAppointmentServicesResponse> {
    return this.labAppointmentsService.addService(actor, id, body);
  }

  @Post(':id/services/:lineId/remove')
  @RequirePermissions('bookings.manage', 'bookings.services.modify_after_checkin')
  removeService(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: RemoveAppointmentServiceDto,
  ): Promise<AmendAppointmentServicesResponse> {
    return this.labAppointmentsService.removeService(actor, id, lineId, body);
  }

  @Patch(':id/services/:lineId')
  @RequirePermissions('bookings.manage', 'bookings.services.modify_after_checkin')
  reassignService(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: ReassignAppointmentServiceDto,
  ): Promise<AmendAppointmentServicesResponse> {
    return this.labAppointmentsService.reassignService(actor, id, lineId, body);
  }

  /** Booked vs performed and the full change history — readable after payment. */
  @Get(':id/services/changes')
  serviceChanges(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<AppointmentServiceChangesResponse> {
    return this.labAppointmentsService.serviceChanges(actor, id);
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

  @Get('visits/:visitId/bill')
  visitBill(
    @CurrentUser() actor: AuthUser,
    @Param('visitId') visitId: string,
  ): Promise<VisitBillResponse> {
    return this.labAppointmentsService.visitBill(actor, visitId);
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

  // Formula-history feed: same per-chair scoping as /today, but accepts a range
  // (today | week | month) or an explicit from/to custom window.
  @Get(':sessionId/appointments')
  async appointments(
    @Param('sessionId') sessionId: string,
    @Query('range') range: SheerLabAnalyticsRange = 'today',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ListStaffBookingsResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.labAppointmentsService.appointmentsForLabSession(session, range, from, to);
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

/**
 * Customer-facing appointment management (mobile app). A signed-in client can
 * cancel or rebook (reschedule in place) their OWN upcoming appointment, subject
 * to the salon's per-location cancellation window. Ownership + window rules are
 * enforced in the service.
 */
@Controller('mobile/appointments')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('client')
export class MobileAppointmentsController {
  constructor(private readonly labAppointmentsService: LabAppointmentsService) {}

  @Post(':id/cancel')
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CancelAppointmentDto,
  ): Promise<CancelAppointmentResponse> {
    return this.labAppointmentsService.cancelForClient(actor, id, body.reason);
  }

  @Post(':id/reschedule')
  reschedule(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: RescheduleAppointmentDto,
  ): Promise<RescheduleAppointmentResponse> {
    return this.labAppointmentsService.rescheduleForClient(actor, id, body);
  }
}
