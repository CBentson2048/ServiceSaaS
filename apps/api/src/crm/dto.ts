import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  CrmAllergySeverity,
  CrmNoteType,
  CrmPatchTestStatus,
  CrmVisitPhotoType,
} from '@sheer/domain';

const NOTE_TYPES: CrmNoteType[] = ['general', 'consultation', 'formula_note', 'service_note', 'gdpr'];
const ALLERGY_SEVERITIES: CrmAllergySeverity[] = ['unknown', 'mild', 'moderate', 'severe'];
const PATCH_TEST_STATUSES: CrmPatchTestStatus[] = ['pending', 'passed', 'failed', 'expired'];
const PHOTO_TYPES: CrmVisitPhotoType[] = ['before', 'after', 'inspiration', 'condition', 'other'];

export class ListCrmClientsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

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

export class CreateCrmClientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsUUID()
  primaryLocationId?: string;

  @IsOptional()
  @IsIn(['whatsapp', 'sms', 'email'])
  communicationPreference?: 'whatsapp' | 'sms' | 'email';

  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;
}

export class UpdateCrmClientDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsUUID()
  primaryLocationId?: string | null;

  @IsOptional()
  @IsIn(['whatsapp', 'sms', 'email', null])
  communicationPreference?: 'whatsapp' | 'sms' | 'email' | null;

  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notesSummary?: string | null;
}

export class CreateCrmNoteDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  visitId?: string;

  @IsOptional()
  @IsIn(NOTE_TYPES)
  noteType?: CrmNoteType;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content!: string;
}

export class CreateCrmAllergyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  allergenName!: string;

  @IsOptional()
  @IsIn(ALLERGY_SEVERITIES)
  severity?: CrmAllergySeverity;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCrmPatchTestDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsISO8601()
  performedAt!: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsIn(PATCH_TEST_STATUSES)
  status!: CrmPatchTestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreateCrmVisitPhotoDto {
  @IsUUID()
  clientProfileId!: string;

  @IsOptional()
  @IsIn(PHOTO_TYPES)
  photoType?: CrmVisitPhotoType;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  storageBucket!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  storagePath!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;
}
