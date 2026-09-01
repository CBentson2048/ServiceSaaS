import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
} from 'class-validator';

export class LinkStylistRebookingDto {
  @IsOptional()
  @IsUUID()
  sourceVisitId?: string;

  @IsUUID()
  rebookedAppointmentId!: string;
}

export class RejectBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreateStylistRebookingDto {
  @IsOptional()
  @IsUUID()
  sourceVisitId?: string;

  @IsUUID()
  staffProfileId?: string;

  @IsISO8601()
  selectedStartAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  clientNote?: string;
}

/**
 * Marking a no-show carries no deposit decision: whether a missed appointment
 * forfeits a deposit is a separate product rule, and folding it into a status
 * change would smuggle a charging policy into an attendance fact.
 */
export class MarkNoShowDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // Whether to refund a paid deposit. Defaults to true (refund) when omitted so
  // existing callers keep the auto-refund behaviour; the book sends it explicitly.
  @IsOptional()
  @IsBoolean()
  refundDeposit?: boolean;
}

export class RescheduleAppointmentDto {
  @IsISO8601()
  scheduledStartAt!: string;

  @IsOptional()
  @IsUUID()
  staffProfileId?: string;

  // Optional replacement service list. When present, the appointment's services
  // (and its price/deposit/duration) are replaced with these catalogue IDs. Omit
  // to leave the services untouched. Capped to keep a single edit bounded.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  serviceIds?: string[];

  // Optional new total duration in minutes — resizes the appointment (e.g. a drag
  // on the calendar). The delta vs the current total is applied to the last
  // service/segment. Ignored when serviceIds also changes. Bounded to a sane range.
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(720)
  durationMinutes?: number;
}
