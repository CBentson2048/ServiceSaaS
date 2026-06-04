import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { RetailPaymentMethod } from '@sheer/domain';

const PAYMENT_METHODS: RetailPaymentMethod[] = ['cash', 'card_reader', 'other'];

export class RecordRetailSaleDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  productId!: string;

  /** Selling stylist. Ignored for stylist callers (forced to their own profile). */
  @IsOptional()
  @IsUUID()
  staffProfileId?: string;

  @IsOptional()
  @IsUUID()
  clientProfileId?: string;

  @IsOptional()
  @IsUUID()
  visitId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  /** Omit to default to the product's configured retail price. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitPriceCents?: number;

  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: RetailPaymentMethod;

  @IsOptional()
  @IsDateString()
  soldAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class RetailSalesQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  staffProfileId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
