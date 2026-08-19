import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import type { ColourPrepRange } from '@sheer/domain';

const RANGES: ColourPrepRange[] = ['today', 'this_week', 'next_week', 'custom'];

export class ColourPrepQueryDto {
  /**
   * Always required and always validated against the caller's own scope — the
   * service never trusts it as proof of access.
   */
  @IsUUID('4', { message: 'locationId must be a valid location id' })
  locationId!: string;

  @IsOptional()
  @IsIn(RANGES, { message: `range must be one of: ${RANGES.join(', ')}` })
  range?: ColourPrepRange;

  /** Inclusive local start date for a custom range. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date in YYYY-MM-DD format' })
  from?: string;

  /** Inclusive local end date for a custom range. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date in YYYY-MM-DD format' })
  to?: string;
}
