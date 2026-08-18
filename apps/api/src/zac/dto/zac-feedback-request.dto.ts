import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ZacFeedbackRequestDto {
  /** The Phase 1 vocabulary: was this output useful? */
  @IsIn(['useful', 'not_useful'])
  rating!: 'useful' | 'not_useful';

  /** Optional short note; redacted before storage, never required. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
