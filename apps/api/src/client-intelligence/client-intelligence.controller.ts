import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ClientLapseDetailResponse,
  ListClientLapseResponse,
  RetentionSettingsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ClientIntelligenceService } from './client-intelligence.service';
import { ListLapsedClientsQueryDto, UpsertRetentionSettingsDto } from './dto';

/**
 * Client Intelligence (V1.1 Week 7) — lapsed-client detection.
 *
 * Owner/manager only. Client intelligence exposes every client's cadence across
 * the whole business at once, which is a management view; existing CRM
 * permissions still gate it and stylist access is deliberately NOT widened just
 * because the intelligence now exists.
 *
 * Read-only apart from the retention-policy write. There is no all-client dump:
 * every list response is paginated and bounded by a lookback window.
 */
@Controller('crm/intelligence')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('crm.view')
export class ClientIntelligenceController {
  constructor(private readonly intelligence: ClientIntelligenceService) {}

  /**
   * Lapse status for clients with completed history in scope. Filterable by
   * status, location and representative service/category. A retention campaign
   * selects `?status=lapsed` — which already excludes anyone with a valid
   * upcoming appointment — and needs no cadence logic of its own.
   */
  @Get('lapsed')
  listLapsed(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListLapsedClientsQueryDto,
  ): Promise<ListClientLapseResponse> {
    return this.intelligence.listLapsedClients(actor, query);
  }

  /** The configured buffer: business-wide default plus any location overrides. */
  @Get('retention-settings')
  getRetentionSettings(@CurrentUser() actor: AuthUser): Promise<RetentionSettingsResponse> {
    return this.intelligence.getRetentionSettings(actor);
  }

  @Put('retention-settings')
  @RequirePermissions('crm.manage')
  upsertRetentionSettings(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpsertRetentionSettingsDto,
  ): Promise<RetentionSettingsResponse> {
    return this.intelligence.upsertRetentionSettings(actor, body);
  }

  /**
   * One client's lapse status with its full evidence trail. Declared last so the
   * literal `lapsed`/`retention-settings` segments win route matching.
   */
  @Get('clients/:clientId/lapse')
  getClientLapse(
    @CurrentUser() actor: AuthUser,
    @Param('clientId') clientId: string,
  ): Promise<ClientLapseDetailResponse> {
    return this.intelligence.getClientLapseStatus(actor, clientId);
  }
}
