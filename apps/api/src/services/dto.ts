import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
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
import type { ServiceDepositType } from '@sheer/domain';

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
  @IsInt()
  @Min(0)
  processingTimeMinutes?: number;

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
