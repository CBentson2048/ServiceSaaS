import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type {
  PayPeriodFrequency,
  PayPeriodKind,
  PayPeriodStatus,
  PayrollDataSource,
} from '@sheer/domain';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = { message: 'Dates must be YYYY-MM-DD' };

const PERIOD_KINDS: PayPeriodKind[] = ['calculation', 'payment'];
const PERIOD_FREQUENCIES: PayPeriodFrequency[] = [
  'weekly',
  'fortnightly',
  'four_weekly',
  'monthly',
  'custom',
];
const PERIOD_STATUSES: PayPeriodStatus[] = [
  'draft',
  'ready_for_review',
  'approved',
  'locked',
  'paid',
];

export class ListPayPeriodsQueryDto {
  @IsOptional()
  @IsIn(PERIOD_KINDS)
  kind?: PayPeriodKind;

  @IsOptional()
  @IsIn(PERIOD_STATUSES)
  status?: PayPeriodStatus;

  @IsOptional()
  @Matches(DATE_REGEX, DATE_MESSAGE)
  from?: string;

  @IsOptional()
  @Matches(DATE_REGEX, DATE_MESSAGE)
  to?: string;
}

export class CreatePayPeriodDto {
  @IsOptional()
  @IsIn(PERIOD_KINDS)
  kind?: PayPeriodKind;

  @IsOptional()
  @IsIn(PERIOD_FREQUENCIES)
  frequency?: PayPeriodFrequency;

  @IsOptional()
  @Matches(DATE_REGEX, DATE_MESSAGE)
  periodStart?: string;

  @IsOptional()
  @Matches(DATE_REGEX, DATE_MESSAGE)
  periodEnd?: string;

  /** Derive the window containing this date from payroll settings. */
  @IsOptional()
  @Matches(DATE_REGEX, DATE_MESSAGE)
  referenceDate?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class PayPeriodIdParamDto {
  @IsUUID()
  periodId!: string;
}

export class PaySummaryIdParamDto {
  @IsUUID()
  summaryId!: string;
}

const DATA_SOURCES: PayrollDataSource[] = [
  'service_revenue',
  'retail_sales',
  'tips',
  'refunds',
  'cancellation_fees',
  'product_cost',
];

export class DataSourceParamDto {
  @IsIn(DATA_SOURCES)
  source!: PayrollDataSource;
}

export class UpdateDataSourceDto {
  @IsBoolean()
  isCaptured!: boolean;
}
