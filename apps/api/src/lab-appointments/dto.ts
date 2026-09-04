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

// ---------------------------------------------------------------------------
// Post-check-in service lifecycle (0110)
// ---------------------------------------------------------------------------
//
// Line-level operations, never a replacement array: two staff amending the same
// visit at once must both succeed, and a stale screen must not be able to erase
// a colleague's addition. The actor is always the authenticated user — nothing
// here accepts an actor id from the body.

export class AddAppointmentServiceDto {
  @IsUUID()
  serviceId!: string;

  @IsOptional()
  @IsUUID()
  staffProfileId?: string;

  // When present, the named performed line is removed and this service is
  // performed instead — one atomic replacement with one history record.
  @IsOptional()
  @IsUUID()
  replacesAppointmentServiceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // Client-generated; a retried request with the same key returns the original
  // change instead of adding the service twice.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;
}

export class RemoveAppointmentServiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;
}

export class ReassignAppointmentServiceDto {
  @IsUUID()
  staffProfileId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;
}
