import {
  BadRequestException,
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
  CampaignAudiencePreview,
  CampaignChannel,
  CampaignConfig,
  CampaignDetail,
  CampaignRunSummary,
  CampaignStatus,
  CampaignTotals,
  CampaignType,
} from '@sheer/domain';
import {
  DEFAULT_CAMPAIGN_SEND_HOUR,
  userHasPermission,
  userHasRole,
  validateCampaignConfig,
  validateCampaignTemplate,
} from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { CampaignEvaluatorService, salonNow } from './campaign-evaluator.service';
import { CAMPAIGN_COLUMNS, type CampaignRow } from './campaign-row';
import type {
  CreateCampaignDto,
  ListCampaignRunsQueryDto,
  ListCampaignsQueryDto,
  UpdateCampaignDto,
} from './dto';

/**
 * Owner configuration of marketing campaigns.
 *
 * PERMISSIONS (Wrike section 7). Campaigns decide who the salon messages, which
 * makes them sensitive business configuration, so this uses the EXISTING model
 * rather than inventing one: `owner` role plus `settings.booking.manage` — the
 * permission that already means "edit online booking and notification settings".
 * Managers, stylists and reception do not hold the owner role, so they reach
 * none of this; a client never can. The controller gates on the same pair, and
 * this service re-checks independently so a future controller change cannot
 * quietly widen access.
 *
 * TENANCY (Wrike section 44). `businessId` comes from the authenticated context
 * and is never accepted from the browser. A supplied `locationId` is verified to
 * belong to the acting business before it is stored, and every read and write is
 * filtered on `business_id`, so a campaign in business A can never resolve an
 * audience in business B.
 *
 * AUDIT (Wrike section 31). Create, edit, status change and archive all record
 * through the shared `AuditService` into `audit.activity_log`. No second audit
 * framework.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
    private readonly evaluator: CampaignEvaluatorService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(actor: AuthUser, query: ListCampaignsQueryDto): Promise<{ campaigns: CampaignDetail[] }> {
    this.assertCampaignAccess(actor);

    let request = this.admin
      .schema('comms')
      .from('campaigns')
      .select(CAMPAIGN_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('created_at', { ascending: false });

    if (query.locationId) request = request.eq('location_id', query.locationId);
    if (query.campaignType) request = request.eq('campaign_type', query.campaignType);
    // Archived campaigns are kept forever (their send history must stay
    // explicable) but they are noise in the default list.
    if (query.includeArchived !== 'true') request = request.neq('status', 'archived');

    const { data, error } = await request.returns<Omit<CampaignRow, 'timezone'>[]>();
    if (error) {
      this.logger.error(`list campaigns failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load campaigns');
    }

    const rows = data ?? [];
    if (rows.length === 0) return { campaigns: [] };

    const [timezones, locationNames, totals] = await Promise.all([
      this.evaluator.resolveTimezones(rows),
      this.fetchLocationNames(actor.businessId),
      this.fetchTotals(rows.map((row) => row.id)),
    ]);

    return {
      campaigns: rows.map((row) =>
        this.toDetail(
          { ...row, timezone: timezones.get(`${row.business_id}:${row.location_id ?? ''}`) ?? 'Europe/London' },
          locationNames,
          totals.get(row.id),
        ),
      ),
    };
  }

  async get(actor: AuthUser, campaignId: string): Promise<{ campaign: CampaignDetail }> {
    this.assertCampaignAccess(actor);
    const row = await this.fetchForActor(actor, campaignId);
    const [locationNames, totals] = await Promise.all([
      this.fetchLocationNames(actor.businessId),
      this.fetchTotals([row.id]),
    ]);
    return { campaign: this.toDetail(row, locationNames, totals.get(row.id)) };
  }

  /**
   * The audience preview (Wrike sections 33, 34).
   *
   * Delegates straight to the evaluator's `preview`, which calls the SAME
   * audience resolver a real run calls. There is deliberately no second preview
   * implementation that could drift from production behaviour, and the whole
   * path is read-only — nothing is claimed, queued or sent.
   */
  async previewAudience(actor: AuthUser, campaignId: string): Promise<CampaignAudiencePreview> {
    this.assertCampaignAccess(actor);
    const row = await this.fetchForActor(actor, campaignId);
    try {
      return await this.evaluator.preview(row);
    } catch (err) {
      this.logger.error(`preview campaign ${campaignId} failed: ${(err as Error).message}`);
      throw new InternalServerErrorException('Unable to preview this campaign audience');
    }
  }

  async listRuns(
    actor: AuthUser,
    campaignId: string,
    query: ListCampaignRunsQueryDto,
  ): Promise<{ runs: CampaignRunSummary[] }> {
    this.assertCampaignAccess(actor);
    await this.fetchForActor(actor, campaignId); // tenancy check

    const { data, error } = await this.admin
      .schema('comms')
      .from('campaign_runs')
      .select(
        'id,campaign_id,run_local_date,status,started_at,completed_at,candidate_count,eligible_count,' +
          'queued_count,suppressed_count,failed_count,suppression_breakdown,error_message',
      )
      .eq('campaign_id', campaignId)
      .eq('business_id', actor.businessId)
      .order('run_local_date', { ascending: false })
      .limit(query.limit ?? 30)
      .returns<CampaignRunRow[]>();

    if (error) {
      this.logger.error(`list campaign runs failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load campaign history');
    }

    return {
      runs: (data ?? []).map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        runLocalDate: row.run_local_date,
        status: row.status as CampaignRunSummary['status'],
        startedAt: row.started_at,
        completedAt: row.completed_at,
        candidateCount: Number(row.candidate_count),
        eligibleCount: Number(row.eligible_count),
        queuedCount: Number(row.queued_count),
        suppressedCount: Number(row.suppressed_count),
        failedCount: Number(row.failed_count),
        suppressionBreakdown: (row.suppression_breakdown ?? {}) as Record<string, number>,
        errorMessage: row.error_message,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Create a campaign. ALWAYS as a draft (Wrike section 32): the owner has not
   * seen the audience preview yet, and saving a form must never send anything.
   * Activation is a separate, explicit call.
   */
  async create(actor: AuthUser, input: CreateCampaignDto): Promise<{ campaign: CampaignDetail }> {
    this.assertCampaignAccess(actor);

    const locationId = input.locationId ?? null;
    if (locationId) await this.assertLocationBelongsToBusiness(actor.businessId, locationId);

    this.assertTemplate(input.messageTemplate);
    this.assertConfig(input.campaignType, input.config);

    const { data, error } = await this.admin
      .schema('comms')
      .from('campaigns')
      .insert({
        business_id: actor.businessId,
        location_id: locationId,
        campaign_type: input.campaignType,
        name: input.name.trim(),
        status: 'draft',
        channel: input.channel ?? 'auto',
        message_template: input.messageTemplate.trim(),
        message_subject: input.messageSubject?.trim() || null,
        send_at_local_hour: input.sendAtLocalHour ?? DEFAULT_CAMPAIGN_SEND_HOUR,
        config: input.config,
        created_by_user_profile_id: actor.id,
      })
      .select(CAMPAIGN_COLUMNS)
      .maybeSingle<Omit<CampaignRow, 'timezone'>>();

    if (error) {
      if (isUniqueViolation(error)) {
        throw new BadRequestException('A campaign of this type already exists with that name in this scope');
      }
      this.logger.error(`create campaign failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to create the campaign');
    }
    if (!data) throw new InternalServerErrorException('Unable to create the campaign');

    await this.audit.record(actor, {
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: data.id,
      locationId,
      after: this.auditShape(data),
    });

    return this.get(actor, data.id);
  }

  /**
   * Edit a campaign.
   *
   * Only fields that are `!== undefined` are applied. DTO instances carry every
   * declared field as an own (undefined) property, so testing with `in` would
   * null whatever the caller omitted.
   *
   * Editing does NOT reset anybody's send identity (Wrike section 27): the
   * identity keys are derived from the campaign id and the client's opportunity,
   * never from the message text or the config. Changing the wording therefore
   * cannot re-message someone who has already had it.
   */
  async update(
    actor: AuthUser,
    campaignId: string,
    input: UpdateCampaignDto,
  ): Promise<{ campaign: CampaignDetail }> {
    this.assertCampaignAccess(actor);
    const existing = await this.fetchForActor(actor, campaignId);

    if (existing.status === 'archived') {
      throw new BadRequestException('An archived campaign cannot be edited');
    }

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['name'] = input.name.trim();
    if (input.channel !== undefined) patch['channel'] = input.channel;
    if (input.sendAtLocalHour !== undefined) patch['send_at_local_hour'] = input.sendAtLocalHour;
    if (input.messageSubject !== undefined) patch['message_subject'] = input.messageSubject?.trim() || null;

    if (input.messageTemplate !== undefined) {
      this.assertTemplate(input.messageTemplate);
      patch['message_template'] = input.messageTemplate.trim();
    }
    if (input.config !== undefined) {
      this.assertConfig(existing.campaign_type as CampaignType, input.config);
      patch['config'] = input.config;
    }
    if (input.locationId !== undefined) {
      const locationId = input.locationId ?? null;
      if (locationId) await this.assertLocationBelongsToBusiness(actor.businessId, locationId);
      patch['location_id'] = locationId;
    }

    if (Object.keys(patch).length === 0) return this.get(actor, campaignId);

    const { error } = await this.admin
      .schema('comms')
      .from('campaigns')
      .update(patch)
      .eq('id', campaignId)
      .eq('business_id', actor.businessId);

    if (error) {
      if (isUniqueViolation(error)) {
        throw new BadRequestException('A campaign of this type already exists with that name in this scope');
      }
      this.logger.error(`update campaign ${campaignId} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update the campaign');
    }

    await this.audit.record(actor, {
      action: 'campaign.updated',
      entityType: 'campaign',
      entityId: campaignId,
      locationId: (patch['location_id'] as string | null) ?? existing.location_id,
      before: this.auditShape(existing),
      after: { ...this.auditShape(existing), ...patch },
    });

    return this.get(actor, campaignId);
  }

  /**
   * Enable / disable / archive (Wrike section 28).
   *
   * DISABLE SEMANTICS, stated once and implemented once:
   *   - The campaign is no longer evaluated, so it creates NO new message events
   *     from the moment the status changes. That is the guarantee.
   *   - Messages ALREADY queued into `comms.notification_events` are NOT
   *     retracted. They are committed sends that the dispatcher owns, and every
   *     one of them still re-checks marketing consent and opt-out at send time.
   *     Reaching into another module's queue to cancel rows would give campaigns
   *     write access to the shared messaging queue, which is exactly the
   *     coupling this design avoids.
   *   - In practice the exposure is a single evaluation batch: the evaluator
   *     queues at the salon-local send hour with `scheduled_for = now`, so the
   *     dispatcher picks them up within its own poll interval rather than
   *     sitting on a backlog for days.
   */
  async setStatus(
    actor: AuthUser,
    campaignId: string,
    status: CampaignStatus,
  ): Promise<{ campaign: CampaignDetail }> {
    this.assertCampaignAccess(actor);
    const existing = await this.fetchForActor(actor, campaignId);

    if (existing.status === status) return this.get(actor, campaignId);
    if (existing.status === 'archived') {
      throw new BadRequestException('An archived campaign cannot be reactivated — copy it instead');
    }

    // Activation is the moment a campaign becomes able to message people. Both
    // the template and the config are re-validated here, so a draft saved before
    // a bounds change cannot go live with a shape the evaluator would reject
    // mid-run.
    if (status === 'active') {
      this.assertTemplate(existing.message_template);
      this.assertConfig(existing.campaign_type as CampaignType, existing.config ?? {});
    }

    const { error } = await this.admin
      .schema('comms')
      .from('campaigns')
      .update({ status })
      .eq('id', campaignId)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`set campaign ${campaignId} status failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to change the campaign status');
    }

    await this.audit.record(actor, {
      action: `campaign.${status === 'active' ? 'enabled' : status === 'archived' ? 'archived' : 'disabled'}`,
      entityType: 'campaign',
      entityId: campaignId,
      locationId: existing.location_id,
      before: { status: existing.status },
      after: { status },
    });

    return this.get(actor, campaignId);
  }

  /**
   * Run this campaign now, if it is due.
   *
   * An owner-triggered evaluation, not a bypass: it goes through exactly the
   * same `runCampaign` the timer uses, so the once-per-local-day run guard, the
   * per-identity claim, consent, opt-out and the channel plan all still apply.
   * Pressing it twice queues nothing extra.
   *
   * Returns immediately after queueing — delivery is the dispatcher's, and no
   * API request is ever held open while messages go out (Wrike section 38).
   */
  async runNow(actor: AuthUser, campaignId: string): Promise<{ run: CampaignRunSummary | null; message: string }> {
    this.assertCampaignAccess(actor);
    const campaign = await this.fetchForActor(actor, campaignId);

    if (campaign.status !== 'active') {
      throw new BadRequestException('Only an active campaign can be run — enable it first');
    }

    const { localDate } = salonNow(campaign.timezone);
    try {
      const outcome = await this.evaluator.runCampaign(campaign, localDate);
      if (!outcome) {
        return { run: null, message: `This campaign has already been evaluated for ${localDate}.` };
      }
      await this.audit.record(actor, {
        action: 'campaign.run',
        entityType: 'campaign',
        entityId: campaignId,
        locationId: campaign.location_id,
        metadata: {
          run_local_date: localDate,
          queued: outcome.queuedCount,
          suppressed: outcome.suppressedCount,
        },
      });
      const runs = await this.listRuns(actor, campaignId, { limit: 1 });
      return {
        run: runs.runs[0] ?? null,
        message: `${outcome.queuedCount} message${outcome.queuedCount === 1 ? '' : 's'} queued, ${outcome.suppressedCount} suppressed.`,
      };
    } catch (err) {
      this.logger.error(`run campaign ${campaignId} failed: ${(err as Error).message}`);
      throw new InternalServerErrorException('The campaign run could not be completed');
    }
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private assertTemplate(template: string): void {
    const result = validateCampaignTemplate(template);
    if (!result.valid) throw new BadRequestException(result.errors.join('; '));
  }

  private assertConfig(type: CampaignType, config: unknown): void {
    const result = validateCampaignConfig(type, config);
    if (!result.valid) throw new BadRequestException(result.errors.join('; '));
  }

  // -------------------------------------------------------------------------
  // Access control
  // -------------------------------------------------------------------------

  /**
   * Owner role AND `settings.booking.manage`. Deliberately the existing gate for
   * notification settings rather than a new campaign-specific permission: a
   * salon that has decided who may configure client messaging has already
   * answered this question, and adding a key would silently grant nobody it
   * until every security level was edited.
   */
  private assertCampaignAccess(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner') || !userHasPermission(actor, 'settings.booking.manage')) {
      throw new ForbiddenException('Campaign configuration requires owner access');
    }
  }

  private async fetchForActor(actor: AuthUser, campaignId: string): Promise<CampaignRow> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('campaigns')
      .select(CAMPAIGN_COLUMNS)
      .eq('id', campaignId)
      .eq('business_id', actor.businessId)
      .maybeSingle<Omit<CampaignRow, 'timezone'>>();

    if (error) {
      this.logger.error(`load campaign ${campaignId} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load the campaign');
    }
    // Same message for "another tenant's campaign" and "no such campaign": a
    // distinguishable 403 would confirm the id exists somewhere.
    if (!data) throw new NotFoundException('Campaign not found');

    const timezones = await this.evaluator.resolveTimezones([data]);
    return { ...data, timezone: timezones.get(`${data.business_id}:${data.location_id ?? ''}`) ?? 'Europe/London' };
  }

  private async assertLocationBelongsToBusiness(businessId: string, locationId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`verify location ${locationId} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify the location');
    }
    if (!data) throw new NotFoundException('Location not found');
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private async fetchLocationNames(businessId: string): Promise<Map<string, string>> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name')
      .eq('business_id', businessId)
      .returns<Array<{ id: string; name: string }>>();
    if (error) {
      this.logger.error(`load location names failed: ${error.message}`);
      return new Map();
    }
    return new Map((data ?? []).map((row) => [row.id, row.name]));
  }

  /** Rolled-up run counters per campaign, for the list view. */
  private async fetchTotals(campaignIds: string[]): Promise<Map<string, CampaignTotals>> {
    const totals = new Map<string, CampaignTotals>();
    if (campaignIds.length === 0) return totals;

    const { data, error } = await this.admin
      .schema('comms')
      .from('campaign_runs')
      .select('campaign_id,queued_count,suppressed_count,failed_count')
      .in('campaign_id', campaignIds)
      .returns<
        Array<{
          campaign_id: string;
          queued_count: number;
          suppressed_count: number;
          failed_count: number;
        }>
      >();

    if (error) {
      // Counters are decoration on a configuration screen. A failed read shows
      // zeros rather than failing the whole list.
      this.logger.error(`load campaign totals failed: ${error.message}`);
      return totals;
    }

    for (const row of data ?? []) {
      const current = totals.get(row.campaign_id) ?? {
        runCount: 0,
        queuedCount: 0,
        suppressedCount: 0,
        failedCount: 0,
      };
      current.runCount += 1;
      current.queuedCount += Number(row.queued_count ?? 0);
      current.suppressedCount += Number(row.suppressed_count ?? 0);
      current.failedCount += Number(row.failed_count ?? 0);
      totals.set(row.campaign_id, current);
    }
    return totals;
  }

  private toDetail(
    row: CampaignRow,
    locationNames: Map<string, string>,
    totals: CampaignTotals | undefined,
  ): CampaignDetail {
    return {
      id: row.id,
      businessId: row.business_id,
      locationId: row.location_id,
      locationName: row.location_id ? locationNames.get(row.location_id) ?? null : null,
      campaignType: row.campaign_type as CampaignType,
      name: row.name,
      status: row.status as CampaignStatus,
      channel: row.channel as CampaignChannel,
      messageTemplate: row.message_template,
      messageSubject: row.message_subject,
      sendAtLocalHour: Number(row.send_at_local_hour),
      timezone: row.timezone,
      // Column last: a stray `type` inside the stored JSON cannot re-label the campaign.
      config: { ...(row.config ?? {}), type: row.campaign_type as CampaignType } as CampaignConfig,
      createdByUserProfileId: row.created_by_user_profile_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEvaluatedAt: row.last_evaluated_at,
      totals: totals ?? { runCount: 0, queuedCount: 0, suppressedCount: 0, failedCount: 0 },
    };
  }

  /** The audit delta. Message text included — it IS the change an owner made. */
  private auditShape(row: Omit<CampaignRow, 'timezone'>): Record<string, unknown> {
    return {
      campaign_type: row.campaign_type,
      name: row.name,
      status: row.status,
      channel: row.channel,
      location_id: row.location_id,
      send_at_local_hour: row.send_at_local_hour,
      message_template: row.message_template,
      config: row.config,
    };
  }
}

interface CampaignRunRow {
  id: string;
  campaign_id: string;
  run_local_date: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  candidate_count: number;
  eligible_count: number;
  queued_count: number;
  suppressed_count: number;
  failed_count: number;
  suppression_breakdown: Record<string, number> | null;
  error_message: string | null;
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key value/i.test(error.message ?? '');
}
