import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { ZacRequestSource } from '../context/zac-context.types';

export class ZacAskRequestDto {
  /** Free-text question. Never logged raw — /api/zac bodies are suppressed by the logging middleware. */
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  /** Conversation to continue. Accepted for contract stability; unused until conversation persistence lands. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsIn(['web_dashboard', 'mobile_app'])
  requestSource?: ZacRequestSource;

  /** Optional single-location focus; validated against the acting user's location scope, never trusted raw. */
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
