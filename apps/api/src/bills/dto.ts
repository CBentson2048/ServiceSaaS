import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

/**
 * Bill finder query (`GET /bills`). Every filter is optional and they combine
 * with AND semantics; unfiltered, the finder is simply the business's bill
 * history, newest first.
 */
export class ListBillsQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  clientProfileId?: string;

  @IsOptional()
  @IsUUID()
  staffProfileId?: string;

  /** Inclusive day, YYYY-MM-DD. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom?: string;

  /** Inclusive day, YYYY-MM-DD. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo?: string;

  /** Filter on the bill's gross total, in cents. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountMinCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountMaxCents?: number;

  /** Exact bill-number lookup ("the client is quoting #000123 on the phone"). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  billNumber?: number;

  /** 1-based page index. Defaults to 1 when omitted. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Rows per page. Clamped server-side to [1, 100]. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
