import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { CommunicationPreference } from '@sheer/domain';
import { IsPhoneField } from '../communications/phone-field.decorator';

const COMMUNICATION_PREFERENCES: CommunicationPreference[] = ['whatsapp', 'sms', 'email'];

export class ListProfilesQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['staff', 'client'])
  kind?: 'staff' | 'client';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class UpdateCurrentProfileDto {
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
  @IsString()
  @MaxLength(40)
  @IsPhoneField()
  phone?: string | null;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  avatarUrl?: string | null;

  @IsOptional()
  @IsIn(COMMUNICATION_PREFERENCES)
  communicationPreference?: CommunicationPreference;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string | null;
}

export class AdminUpdateProfileDto {
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
  @IsString()
  @MaxLength(40)
  @IsPhoneField()
  phone?: string | null;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  avatarUrl?: string | null;

  @IsOptional()
  @IsIn([...COMMUNICATION_PREFERENCES, null])
  communicationPreference?: CommunicationPreference | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  clientNotes?: string | null;

  @IsOptional()
  @IsUUID()
  assignedLocationId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  staffDisplayName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  hourlyRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(168)
  contractedHours?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  averageBillBenchmark?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  leaveNotes?: string | null;

  @IsOptional()
  @IsBoolean()
  isBookable?: boolean;
}

export class AdminProfileEmailQueryDto {
  @IsEmail()
  email!: string;
}
