import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AbsenceMutationResponse,
  AuthUser,
  BookOutTypeMutationResponse,
  BreakMutationResponse,
  CreateNewWeekResponse,
  LeaveRequestMutationResponse,
  ListBookOutTypesResponse,
  ListLeaveRequestsResponse,
  MyLeaveRequestsResponse,
  PreviewNewWeekResponse,
  SaveWeeklyRotaResponse,
  ShiftMutationResponse,
  StylistMyWeekResponse,
  WeeklyRotaResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  ApproveLeaveRequestDto,
  CreateAbsenceDto,
  CreateBookOutTypeDto,
  CreateBreakDto,
  CreateMyLeaveRequestDto,
  CreateNewWeekDto,
  CreateShiftDto,
  GetWeeklyRotaQueryDto,
  ListLeaveRequestsQueryDto,
  PreviewNewWeekDto,
  RejectLeaveRequestDto,
  SaveWeeklyRotaDto,
  UpdateBookOutTypeDto,
  UpdateBreakDto,
  UpdateShiftDto,
} from './dto';
import { RotaService } from './rota.service';

/**
 * Manager-facing rota endpoints.
 *
 * Owners are accepted at the role guard level so the same backend can
 * serve a future owner rota UI without redesign. Stylist self-service
 * endpoints will live on a separate controller (e.g.
 * `StylistRotaController`) when implemented; the underlying RotaService
 * is already permission-aware so reuse will be minimal.
 */
@Controller('rota')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('rota.manage')
export class RotaController {
  constructor(private readonly rota: RotaService) {}

  @Get('week')
  @RequirePermissions('rota.view')
  getWeeklyRota(
    @CurrentUser() actor: AuthUser,
    @Query() query: GetWeeklyRotaQueryDto,
  ): Promise<WeeklyRotaResponse> {
    return this.rota.getWeeklyRota(actor, query.locationId, query.weekStart);
  }

  // -------------------- Shifts --------------------

  @Post('shifts')
  createShift(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateShiftDto,
  ): Promise<ShiftMutationResponse> {
    return this.rota.createShift(actor, body);
  }

  @Patch('shifts/:id')
  updateShift(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateShiftDto,
  ): Promise<ShiftMutationResponse> {
    return this.rota.updateShift(actor, id, body);
  }

  @Delete('shifts/:id')
  @HttpCode(200)
  deleteShift(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Query('pastEditReason') pastEditReason?: string,
  ): Promise<{ success: true }> {
    return this.rota.deleteShift(actor, id, pastEditReason);
  }

  // -------------------- Breaks --------------------

  @Post('shifts/:shiftId/breaks')
  addBreak(
    @CurrentUser() actor: AuthUser,
    @Param('shiftId') shiftId: string,
    @Body() body: CreateBreakDto,
  ): Promise<BreakMutationResponse> {
    return this.rota.addBreak(actor, shiftId, body);
  }

  @Patch('shifts/:shiftId/breaks/:breakId')
  updateBreak(
    @CurrentUser() actor: AuthUser,
    @Param('shiftId') shiftId: string,
    @Param('breakId') breakId: string,
    @Body() body: UpdateBreakDto,
  ): Promise<BreakMutationResponse> {
    return this.rota.updateBreak(actor, shiftId, breakId, body);
  }

  @Delete('shifts/:shiftId/breaks/:breakId')
  @HttpCode(200)
  deleteBreak(
    @CurrentUser() actor: AuthUser,
    @Param('shiftId') shiftId: string,
    @Param('breakId') breakId: string,
    @Query('pastEditReason') pastEditReason?: string,
  ): Promise<{ success: true }> {
    return this.rota.deleteBreak(actor, shiftId, breakId, pastEditReason);
  }

  // -------------------- Leave requests --------------------

