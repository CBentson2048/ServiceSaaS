import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

export type ProductBillingRuleDto = 'cost_only' | 'cost_plus_markup_percent' | 'fixed_uplift';

export class UpdateProductBillingSettingsDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsBoolean()
  productBillingEnabled?: boolean;

  @IsOptional()
  @IsEnum(['cost_only', 'cost_plus_markup_percent', 'fixed_uplift'])
  productBillingRule?: ProductBillingRuleDto;

  @IsOptional()
  @IsNumber()
  @Min(0)
  productMarkupPercent?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  productFixedUpliftAmount?: number | null;
}
