import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';

export class StartFormulaDto {
  @IsString()
  labSessionId!: string;

  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @IsOptional()
  @IsUUID()
  clientProfileId?: string;

  @IsOptional()
  @IsUUID()
  visitId?: string;
}

export class AddFormulaItemDto {
  @IsString()
  productName!: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsNumber()
  targetGrams?: number;
}

export class CaptureWeightDto {
  @IsNumber()
  grams!: number;

  @IsOptional()
  @IsIn(['ble_scale', 'manual'])
  source?: 'ble_scale' | 'manual';
}

export class SaveFormulaDto {
  @IsString()
  labSessionId!: string;

  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @IsOptional()
  @IsUUID()
  visitId?: string;

  @IsOptional()
  @IsUUID()
  businessId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  clientProfileId?: string;

  @IsOptional()
  @IsString()
  sourceFormulaId?: string;

  @IsOptional()
  items?: unknown[];

  @IsOptional()
  @IsNumber()
  totalCostCents?: number;

  @IsOptional()
  @IsNumber()
  totalWasteCostCents?: number;

  @IsOptional()
  @IsNumber()
  billableChargeCents?: number;

  @IsOptional()
  @IsString()
  currencyCode?: string;

  @IsBoolean()
  billingHandoffRequested!: boolean;

  @IsOptional()
  inventoryDeductionRequested?: boolean;
}

export class DuplicateFormulaDto {
  @IsString()
  labSessionId!: string;

  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @IsOptional()
  @IsUUID()
  visitId?: string;

  @IsOptional()
  @IsUUID()
  clientProfileId?: string;
}
