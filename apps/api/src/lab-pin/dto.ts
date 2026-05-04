import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class AssignLabPinDto {
  @IsUUID()
  businessId!: string;

  @IsUUID()
  locationId!: string;

  @IsUUID()
  userProfileId!: string;

  @IsString()
  @Length(4, 4)
  pin!: string;
}

export class ResetLabPinDto {
  @IsUUID()
  businessId!: string;

  @IsUUID()
  locationId!: string;

  @IsUUID()
  userProfileId!: string;
}

export class PinStatusQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
