import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { PurchaseOrderStatus } from '@sheer/domain';

const ORDER_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'cancelled'] as const;

export class ListOrdersQueryDto {
  @IsOptional()
  @IsUUID('4', { message: 'locationId must be a valid location id' })
  locationId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'supplierId must be a valid supplier id' })
  supplierId?: string;

  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: PurchaseOrderStatus;
}

export class GenerateOrdersDto {
  @IsUUID('4', { message: 'locationId must be a valid location id' })
  locationId!: string;
}

export class UpdateOrderLineDto {
  @IsUUID('4', { message: 'line id must be a valid id' })
  id!: string;

  @Type(() => Number)
  @IsInt({ message: 'orderedQuantity must be a whole number of packs' })
  @Min(0, { message: 'orderedQuantity must not be negative' })
  orderedQuantity!: number;
}

export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderLineDto)
  lines?: UpdateOrderLineDto[];
}
