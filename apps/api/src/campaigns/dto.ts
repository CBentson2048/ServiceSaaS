import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  CAMPAIGN_BOUNDS,
  CAMPAIGN_CHANNELS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  type CampaignChannel,
  type CampaignStatus,
  type CampaignType,
} from '@sheer/domain';

/**
 * Campaign configuration DTOs.
 *
 * `config` is validated in TWO stages on purpose. class-validator only proves it
 * is an object here; `validateCampaignConfig()` in @sheer/domain then checks it
 * against the declared campaign type, because the valid shape depends on a
 * sibling field and the rules must be identical for the API, the evaluator and
 * the read path. Nothing in `config` is ever interpreted as an expression.
 *
 * `businessId` appears nowhere. Business and acting user come from the
 * authenticated context; a browser-supplied tenant id is never read (Wrike
 * section 44). `locationId` IS accepted but is re-validated against the acting
 * business before use.
 */
export class CreateCampaignDto {
  @IsIn(CAMPAIGN_TYPES as readonly string[])
  campaignType!: CampaignType;

  @IsString()
  @MinLength(CAMPAIGN_BOUNDS.nameLength.min)
  @MaxLength(CAMPAIGN_BOUNDS.nameLength.max)
  name!: string;

  /** Omitted / null = a business-wide campaign. */
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsOptional()
  @IsIn(CAMPAIGN_CHANNELS as readonly string[])
  channel?: CampaignChannel;

  @IsString()
  @MinLength(CAMPAIGN_BOUNDS.templateLength.min)
  @MaxLength(CAMPAIGN_BOUNDS.templateLength.max)
  messageTemplate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(CAMPAIGN_BOUNDS.subjectLength.max)
  messageSubject?: string | null;

  @IsOptional()
  @IsInt()
  @Min(CAMPAIGN_BOUNDS.sendAtLocalHour.min)
  @Max(CAMPAIGN_BOUNDS.sendAtLocalHour.max)
  @Type(() => Number)
  sendAtLocalHour?: number;

  @IsObject()
  config!: Record<string, unknown>;
}

/**
 * PATCH body. Every field is optional and the service applies only those that
 * are `!== undefined` — DTO instances carry every declared field as an own
 * (undefined) property, so testing with `in` would null whatever was omitted.
 *
 * `campaignType` is absent by design: a campaign's type decides the shape of its
 * config, its audience strategy and its send identity. Changing it in place
 * would silently re-key everyone who had already been messaged. Retype = archive
 * and create.
 */
export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @MinLength(CAMPAIGN_BOUNDS.nameLength.min)
  @MaxLength(CAMPAIGN_BOUNDS.nameLength.max)
  name?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsOptional()
  @IsIn(CAMPAIGN_CHANNELS as readonly string[])
  channel?: CampaignChannel;

  @IsOptional()
  @IsString()
  @MinLength(CAMPAIGN_BOUNDS.templateLength.min)
  @MaxLength(CAMPAIGN_BOUNDS.templateLength.max)
  messageTemplate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CAMPAIGN_BOUNDS.subjectLength.max)
  messageSubject?: string | null;

  @IsOptional()
  @IsInt()
  @Min(CAMPAIGN_BOUNDS.sendAtLocalHour.min)
  @Max(CAMPAIGN_BOUNDS.sendAtLocalHour.max)
  @Type(() => Number)
  sendAtLocalHour?: number;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateCampaignStatusDto {
  @IsIn(CAMPAIGN_STATUSES as readonly string[])
  status!: CampaignStatus;
}

export class ListCampaignsQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(CAMPAIGN_TYPES as readonly string[])
  campaignType?: CampaignType;

  /** Archived campaigns are hidden unless explicitly asked for. */
  @IsOptional()
  @IsIn(['true', 'false'])
  includeArchived?: string;
}

export class ListCampaignRunsQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
