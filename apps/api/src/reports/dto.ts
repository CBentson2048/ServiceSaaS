import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query for GET /api/reports/:reportKey/result.
 *
 * Whitelist only: the global ValidationPipe (main.ts, forbidNonWhitelisted)
 * refuses any other parameter, and these decorators only bound the raw strings.
 * Meaning — presets, dates, ids, supported controls — is validated in exactly
 * one place, the domain's strict `decodeReportFilter`, so the API and the
 * browser can never disagree about what a filter means. Lengths are generous so
 * a bad value reaches that decoder and gets a typed issue.
 */
export class ReportResultQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  preset?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  locations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  staff?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  view?: string;

  /** Detail-view page cursor (R1 Money). Not a filter: never part of the report URL. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
