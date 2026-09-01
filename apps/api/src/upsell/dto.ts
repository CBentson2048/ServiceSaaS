import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { UPSELL_MAX_CONTEXT_SERVICES, type UpsellRuleTriggerType } from '@sheer/domain';

const TRIGGER_TYPES: UpsellRuleTriggerType[] = ['service', 'service_category'];

/**
 * Draft (pre-save) booking context. The client supplies only what it is
 * choosing — location, services, optionally the stylist. Business and acting
 * permissions come from the token; a client-supplied businessId is never read,
 * and every service id is re-validated against the acting business + location
 * before it is used.
 */
export class DraftUpsellContextDto {
  @IsUUID()
  locationId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(UPSELL_MAX_CONTEXT_SERVICES)
  @IsUUID('4', { each: true })
  serviceIds!: string[];

  @IsOptional()
  @IsUUID()
  staffProfileId?: string;
}

export class CreateUpsellRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Omitted / null = a business-wide default rule. */
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsIn(TRIGGER_TYPES)
  triggerType!: UpsellRuleTriggerType;

  @IsOptional()
  @IsUUID()
  triggerServiceId?: string | null;

  @IsOptional()
  @IsUUID()
  triggerServiceCategoryId?: string | null;

  @IsUUID()
  suggestedServiceId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * PATCH body. Every field is optional and the service applies only those that
 * are `!== undefined` — DTO instances carry every declared field as an own
 * (undefined) property, so testing with `in` would null whatever was omitted.
 */
export class UpdateUpsellRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsOptional()
  @IsIn(TRIGGER_TYPES)
  triggerType?: UpsellRuleTriggerType;

  @IsOptional()
  @IsUUID()
  triggerServiceId?: string | null;

  @IsOptional()
  @IsUUID()
  triggerServiceCategoryId?: string | null;

  @IsOptional()
  @IsUUID()
  suggestedServiceId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ListUpsellRulesQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
