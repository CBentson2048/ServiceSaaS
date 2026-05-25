import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';
import type { InventoryStockMovementType } from '@sheer/domain';

const MANUAL_MOVEMENT_TYPES = ['opening_balance', 'restock', 'manual_adjustment', 'retail_sale', 'correction'] as const;

export class InventoryQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeInactive?: boolean;
}

export class UpsertInventoryProductDto {
  @IsOptional()
  @IsString()
  brand?: string | null;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  category?: string | null;

  @IsOptional()
  @IsString()
  sku?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sizeValue?: number | null;

  @IsOptional()
  @IsString()
  sizeUnit?: string | null;

  @IsOptional()
  @IsString()
  defaultUnit?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  defaultCostPerGramCents?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  retailPriceCents?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lowStockThresholdGrams?: number | null;
}

export class StockQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  lowStockOnly?: boolean;
}

export class InitializeInventoryStockDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  productId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantityOnHandGrams?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lowStockThresholdGrams?: number | null;
}

export class AdjustInventoryStockDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  productId!: string;

  @Type(() => Number)
  @IsNumber()
  quantityDeltaGrams!: number;

  @IsEnum(MANUAL_MOVEMENT_TYPES)
  movementType!: Extract<
    InventoryStockMovementType,
    'opening_balance' | 'restock' | 'manual_adjustment' | 'retail_sale' | 'correction'
  >;

  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export class UpdateInventoryStockThresholdDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lowStockThresholdGrams?: number | null;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;
}

export class MovementQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}
