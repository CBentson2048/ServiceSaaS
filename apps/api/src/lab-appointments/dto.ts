import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
}
