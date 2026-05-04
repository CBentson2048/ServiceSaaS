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

  @IsBoolean()
  billingHandoffRequested!: boolean;
}
