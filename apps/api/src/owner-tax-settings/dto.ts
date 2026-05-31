import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import type { TaxAppliesTo, TaxDisplayMode } from '@sheer/domain';

export class UpdateTaxSettingsDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsBoolean()
  taxEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  taxLabel?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxRatePercent?: number;

  @IsOptional()
  @IsEnum(['services', 'retail', 'both'])
  appliesTo?: TaxAppliesTo;

  @IsOptional()
  @IsEnum(['inc_tax', 'ex_tax', 'both'])
  displayMode?: TaxDisplayMode;
}
