import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { RetailPricingMode, RetailPricingScope } from '@sheer/domain';

const SCOPES: RetailPricingScope[] = [
  'location_product',
  'product',
  'location_category',
  'category',
  'location',
];
const MODES: RetailPricingMode[] = ['percentage_markup', 'fixed_price'];

export class ListPricingRulesQueryDto {
  @IsOptional()
  @IsUUID('4')
  productId?: string;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @IsOptional()
  @IsUUID('4')
  locationId?: string;
}

export class UpsertPricingRuleDto {
  @IsIn(SCOPES)
  scope!: RetailPricingScope;

  @IsOptional()
  @IsUUID('4')
  productId?: string;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @IsOptional()
  @IsUUID('4')
  locationId?: string;

  @IsIn(MODES)
  pricingMode!: RetailPricingMode;

  /** 0 is a VALID intentional zero-markup override — Min(0), never excluded. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000)
  markupPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fixedPriceCents?: number;
}

export class EffectivePricingQueryDto {
  @IsUUID('4')
  productId!: string;

  @IsUUID('4')
  locationId!: string;
}
