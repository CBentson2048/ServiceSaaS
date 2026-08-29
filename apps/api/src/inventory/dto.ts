import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  IsIn,
  IsPositive,
  Max,
} from 'class-validator';
import type { InventoryStockMovementType, StockQuantityUnit, StockUnit } from '@sheer/domain';

const MANUAL_MOVEMENT_TYPES = ['opening_balance', 'restock', 'manual_adjustment', 'retail_sale', 'correction'] as const;

export class InventoryQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

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
  @IsUUID()
  categoryId?: string | null;

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
  /** What one unit of the stored stock quantity means for this product. */
  @IsOptional()
  @IsIn(['gram', 'millilitre', 'unit'], { message: "stockUnit must be 'gram', 'millilitre' or 'unit'" })
  stockUnit?: StockUnit | null;

  /** Base quantities in one sellable/orderable pack. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive({ message: 'packSize must be greater than zero' })
  packSize?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string | null;

  @IsOptional()
  @IsUUID('4', { message: 'supplierId must be a valid supplier id' })
  supplierId?: string | null;

  /** Smallest order the supplier accepts, in packs. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'minimumOrderQuantity must be a whole number of packs' })
  @Min(1, { message: 'minimumOrderQuantity must be at least 1' })
  minimumOrderQuantity?: number | null;

  /** Supplier order step in packs. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'orderMultiple must be a whole number of packs' })
  @Min(1, { message: 'orderMultiple must be at least 1' })
  orderMultiple?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deadStockDays must be a whole number of days' })
  @Min(1, { message: 'deadStockDays must be at least 1' })
  deadStockDays?: number | null;

  // Product-use classification (0079). These columns have existed since 4 Aug
  // but had no write path, which is why they were still dead columns. Week 6
  // gives them one; applying lab_markup_percent to billing stays a separate CR.
  @IsOptional()
  @IsBoolean()
  isSalonUse?: boolean | null;

  @IsOptional()
  @IsBoolean()
  isLabUse?: boolean | null;

  @IsOptional()
  @IsBoolean()
  isRetail?: boolean | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  labMarkupPercent?: number | null;

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

  /** Inclusive lower bound (ISO datetime). Filters movements by created_at. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Exclusive upper bound (ISO datetime). Filters movements by created_at. */
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class CategoryQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeInactive?: boolean;
}

export class CreateInventoryCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string | null;

  /**
   * Days idle before stock in this category counts as dead. Omit or send null to
   * inherit the location default. Minimum 1 — 0 would mean "dead on arrival" and
   * is rejected so it can never be confused with "inherit".
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deadStockDays must be a whole number of days' })
  @Min(1, { message: 'deadStockDays must be 1 or more' })
  deadStockDays?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateInventoryCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string | null;

  /**
   * Days idle before stock in this category counts as dead. Send null to CLEAR
   * the override and fall back to the location default — @IsOptional() skips
   * validation for null as well as undefined, so null reaches the service while
   * 0 is still rejected by @Min(1).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deadStockDays must be a whole number of days' })
  @Min(1, { message: 'deadStockDays must be 1 or more' })
  deadStockDays?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Salon consumption of a product — what a barcode scan records. Either a
 * productId or a barcode identifies the product; the service resolves and
 * validates whichever is supplied against the caller's own business.
 */
export class RecordProductConsumptionDto {
  @IsUUID('4', { message: 'locationId must be a valid location id' })
  locationId!: string;

  @IsOptional()
  @IsUUID('4', { message: 'productId must be a valid product id' })
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  /** Positive amount consumed, expressed in `unit`. */
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'quantity must be a number with at most 3 decimals' })
  @IsPositive({ message: 'quantity must be greater than zero' })
  quantity!: number;

  @IsOptional()
  @IsIn(['base', 'pack'], { message: "unit must be 'base' or 'pack'" })
  unit?: StockQuantityUnit;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Supplied by the client so a retried scan cannot deduct twice. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

/**
 * Location availability is a concept of its own — "where do we stock/sell
 * this?" — independent of the product's use classification ("what is it
 * for?"). Setting it maintains the product's inventory.location_stock row.
 */
export class SetProductAvailabilityDto {
  @IsUUID('4', { message: 'locationId must be a valid location id' })
  locationId!: string;

  @IsBoolean()
  available!: boolean;
}

export class DeadStockQueryDto {
  @IsOptional()
  @IsUUID('4', { message: 'locationId must be a valid location id' })
  locationId?: string;
}

export class SupplierQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeInactive?: boolean;
}

export class CreateInventorySupplierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsEmail({}, { message: 'contactEmail must be a valid email address' })
  @MaxLength(254)
  contactEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  accountReference?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'leadTimeDays must be a whole number of days' })
  @Min(0, { message: 'leadTimeDays must not be negative' })
  leadTimeDays?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateInventorySupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'contactEmail must be a valid email address' })
  @MaxLength(254)
  contactEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  accountReference?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'leadTimeDays must be a whole number of days' })
  @Min(0, { message: 'leadTimeDays must not be negative' })
  leadTimeDays?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BarcodeLookupQueryDto {
  @IsString()
  @MaxLength(64)
  barcode!: string;

  @IsUUID('4', { message: 'locationId must be a valid location id' })
  locationId!: string;
}
