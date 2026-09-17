import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  decodeReportFilter,
  isWeekStartDay,
  reportLocationIds,
  type ReportDefinition,
  type ReportLocationOption,
  type ReportOptions,
  type ResolvedReportFilter,
  type WeekStartDay,
} from '@sheer/domain';
import { isSupportedTimeZone } from '../payroll/period-dates';
import type { ReportActor } from './report-actor';
import { reportHttpError } from './report-errors';
import { isWeekPreset, resolveReportWindows, type ReportLocationWindow } from './report-window';
import type { ReportResultQueryDto } from './dto';

interface LocationRow {
  id: string;
  name: string;
  timezone: string;
  is_active: boolean;
}

/**
 * A resolved report request: who is asking, for which report, over which
 * locations and windows.
 *
 * PROVIDER INVARIANT — every report service built on a scope (Tickets B–F):
 * - every fact belongs to one of `windows[i].locationId` and lies inside that
 *   location's `[fromUtc, toUtcExclusive)` (or `[from, to]` for date columns);
 *   there is no envelope window;
 * - a `not_started` window, and any day after that location's `localToday`, is
 *   rendered as not started, never as 0 or £0.00;
 * - sub-gates (e.g. commission) check per-grant locations, never
 *   `allowedLocationIds` or merged `permissions` — neither is on the actor.
 * docs/V1.1/week-8-ticket-a-foundation.md §4.
 */
export interface ReportScope {
  actor: ReportActor;
  definition: ReportDefinition;
  asOf: Date;
  resolved: ResolvedReportFilter;
  /** One per resolved location, in the same order as `resolved.locations`. */
  windows: readonly ReportLocationWindow[];
}

/**
 * Resolves report options and report scopes. Read-only: it SELECTs locations and
 * the business week start, and never writes (in particular it never goes
 * through PayrollInputsService.loadSettings, which inserts a settings row).
 */
@Injectable()
export class ReportScopeService {
  private readonly logger = new Logger(ReportScopeService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Every location the actor may report on for this report, plus the business
   * week start. Takes no selection, so it cannot refuse one; an actor with no
   * permitted location still gets `report_no_locations_in_scope`.
   */
  async options(actor: ReportActor, definition: ReportDefinition): Promise<ReportOptions> {
    const [locations, weekStartDay] = await Promise.all([
      this.permittedLocations(actor, definition),
      this.readWeekStartDay(actor.businessId),
    ]);
    return {
      reportKey: definition.key,
      locations: locations.map(toOption),
      weekStartDay,
    };
  }

  /** Resolve a result request. Refusals are typed; database failures are 500s. */
  async resolve(
    actor: ReportActor,
    definition: ReportDefinition,
    query: ReportResultQueryDto,
    asOf: Date,
  ): Promise<ReportScope> {
    // 1. The only validator of meaning.
    const { filter, issues } = decodeReportFilter(queryParams(query), definition, 'strict');
    if (issues.some((issue) => issue.code === 'control_not_supported')) {
      throw reportHttpError('report_control_not_supported', { issues });
    }
    if (issues.length > 0) {
      throw reportHttpError('report_filter_invalid', { issues });
    }

    // 2–3. Permitted locations for this report, in the business's order.
    const permitted = await this.permittedLocations(actor, definition);

    // 4. An explicit selection must be wholly permitted; [] means all permitted.
    let selected = permitted;
    if (filter.locationIds.length > 0) {
      const byId = new Map(permitted.map((location) => [location.id, location]));
      if (filter.locationIds.some((id) => !byId.has(id))) {
        throw reportHttpError('report_location_out_of_scope');
      }
      const requested = new Set(filter.locationIds);
      selected = permitted.filter((location) => requested.has(location.id));
    }

    // 5. Every resolved location must have a convertible timezone.
    const invalid = selected.filter((location) => !isSupportedTimeZone(location.timezone));
    if (invalid.length > 0) {
      throw reportHttpError('report_timezone_invalid', { locationIds: invalid.map((location) => location.id) });
    }

    // 6. Week presets only: the business's own week start, never a default.
    let weekStartDay: WeekStartDay | null = null;
    if (isWeekPreset(filter.preset)) {
      weekStartDay = await this.readWeekStartDay(actor.businessId);
      if (weekStartDay === null) {
        throw reportHttpError('report_week_start_unconfigured');
      }
    }

    // 7. One window per location, from one instant.
    const windows = resolveReportWindows(selected, filter, asOf, weekStartDay);
    const resolved: ResolvedReportFilter = {
      reportKey: definition.key,
      filter,
      weekStartDay,
      locations: selected.map((location, index) => {
        const window = windows[index];
        return {
          ...toOption(location),
          localToday: window.localToday,
          from: window.from,
          to: window.to,
          status: window.status,
        };
      }),
    };
    return { actor, definition, asOf, resolved, windows };
  }

  /** The business's locations the actor may report on; 403 when there are none. */
  private async permittedLocations(
    actor: ReportActor,
    definition: ReportDefinition,
  ): Promise<LocationRow[]> {
    const locations = await this.readBusinessLocations(actor.businessId);
    const permittedIds = new Set(
      reportLocationIds(actor, definition, locations.map((location) => location.id)),
    );
    const permitted = locations.filter((location) => permittedIds.has(location.id));
    if (permitted.length === 0) {
      throw reportHttpError('report_no_locations_in_scope');
    }
    return permitted;
  }

  /** Every location of the business, inactive included, in the business's own order. */
  private async readBusinessLocations(businessId: string): Promise<LocationRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,timezone,is_active')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .returns<LocationRow[]>();
    if (error) {
      this.logger.error(`Report locations read failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load report locations');
    }
    return data ?? [];
  }

  /**
   * `payroll.payroll_settings.week_start_day`, or `null` when the business has
   * no row or an unusable value. A read failure is a 500 — never "missing".
   */
  private async readWeekStartDay(businessId: string): Promise<WeekStartDay | null> {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('payroll_settings')
      .select('week_start_day')
      .eq('business_id', businessId)
      .maybeSingle<{ week_start_day: unknown }>();
    if (error) {
      this.logger.error(`Report week start read failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load the business week start');
    }
    const value = data?.week_start_day;
    return isWeekStartDay(value) ? value : null;
  }
}

function toOption(location: LocationRow): ReportLocationOption {
  return {
    id: location.id,
    name: location.name,
    timezone: location.timezone,
    isActive: location.is_active,
    timezoneValid: isSupportedTimeZone(location.timezone),
  };
}

/** The DTO's raw strings, keyed as the codec reads them. */
function queryParams(query: ReportResultQueryDto): Record<string, string | undefined> {
  return {
    preset: query.preset,
    from: query.from,
    to: query.to,
    locations: query.locations,
    staff: query.staff,
    view: query.view,
  };
}
