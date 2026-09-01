import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ClientFormulaChangeResponse,
  FormulaChangeSettingsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { UpsertFormulaChangeSettingsDto } from './dto';
import { FormulaChangeService } from './formula-change.service';

/**
 * Formula change detection for one client.
 *
 * Gated on `crm.view` — whoever may open a client record may see the
 * intelligence about it. The service independently re-applies the SAME scoping
 * `LabFormulaService.historyForClient` uses (client sees only themselves, owner
 * sees the business, everyone else is bounded to their locations) and validates
 * the client id against the acting business, so a guard change alone cannot turn
 * this into a cross-tenant read.
 *
 * The assessment is also embedded in the CRM client detail and Colour Prep
 * payloads. This endpoint exists for the "refresh just the flag" case, and it is
 * strictly read-only.
 */
@Controller('clients/:clientId/formula-change')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('crm.view')
export class ClientFormulaChangeController {
  constructor(private readonly formulaChange: FormulaChangeService) {}

  @Get()
  async get(
    @CurrentUser() actor: AuthUser,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
  ): Promise<ClientFormulaChangeResponse> {
    return {
      clientProfileId: clientId,
      assessment: await this.formulaChange.assessForClient(actor, clientId),
    };
  }
}

/**
 * Owner configuration of sensitivity.
 *
 * Gated on `settings.location.manage` — the existing permission for location
 * record settings and thresholds, which is what this is. Reads are open to
 * owner/manager so a manager can see the thresholds behind a flag; the service
 * restricts the WRITE to owners independently.
 */
@Controller('settings/formula-change')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('settings.location.manage')
export class FormulaChangeSettingsController {
  constructor(private readonly formulaChange: FormulaChangeService) {}

  @Get()
  getSettings(@CurrentUser() actor: AuthUser): Promise<FormulaChangeSettingsResponse> {
    return this.formulaChange.getSettings(actor);
  }

  /** PUT, not PATCH: the three thresholds are set together as one scope. */
  @Put()
  upsert(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpsertFormulaChangeSettingsDto,
  ): Promise<FormulaChangeSettingsResponse> {
    return this.formulaChange.upsertSettings(actor, body);
  }
}
