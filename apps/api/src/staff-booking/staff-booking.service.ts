import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  CreateStaffBookingRequest,
  CreateStaffBookingResponse,
  CrmClientSummary,
  ListCrmClientsResponse,
  PublicBookingAvailabilityResponse,
  PublicBookingServiceSelectionResponse,
  PublicBookingStylistsResponse,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { CrmService } from '../crm/crm.service';
import { PublicBookingService } from '../public-booking/public-booking.service';
import type {
  CreateStaffBookingDto,
  StaffBookingAvailabilityQueryDto,
  StaffBookingSelectionQueryDto,
  StaffBookingStylistsQueryDto,
} from './dto';

interface ClientScopeRow {
  id: string;
  primary_location_id: string | null;
}

/**
 * Internal, staff-facing booking workflow.
 *
 * This service deliberately holds NO booking-engine logic of its own. It owns
 * the staff-specific concerns — permissions, location scope, client selection /
 * quick-create — and then delegates to:
 *   - {@link PublicBookingService} for availability, multi-service duration
 *     stacking, conflict detection, and appointment persistence (the single
 *     source of truth shared with the public/client flow), and
 *   - {@link CrmService} for client search and quick-create.
 */
@Injectable()
export class StaffBookingService {
  private readonly logger = new Logger(StaffBookingService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly publicBooking: PublicBookingService,
    private readonly crm: CrmService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // --- Service / stylist / availability (reuses the public booking engine) ---

  // Staff bookings keep working even when public online booking is disabled,
  // so every engine read passes { allowOfflineBooking: true }.

  async getSelection(
    actor: AuthUser,
    query: StaffBookingSelectionQueryDto,
  ): Promise<PublicBookingServiceSelectionResponse> {
    this.assertLocationScope(actor, query.locationId);
    return this.publicBooking.getServiceSelection(
      { locationId: query.locationId },
      { allowOfflineBooking: true },
    );
  }

  async getStylists(
    actor: AuthUser,
    query: StaffBookingStylistsQueryDto,
  ): Promise<PublicBookingStylistsResponse> {
    this.assertLocationScope(actor, query.locationId);
    return this.publicBooking.getStylists(query, { allowOfflineBooking: true });
  }

  async getAvailability(
    actor: AuthUser,
    query: StaffBookingAvailabilityQueryDto,
  ): Promise<PublicBookingAvailabilityResponse> {
    this.assertLocationScope(actor, query.locationId);
    return this.publicBooking.getAvailability(query, { allowOfflineBooking: true });
  }

  // --- Client search / quick-create (reuses CRM, which enforces its own scope) ---

  async searchClients(
    actor: AuthUser,
    query: { q?: string; locationId?: string },
  ): Promise<ListCrmClientsResponse> {
    return this.crm.listClients(actor, query);
  }

  async createClient(
    actor: AuthUser,
    input: Parameters<CrmService['createClientForBooking']>[1],
  ): Promise<{ client: CrmClientSummary }> {
    return this.crm.createClientForBooking(actor, input);
  }

  // --- Booking creation ---

  async createBooking(
    actor: AuthUser,
    request: CreateStaffBookingRequest,
  ): Promise<CreateStaffBookingResponse> {
    this.assertLocationScope(actor, request.locationId);
    await this.assertClientInScope(actor, request.clientProfileId, request.locationId);
    const result = await this.publicBooking.createInternalBooking({
      businessId: actor.businessId,
      bookedByUserProfileId: actor.id,
      request,
    });

    await this.audit.record(actor, {
      action: 'booking.created',
      entityType: 'booking',
      entityId: result.appointment.id,
      locationId: result.appointment.locationId,
      after: {
        status: result.appointment.status,
        scheduledStartAt: result.appointment.scheduledStartAt,
        scheduledEndAt: result.appointment.scheduledEndAt,
        serviceIds: result.appointment.serviceIds,
        staffProfileId: result.appointment.staffProfileId,
      },
      metadata: {
        clientProfileId: request.clientProfileId,
        bookingSource: result.bookingSource,
        paymentMode: result.paymentMode,
      },
    });

    return result;
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }
  }

  /**
   * Ensures the staff member may book for this client. Owners can book any
   * client in the business; everyone else must either own the client's home
   * location, or be booking an unscoped client into a location they manage.
   */
  private async assertClientInScope(
    actor: AuthUser,
    clientProfileId: string,
    locationId: string,
  ): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,primary_location_id')
      .eq('id', clientProfileId)
      .eq('business_id', actor.businessId)
      .maybeSingle<ClientScopeRow>();

    if (error) {
      this.logger.error(`assertClientInScope lookup failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve client');
    }
    if (!data) throw new NotFoundException('Client not found');
    if (userHasRole(actor, 'owner')) return;
    if (data.primary_location_id && actor.allowedLocationIds.includes(data.primary_location_id)) return;
    if (!data.primary_location_id && actor.allowedLocationIds.includes(locationId)) return;
    throw new ForbiddenException('Client is outside your scope');
  }
}
