import { IsOptional, IsString, IsUUID } from 'class-validator';

export class RegisterLabDeviceDto {
  @IsUUID()
  businessId!: string;

  @IsUUID()
  locationId!: string;

  @IsString()
  deviceName!: string;

  @IsOptional()
  @IsString()
  stationLabel?: string;
}

export class PairScaleDto {
  @IsString()
  bleDeviceIdentifier!: string;

  @IsOptional()
  @IsString()
  bleDeviceName?: string;

  @IsOptional()
  @IsString()
  deviceModel?: string;
}
