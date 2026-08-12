import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class OpenEodDayDto {
  @IsUUID()
  locationId!: string;

  /** Defaults to today in the location's timezone when omitted. */
  @IsOptional()
  @Matches(DATE_PATTERN)
  businessDate?: string;
}

export class GetEodDayQueryDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @Matches(DATE_PATTERN)
  businessDate?: string;
}

export class ListEodDaysQueryDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class UpdateEodDayDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  openingFloatCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  countedCashCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  countedCardCents?: number;

  /** Manual until the refund/void data model exists. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  voidsCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  refundsCents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class AddEodPettyCashDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}
