import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { ZacRequestSource } from '../context/zac-context.types';

export class ZacAskRequestDto {
  /** Free-text question. Never logged raw — /api/zac bodies are suppressed by the logging middleware. */
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  /**
   * Conversation to continue. Validated against the authenticated acting user
   * (owner + business + active status) — a foreign or unknown id gets the same
   * 404, leaking nothing. Absent = a new conversation is created and returned
   * as `conversation_id` on the response.
   */
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
