import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import type { KpiPeriod } from '@sheer/domain';

/**
 * KPI query. Supply EITHER a named `period` (today | week | month, resolved to
 * explicit UTC boundaries server-side) OR an explicit `from`/`to` ISO range.
 * `locationId` narrows owner/manager scope to a single location.
 */
export class KpiQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['today', 'week', 'month'])
  period?: KpiPeriod;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
