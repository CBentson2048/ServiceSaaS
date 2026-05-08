import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { AbsenceType, ShiftStatus } from '@sheer/domain';

const SHIFT_STATUSES: ShiftStatus[] = ['draft', 'published', 'completed', 'cancelled'];
const ABSENCE_TYPES: AbsenceType[] = [
  'sickness',
  'emergency',
  'bereavement',
  'unauthorised',
  'other',
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Query params for `GET /api/rota/week`.
 *
 * - `weekStart` is an ISO date (`YYYY-MM-DD`) representing Monday of the
 *   target week, interpreted in the location's timezone.
 * - `locationId` is optional for managers; the service falls back to the
 *   single allowedLocationId on the actor. Owners must specify it.
 */
export class GetWeeklyRotaQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsString()
  @Matches(ISO_DATE, { message: 'weekStart must be an ISO date (YYYY-MM-DD)' })
  weekStart!: string;
}

export class CreateShiftDto {
  @IsUUID()
  staffProfileId!: string;

  @IsUUID()
  locationId!: string;

  @IsISO8601()
  scheduledStartAt!: string;

  @IsISO8601()
  scheduledEndAt!: string;

  @IsOptional()
  @IsIn(SHIFT_STATUSES)
  status?: ShiftStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  pastEditReason?: string;
}

export class UpdateShiftDto {
  @IsOptional()
  @IsISO8601()
  scheduledStartAt?: string;

  @IsOptional()
  @IsISO8601()
  scheduledEndAt?: string;

  @IsOptional()
  @IsIn(SHIFT_STATUSES)
  status?: ShiftStatus;

  @IsOptional()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  pastEditReason?: string;
}

export class CreateBreakDto {
  @IsISO8601()
  startedAt!: string;

  @IsISO8601()
  endedAt!: string;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  pastEditReason?: string;
}

export class UpdateBreakDto {
  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  @IsOptional()
  @IsISO8601()
  endedAt?: string;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsOptional()
  @MaxLength(300)
  notes?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  pastEditReason?: string;
}

export class ListLeaveRequestsQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'cancelled', 'all'])
  status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'all';
}

export class ApproveLeaveRequestDto {
  @IsOptional()
  @IsBoolean()
  override?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewerNote?: string;
}

export class RejectLeaveRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreateMyLeaveRequestDto {
  @IsString()
  @Matches(ISO_DATE, { message: 'startDate must be an ISO date (YYYY-MM-DD)' })
  startDate!: string;

  @IsString()
  @Matches(ISO_DATE, { message: 'endDate must be an ISO date (YYYY-MM-DD)' })
  endDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreateAbsenceDto {
  @IsUUID()
  staffProfileId!: string;

  @IsUUID()
  locationId!: string;

  @IsIn(ABSENCE_TYPES)
  absenceType!: AbsenceType;

  @IsISO8601()
  startsAt!: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SaveWeeklyRotaShiftDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsUUID()
  staffProfileId!: string;

  @IsISO8601()
  scheduledStartAt!: string;

  @IsISO8601()
  scheduledEndAt!: string;

  @IsOptional()
  @IsIn(SHIFT_STATUSES)
  status?: ShiftStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SaveWeeklyRotaDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @Matches(ISO_DATE, { message: 'weekStart must be an ISO date (YYYY-MM-DD)' })
  weekStart!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SaveWeeklyRotaShiftDto)
  shifts!: SaveWeeklyRotaShiftDto[];

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  pastEditReason?: string;
}

export class PreviewNewWeekDto {
  @IsString()
  @Matches(ISO_DATE, { message: 'weekStart must be an ISO date (YYYY-MM-DD)' })
  weekStart!: string;

  @IsIn(['blank', 'clone_last_week', 'generate_from_defaults'])
  creationMode!: 'blank' | 'clone_last_week' | 'generate_from_defaults';

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class CreateNewWeekDto {
  @IsString()
  @Matches(ISO_DATE, { message: 'weekStart must be an ISO date (YYYY-MM-DD)' })
  weekStart!: string;

  @IsIn(['blank', 'clone_last_week', 'generate_from_defaults'])
  creationMode!: 'blank' | 'clone_last_week' | 'generate_from_defaults';

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => NewWeekDraftShiftDto)
  shifts?: NewWeekDraftShiftDto[];
}

export class NewWeekDraftBreakDto {
  @IsISO8601()
  startedAt!: string;

  @IsISO8601()
  endedAt!: string;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class NewWeekDraftShiftDto {
  @IsUUID()
  staffProfileId!: string;

  @IsISO8601()
  scheduledStartAt!: string;

  @IsISO8601()
  scheduledEndAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => NewWeekDraftBreakDto)
  breaks?: NewWeekDraftBreakDto[];
}
