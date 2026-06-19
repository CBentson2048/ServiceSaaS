import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

const SERVICE_BILLING_CATEGORIES = [
  'permanent_colour',
  'lightener_bleach',
  'semi_toners',
  'special_treatments',
] as const;

const CHARGING_STRATEGIES = ['track_only', 'overage', 'charge_all'] as const;

export class UpdateServiceBillingRuleDto {
  @IsEnum(SERVICE_BILLING_CATEGORIES)
  category!: (typeof SERVICE_BILLING_CATEGORIES)[number];

  @IsOptional()
  @IsEnum(CHARGING_STRATEGIES)
  chargingStrategy?: (typeof CHARGING_STRATEGIES)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  standardAllowanceGrams?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salonMarkupPercent?: number;
}

export class UpdateServiceBillingGlobalParametersDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  sampleUsageGrams?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  baseCostPerGramCents?: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currencyCode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultMarkupPercent?: number;
}

export class UpdateServiceBillingRulesDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateServiceBillingRuleDto)
  rules?: UpdateServiceBillingRuleDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateServiceBillingGlobalParametersDto)
  globalParameters?: UpdateServiceBillingGlobalParametersDto;
}
