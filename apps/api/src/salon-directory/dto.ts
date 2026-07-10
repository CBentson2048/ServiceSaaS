import { IsString, Length, Matches } from 'class-validator';

/** Path param for an exact Salon Code lookup. */
export class SalonCodeParamDto {
  // 6 chars, but allow separators/case the client may pass; the service
  // normalizes before matching. Keep the raw length bounded to avoid abuse.
  @IsString()
  @Length(1, 16)
  code!: string;
}

/** Query for the salon directory search (Salon Code, salon name, or provider Q Code). */
export class SalonSearchQueryDto {
  @IsString()
  @Length(2, 80)
  @Matches(/^[^%_]*$/, { message: 'query contains unsupported characters' })
  query!: string;
}
