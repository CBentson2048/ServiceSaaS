import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
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
  ValidateNested,
} from 'class-validator';
import type {
  FixedCostCadence,
  FixedCostCategory,
  LocationDepositType,
} from '@sheer/domain';
import { APPOINTMENT_SLOT_OPTIONS } from '@sheer/domain';

const DEPOSIT_TYPES: LocationDepositType[] = ['none', 'fixed_amount', 'percentage'];
const FIXED_COST_CATEGORIES: FixedCostCategory[] = [
  'rent',
  'rates',
  'utilities',
  'insurance',
  'software',
  'marketing',
  'equipment',
  'other',
];
const FIXED_COST_CADENCES: FixedCostCadence[] = ['weekly', 'monthly', 'quarterly', 'annual'];

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class OpeningHoursEntryDto {
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @IsBoolean()
  isOpen!: boolean;

  @Matches(TIME_REGEX, { message: 'opensAt must be HH:MM (24h)' })
  opensAt!: string;

  @Matches(TIME_REGEX, { message: 'closesAt must be HH:MM (24h)' })
  closesAt!: string;
}

export class UpdateLocationRecordSettingsDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursEntryDto)
  openingHours?: OpeningHoursEntryDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  chairCount?: number;

  // Closed set (15/30/60) — mirrors the 0084 DB check constraint. The old
  // 1–480 range let unbookable granularities (7, 13…) reach the diary.
  @IsOptional()
  @IsInt()
  @IsIn([...APPOINTMENT_SLOT_OPTIONS])
  appointmentSlotMinutes?: number;

  @IsOptional()
  @IsIn(DEPOSIT_TYPES)
  defaultDepositType?: LocationDepositType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultDepositValue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountAuthorisationThresholdPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cashVarianceThresholdAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  colourMarginTargetPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  wasteAllowancePercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  rebookRateBenchmarkPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  utilisationWarningThresholdPercent?: number;

  /** Days without outbound movement before stock counts as dead (location-wide default). */
  @IsOptional()
  @IsInt({ message: 'deadStockDaysDefault must be a whole number of days' })
  @Min(1)
  @Max(3650)
  deadStockDaysDefault?: number;

  @IsOptional()
  @IsInt({ message: 'reorderUsageWindowWeeks must be a whole number of weeks' })
  @Min(1)
  @Max(52)
  reorderUsageWindowWeeks?: number;

  @IsOptional()
  @IsInt({ message: 'reorderCoverageWeeks must be a whole number of weeks' })
  @Min(1)
  @Max(52)
  reorderCoverageWeeks?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  payrollWarningPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  payrollCriticalPercent?: number;

  @IsOptional()
  @IsBoolean()
  sundayReportEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true, message: 'sundayReportRecipients must be valid emails' })
  sundayReportRecipients?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  sundayReportSendHour?: number;
}

export class LocationIdQueryDto {
  @IsUUID()
  locationId!: string;
}

export class EffectiveFixedCostsQueryDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @Matches(DATE_REGEX, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

export class FixedCostIdParamDto {
  @IsUUID()
  id!: string;
}

export class CreateLocationFixedCostDto {
  @IsUUID()
  locationId!: string;

  @IsIn(FIXED_COST_CATEGORIES)
  category!: FixedCostCategory;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string | null;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsIn(FIXED_COST_CADENCES)
  cadence?: FixedCostCadence;

  @Matches(DATE_REGEX, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom!: string;

  @IsOptional()
  @Matches(DATE_REGEX, { message: 'effectiveTo must be YYYY-MM-DD' })
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class UpdateLocationFixedCostDto {
  @IsOptional()
  @IsIn(FIXED_COST_CATEGORIES)
  category?: FixedCostCategory;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsIn(FIXED_COST_CADENCES)
  cadence?: FixedCostCadence;

  @IsOptional()
  @Matches(DATE_REGEX, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom?: string;

  @IsOptional()
  @Matches(DATE_REGEX, { message: 'effectiveTo must be YYYY-MM-DD' })
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
