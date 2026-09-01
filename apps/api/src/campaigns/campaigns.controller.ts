import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  CampaignAudiencePreview,
  CampaignResponse,
  CampaignRunSummary,
  ListCampaignRunsResponse,
  ListCampaignsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CampaignsService } from './campaigns.service';
import {
  CreateCampaignDto,
  ListCampaignRunsQueryDto,
  ListCampaignsQueryDto,
  UpdateCampaignDto,
  UpdateCampaignStatusDto,
} from './dto';

/**
 * Owner configuration of marketing campaigns (Wrike 4507283957, section 43).
 *
 * Gated on the owner role plus `settings.booking.manage` — the existing
 * permission for booking and notification settings. The service re-checks both
 * independently, so a controller change alone cannot widen access.
 *
 * There is deliberately NO "send to these client ids" endpoint. The server
 * always determines the audience from the campaign's typed configuration; a
 * caller can ask for a campaign to be evaluated, never for a message to be sent
 * to a list it supplies.
 */
@Controller('campaigns')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner')
@RequirePermissions('settings.booking.manage')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListCampaignsQueryDto,
  ): Promise<ListCampaignsResponse> {
    return this.campaigns.list(actor, query);
  }

  @Get(':campaignId')
  get(
    @CurrentUser() actor: AuthUser,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ): Promise<CampaignResponse> {
    return this.campaigns.get(actor, campaignId);
  }

  /**
   * Who would receive this campaign if it ran today, and who would not, and why.
   *
   * READ-ONLY: the same audience resolver a real run uses, with the claim and
   * the enqueue simply not called. Nothing is written and no message is sent.
   */
  @Get(':campaignId/audience-preview')
  previewAudience(
    @CurrentUser() actor: AuthUser,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ): Promise<CampaignAudiencePreview> {
    return this.campaigns.previewAudience(actor, campaignId);
  }

  @Get(':campaignId/runs')
  listRuns(
    @CurrentUser() actor: AuthUser,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
    @Query() query: ListCampaignRunsQueryDto,
  ): Promise<ListCampaignRunsResponse> {
    return this.campaigns.listRuns(actor, campaignId, query);
  }

  /** Always created as a draft. Saving a form never sends anything. */
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() body: CreateCampaignDto): Promise<CampaignResponse> {
    return this.campaigns.create(actor, body);
  }

  @Patch(':campaignId')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
    @Body() body: UpdateCampaignDto,
  ): Promise<CampaignResponse> {
    return this.campaigns.update(actor, campaignId, body);
  }

  /** Enable / pause / archive. Separate from the editor so activation is deliberate. */
  @Patch(':campaignId/status')
  setStatus(
    @CurrentUser() actor: AuthUser,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
    @Body() body: UpdateCampaignStatusDto,
  ): Promise<CampaignResponse> {
    return this.campaigns.setStatus(actor, campaignId, body.status);
  }

  /**
   * Evaluate an active campaign now.
   *
   * Not a bypass — the same run path the scheduler uses, with the same
   * once-per-local-day guard, the same per-recipient claim and the same consent
   * and opt-out rules. Returns as soon as the messages are QUEUED; delivery
   * belongs to the dispatcher.
   */
  @Post(':campaignId/run')
  @HttpCode(HttpStatus.OK)
  runNow(
    @CurrentUser() actor: AuthUser,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ): Promise<{ run: CampaignRunSummary | null; message: string }> {
    return this.campaigns.runNow(actor, campaignId);
  }
}
