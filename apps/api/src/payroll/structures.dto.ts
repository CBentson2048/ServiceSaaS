import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  AcceleratorEvaluation,
  AcceleratorMetric,
  ConditionBasis,
  DepositRecognition,
  DiscountBasis,
  HourCategory,
  PayStageType,
  PayrollComparator,
  PayrollDataSource,
  PayrollRevenueStream,
  PayrollVatBasis,
  ProductCostMode,
  ThresholdBasis,
  TierSemantics,
} from '@sheer/domain';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = { message: 'Dates must be YYYY-MM-DD' };

const STAGE_TYPES: PayStageType[] = [
  'base_pay',
  'commission',
  'revenue_split',
  'chair_rent',
  'deduction',
  'bonus',
  'greater_of',
  'tips_payout',
];
const TIER_SEMANTICS: TierSemantics[] = ['marginal', 'retroactive'];
const THRESHOLD_BASES: ThresholdBasis[] = [
  'absolute',
  'multiple_of_base_pay',
  'percent_of_service_target',
  'percent_of_service_revenue',
  'per_client',
];
const REVENUE_STREAMS: PayrollRevenueStream[] = ['service', 'retail', 'service_and_retail'];
const DATA_SOURCES: PayrollDataSource[] = [
  'service_revenue',
  'retail_sales',
  'tips',
  'refunds',
  'cancellation_fees',
  'product_cost',
];
const METRICS: AcceleratorMetric[] = [
  'rebooking_rate_percent',
  'retail_revenue',
  'average_bill',
  'service_revenue',
  'utilisation_percent',
];
const COMPARATORS: PayrollComparator[] = ['gte', 'gt', 'lte', 'lt', 'eq'];
const CONDITION_BASES: ConditionBasis[] = [
  'absolute_amount',
  'percent',
  'staff_benchmark',
  'target_met',
];
const EVALUATIONS: AcceleratorEvaluation[] = ['all', 'any', 'at_least_n', 'weighted', 'custom'];
const HOUR_CATEGORIES: HourCategory[] = [
  'worked',
  'paid_holiday',
  'unpaid_leave',
  'sickness',
  'training',
  'authorised_absence',
  'additional',
  'manual_adjustment',
];
const DISCOUNT_BASES: DiscountBasis[] = [
  'headline_before_discount',
  'actual_after_discount',
  'custom_commissionable_value',
];
const VAT_BASES: PayrollVatBasis[] = ['exclusive', 'inclusive'];
const DEPOSIT_RECOGNITIONS: DepositRecognition[] = ['on_completion', 'on_collection'];
const PRODUCT_COST_MODES: ProductCostMode[] = [
  'none',
  'fixed',
  'actual_usage',
  'percentage',
  'service_specific',
];

export class PayStructureBandDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  fromMultiple?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fromAmountCents?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fromPercent?: number;

  @IsNumber()
  @Min(0)
  ratePercent!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  acceleratorRatePercent?: number;
}

export class PayStructureAcceleratorConditionDto {
  @IsIn(METRICS)
  metric!: AcceleratorMetric;

  @IsIn(COMPARATORS)
  comparator!: PayrollComparator;

  @IsIn(CONDITION_BASES)
  basis!: ConditionBasis;

  @IsOptional()
  @IsNumber()
  thresholdValue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class PayStructureAcceleratorDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsIn(EVALUATIONS)
  evaluationMode!: AcceleratorEvaluation;

  @IsOptional()
  @IsNumber()
  @Min(1)
  requiredConditionCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  requiredScore?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PayStructureAcceleratorConditionDto)
  conditions!: PayStructureAcceleratorConditionDto[];
}

export class PayStructureStageDto {
  @IsIn(STAGE_TYPES)
  stageType!: PayStageType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsIn(TIER_SEMANTICS)
  tierSemantics?: TierSemantics;

  @IsOptional()
  @IsIn(THRESHOLD_BASES)
  thresholdBasis?: ThresholdBasis;

  @IsOptional()
  @IsIn(REVENUE_STREAMS)
  revenueStream?: PayrollRevenueStream;

  @IsOptional()
  @IsBoolean()
  inGreaterOfComparison?: boolean;

  @IsOptional()
  @IsIn(DATA_SOURCES)
  requiresDataSource?: PayrollDataSource;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => PayStructureBandDto)
  bands?: PayStructureBandDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PayStructureAcceleratorDto)
  accelerator?: PayStructureAcceleratorDto;
}

export class PayStructureHourRuleDto {
  @IsIn(HOUR_CATEGORIES)
  category!: HourCategory;

  @IsBoolean()
  countsTowardTarget!: boolean;

  @IsBoolean()
  countsAsPaid!: boolean;
}

export class PayStructureRulesDto {
  @Matches(DATE_REGEX, DATE_MESSAGE)
  effectiveFrom!: string;

  @IsOptional()
  @IsIn(DISCOUNT_BASES)
  discountBasis?: DiscountBasis;

  @IsOptional()
  @IsIn(VAT_BASES)
  vatBasis?: PayrollVatBasis;

  @IsOptional()
  @IsIn(DEPOSIT_RECOGNITIONS)
  depositRecognition?: DepositRecognition;

  @IsOptional()
  @IsIn(PRODUCT_COST_MODES)
  productCostMode?: ProductCostMode;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PayStructureStageDto)
  stages!: PayStructureStageDto[];

  @IsArray()
  @ArrayMinSize(8)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PayStructureHourRuleDto)
  hourRules!: PayStructureHourRuleDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreatePayStructureDto extends PayStructureRulesDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class PayStructurePreviewSampleDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  hourlyRateCents?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  workedHours?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  serviceRevenueCents?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  retailRevenueCents?: number;

  @IsOptional()
  @IsNumber()
  averageBillBenchmarkCents?: number;

  @IsOptional()
  @IsNumber()
  rebookingRatePercent?: number;

  @IsOptional()
  @IsNumber()
  averageBillCents?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  clientCount?: number;
}

export class PayStructurePreviewDto {
  @ValidateNested()
  @Type(() => PayStructureRulesDto)
  rules!: PayStructureRulesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PayStructurePreviewSampleDto)
  sample?: PayStructurePreviewSampleDto;
}

export class PayStructureIdParamDto {
  @IsUUID()
  structureId!: string;
}

export class StaffProfileIdParamDto {
  @IsUUID()
  staffProfileId!: string;
}

export class AssignPayStructureDto {
  @IsUUID()
  structureId!: string;

  @Matches(DATE_REGEX, DATE_MESSAGE)
  effectiveFrom!: string;
}
