import { IsString, IsUUID, Length } from 'class-validator';

export class UnlockLabSessionDto {
  @IsUUID()
  deviceId!: string;

  @IsUUID()
  locationId!: string;

  @IsString()
  @Length(4, 4)
  pin!: string;
}

export class LabSessionIdDto {
  @IsString()
  sessionId!: string;
}
