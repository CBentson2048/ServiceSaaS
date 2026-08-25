import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { ServiceBillingCategory, ServiceDepositType } from '@sheer/domain';

const BILLING_CATEGORIES = [
  'permanent_colour',
  'lightener_bleach',
  'semi_toners',
  'special_treatments',
] as const;

const DEPOSIT_TYPES = ['none', 'fixed_amount', 'percentage'] as const;

// A #RRGGBB tile colour for the appointment book. `null` clears it.
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

export class ServiceCategoryQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeInactive?: boolean;
}

export class CreateServiceCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string | null;

  @IsOptional()
  @ValidateIf((o: CreateServiceCategoryDto) => o.colorHex !== null)
  @Matches(HEX_COLOUR, { message: 'colorHex must be a #RRGGBB hex colour' })
  colorHex?: string | null;

  /** Which kind of colour work this category is; null/omitted = not colour. */
  @IsOptional()
  @ValidateIf((o: CreateServiceCategoryDto) => o.billingCategory !== null)
  @IsIn(BILLING_CATEGORIES, {
    message: 'billingCategory must be permanent_colour, lightener_bleach, semi_toners or special_treatments',
  })
  billingCategory?: ServiceBillingCategory | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateServiceCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string | null;

  @IsOptional()
  @ValidateIf((o: UpdateServiceCategoryDto) => o.colorHex !== null)
  @Matches(HEX_COLOUR, { message: 'colorHex must be a #RRGGBB hex colour' })
  colorHex?: string | null;

  /** Explicit null clears the tag; omitted keeps it. */
  @IsOptional()
  @ValidateIf((o: UpdateServiceCategoryDto) => o.billingCategory !== null)
  @IsIn(BILLING_CATEGORIES, {
    message: 'billingCategory must be permanent_colour, lightener_bleach, semi_toners or special_treatments',
  })
  billingCategory?: ServiceBillingCategory | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

// Body for the reorder endpoints: catalogue ids in the desired display order.
export class ReorderDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}

export class ServiceQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsUUID()
  serviceCategoryId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeInactive?: boolean;
}

// One ordered segment of a service (a named step with its own time).
export class ServiceSegmentInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationMinutes!: number;

  // Marks this segment as stylist-free ("development time"): the stylist is
  // available for another client during it. Defaults to false when omitted.
  @IsOptional()
  @IsBoolean()
  isStylistFree?: boolean;
}

export class UpsertServiceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsUUID()
  serviceCategoryId?: string | null;

  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  estimatedDurationMinutes!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @IsOptional()
  @IsEnum(DEPOSIT_TYPES)
  depositType?: ServiceDepositType;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  depositValue?: number;

  @IsOptional()
  @IsBoolean()
  requiresPatchTest?: boolean;

  @IsOptional()
  @IsBoolean()
  rebookingNudgeEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  rebookingNudgeIntervalDays?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  // Ordered segments to replace the service's set (array order = display order).
  // Non-empty => estimatedDurationMinutes is derived from their sum. Empty array
  // clears segments; omit the field to leave existing segments unchanged.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ServiceSegmentInputDto)
  segments?: ServiceSegmentInputDto[];
}
