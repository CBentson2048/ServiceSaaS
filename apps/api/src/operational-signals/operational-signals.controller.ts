import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, OperationalSignalReport } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DiarySignalsQueryDto, UpsertOperationalSignalSettingsDto } from './dto';
import {
  OperationalSignalsService,
  type ClientSignals,
  type DiarySignals,
  type OperationalSignalSettingsResponse,
} from './operational-signals.service';

/**
 * Client-level signals (spend trend, no-show risk).
 *
 * Gated on `crm.view` — whoever may open a client record may see the
 * intelligence about it. Access is NOT widened because the signals exist. The
 * service re-checks staff role and location scope independently, so a guard
 * change alone cannot turn this into a cross-tenant read.
 *
 * These are STAFF-ONLY. No public-booking or client-facing route exposes them:
 * a client must never receive "no-show risk: high" or "spend trend: falling".
 */
@Controller('clients/:clientId/signals')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('crm.view')
export class ClientSignalsController {
  constructor(private readonly signals: OperationalSignalsService) {}

  @Get()
  get(
    @CurrentUser() actor: AuthUser,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
  ): Promise<ClientSignals> {
    return this.signals.clientSignals(actor, clientId);
  }
}

/**
 * Diary-level signals (back-to-back colour, slot gaps) plus the per-appointment
 * no-show badges for the day.
 *
 * ONE call for a whole day's diary, never one per appointment. Gated on
 * `bookings.manage`, the same permission the diary itself uses.
 */
@Controller('diary/signals')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('bookings.manage')
export class DiarySignalsController {
  constructor(private readonly signals: OperationalSignalsService) {}

  @Get()
  get(@CurrentUser() actor: AuthUser, @Query() query: DiarySignalsQueryDto): Promise<DiarySignals> {
    return this.signals.diarySignals(actor, query.locationId, query.date);
  }
}

/**
 * The structured reporting roll-up, and the owner's sensitivity settings.
 *
 * Reporting is gated on `report.dashboard.view` — the existing key for business
 * reporting — rather than a new permission nobody would hold. Reads of the
 * settings are open to owner/manager so a manager can see the thresholds behind
 * a signal; the service restricts the WRITE to owners independently.
 */
@Controller('reports/operational-signals')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('report.dashboard.view')
export class OperationalSignalReportController {
  constructor(private readonly signals: OperationalSignalsService) {}

  @Get()
  report(
    @CurrentUser() actor: AuthUser,
    @Query() query: DiarySignalsQueryDto,
  ): Promise<OperationalSignalReport> {
    return this.signals.report(actor, query.locationId, query.date);
  }
}

@Controller('settings/operational-signals')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('settings.location.manage')
export class OperationalSignalSettingsController {
  constructor(private readonly signals: OperationalSignalsService) {}

  @Get()
  getSettings(@CurrentUser() actor: AuthUser): Promise<OperationalSignalSettingsResponse> {
    return this.signals.getSettings(actor);
  }

  /** PUT: the four threshold groups are set together as one scope. */
  @Put()
  upsert(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpsertOperationalSignalSettingsDto,
  ): Promise<OperationalSignalSettingsResponse> {
    return this.signals.upsertSettings(actor, body);
  }
}
