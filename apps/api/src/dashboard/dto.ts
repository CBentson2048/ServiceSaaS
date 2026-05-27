import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class DashboardDateRangeQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}

export class DashboardInventoryAlertsQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
