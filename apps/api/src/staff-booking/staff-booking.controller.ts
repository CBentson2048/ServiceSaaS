import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  CreateStaffBookingResponse,
  CrmClientSummary,
  ListCrmClientsResponse,
  PublicBookingAvailabilityResponse,
  PublicBookingServiceSelectionResponse,
  PublicBookingStylistsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { LocationScopeGuard, RequireLocationScope } from '../auth/location-scope.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateCrmClientDto, ListCrmClientsQueryDto } from '../crm/dto';
import {
  CreateStaffBookingDto,
  StaffBookingAvailabilityQueryDto,
  StaffBookingSelectionQueryDto,
  StaffBookingStylistsQueryDto,
} from './dto';
import { StaffBookingService } from './staff-booking.service';

/**
 * Internal staff booking surface. Mounted under `/staff/booking` and gated to
 * staff roles only (clients can never reach it). Owner/manager/stylist can read
 * services + availability and create bookings within their location scope;
 * quick-creating a client is further restricted to owner/manager by CrmService.
 *
 * Location scope is enforced server-side by the LocationScopeGuard (on routes
 * carrying `locationId`) and re-asserted in the service — never relying on the
 * frontend to hide the feature.
 */
@Controller('staff/booking')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard, LocationScopeGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('bookings.manage')
export class StaffBookingController {
  constructor(private readonly staffBooking: StaffBookingService) {}

  @Get('selection')
  @RequireLocationScope('locationId')
  getSelection(
    @CurrentUser() actor: AuthUser,
    @Query() query: StaffBookingSelectionQueryDto,
  ): Promise<PublicBookingServiceSelectionResponse> {
    return this.staffBooking.getSelection(actor, query);
  }

  @Get('stylists')
  @RequireLocationScope('locationId')
  getStylists(
    @CurrentUser() actor: AuthUser,
    @Query() query: StaffBookingStylistsQueryDto,
  ): Promise<PublicBookingStylistsResponse> {
    return this.staffBooking.getStylists(actor, query);
  }

  @Get('availability')
  @RequireLocationScope('locationId')
  getAvailability(
    @CurrentUser() actor: AuthUser,
    @Query() query: StaffBookingAvailabilityQueryDto,
  ): Promise<PublicBookingAvailabilityResponse> {
    return this.staffBooking.getAvailability(actor, query);
  }

  @Get('clients')
  @RequirePermissions('bookings.manage', 'crm.view')
  searchClients(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListCrmClientsQueryDto,
  ): Promise<ListCrmClientsResponse> {
    return this.staffBooking.searchClients(actor, query);
  }

  @Post('clients')
  @RequirePermissions('bookings.manage', 'crm.manage')
  createClient(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateCrmClientDto,
  ): Promise<{ client: CrmClientSummary }> {
    return this.staffBooking.createClient(actor, body);
  }

  @Post('appointments')
  @RequireLocationScope('locationId')
  createBooking(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateStaffBookingDto,
  ): Promise<CreateStaffBookingResponse> {
    return this.staffBooking.createBooking(actor, body);
  }
}
