import { ArrayMaxSize, IsArray, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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

export class CancelAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
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
}