  @Get('leave-requests')
  listLeaveRequests(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListLeaveRequestsQueryDto,
  ): Promise<ListLeaveRequestsResponse> {
    return this.rota.listLeaveRequests(actor, query.locationId, query.status);
  }

  @Post('leave-requests/:id/approve')
  @HttpCode(200)
  approveLeaveRequest(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: ApproveLeaveRequestDto,
  ): Promise<LeaveRequestMutationResponse> {
    return this.rota.approveLeaveRequest(actor, id, body);
  }

  @Post('leave-requests/:id/reject')
  @HttpCode(200)
  rejectLeaveRequest(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: RejectLeaveRequestDto,
  ): Promise<LeaveRequestMutationResponse> {
    return this.rota.rejectLeaveRequest(actor, id, body);
  }

  // -------------------- Absences --------------------

  @Post('absence-events')
  markAbsence(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateAbsenceDto,
  ): Promise<AbsenceMutationResponse> {
    return this.rota.markAbsence(actor, body);
  }

  // -------------------- Book Out Types (configurable block-out reasons) -----

  @Get('book-out-types')
  @RequirePermissions('rota.view')
  listBookOutTypes(@CurrentUser() actor: AuthUser): Promise<ListBookOutTypesResponse> {
    return this.rota.listBookOutTypes(actor);
  }

  @Post('book-out-types')
  createBookOutType(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateBookOutTypeDto,
  ): Promise<BookOutTypeMutationResponse> {
    return this.rota.createBookOutType(actor, body);
  }

  @Patch('book-out-types/:id')
  updateBookOutType(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateBookOutTypeDto,
  ): Promise<BookOutTypeMutationResponse> {
    return this.rota.updateBookOutType(actor, id, body);
  }

  @Delete('book-out-types/:id')
  @HttpCode(200)
  deleteBookOutType(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<{ success: true }> {
    return this.rota.deleteBookOutType(actor, id);
  }

  // -------------------------------------------------------------------------
  // New week generation
  // -------------------------------------------------------------------------

  @Post('weeks/preview')
  @HttpCode(200)
  previewNewWeek(
    @CurrentUser() actor: AuthUser,
    @Body() body: PreviewNewWeekDto,
  ): Promise<PreviewNewWeekResponse> {
    return this.rota.previewNewWeek(actor, body);
  }

  @Post('weeks/create')
  @HttpCode(200)
  createNewWeek(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateNewWeekDto,
  ): Promise<CreateNewWeekResponse> {
    return this.rota.createNewWeek(actor, body);
  }

  // -------------------- Optional bulk save --------------------

  @Post('week/save')
  @HttpCode(200)
  saveWeeklyRota(
    @CurrentUser() actor: AuthUser,
    @Body() body: SaveWeeklyRotaDto,
  ): Promise<SaveWeeklyRotaResponse> {
    return this.rota.saveWeeklyRota(actor, body);
  }
}

@Controller('rota')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('stylist')
export class StylistRotaController {
  constructor(private readonly rota: RotaService) {}

  @Get('my-week')
  getMyWeek(
    @CurrentUser() actor: AuthUser,
    @Query() query: GetWeeklyRotaQueryDto,
  ): Promise<StylistMyWeekResponse> {
    return this.rota.getMyWeek(actor, query.weekStart);
  }

  @Get('my-leave-requests')
  listMyLeaveRequests(@CurrentUser() actor: AuthUser): Promise<MyLeaveRequestsResponse> {
    return this.rota.listMyLeaveRequests(actor);
  }

  @Post('leave-requests')
  createMyLeaveRequest(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateMyLeaveRequestDto,
  ): Promise<LeaveRequestMutationResponse> {
    return this.rota.createMyLeaveRequest(actor, body);
  }

  @Post('leave-requests/:id/cancel')
  @HttpCode(200)
  cancelMyLeaveRequest(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<LeaveRequestMutationResponse> {
    return this.rota.cancelMyLeaveRequest(actor, id);
  }
}
