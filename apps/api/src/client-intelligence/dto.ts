import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { ClientLapseStatus } from '@sheer/domain';

/**
 * Typed against the domain union rather than bare string literals, so a future
 * rename of a lapse status breaks the build here instead of silently accepting a
 * dead filter value that matches nothing.
 */
const LAPSE_STATUSES: ClientLapseStatus[] = [
  'active',
  'at_risk',
  'lapsed',
  'booked',
  'insufficient_history',
];

export class ListLapsedClientsQueryDto {
  /**
   * Repeatable: `?status=lapsed&status=at_risk`. Omitted means every status —
   * the endpoint is "client lapse intelligence", not only the lapsed ones, so a
   * campaign can select `lapsed` while a report counts all five.
   */
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @IsIn(LAPSE_STATUSES, { each: true })
  status?: ClientLapseStatus[];

  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Narrow to clients whose representative (dominant) service is this one. */
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @IsOptional()
  @IsUUID()
  serviceCategoryId?: string;

  /**
   * How far back completed visits are read. Bounds the scan; a client not seen
   * within the window is out of scope for retention rather than "lapsed".
   * Defaults to 730 days server-side and is always echoed back in the response.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  lookbackDays?: number;

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

export class UpsertRetentionSettingsDto {
  /**
   * Omit for the business-wide default; supply a location id to override it for
   * that location only. Absence of a row inherits — this endpoint always writes
   * a row, so every value it stores (including 0) is an explicit decision.
   */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /**
   * Grace days after the expected return before a client counts as lapsed.
   * 0 is valid and meaningful: any overdue day lapses immediately.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  lapsedBufferDays!: number;

  /**
   * Completed visits required before a personal cadence is claimed. Two is the
   * floor — fewer produces no interval to take a median of.
   */
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(20)
  minCompletedVisits!: number;
}
