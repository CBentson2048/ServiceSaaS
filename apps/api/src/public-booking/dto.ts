import { Type } from 'class-transformer';
import {
  IsEmail,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PublicBookingSelectionQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  businessSlug?: string;

  @IsOptional()
  @IsString()
  locationSlug?: string;
}

export class PublicBookingStylistsQueryDto extends PublicBookingSelectionQueryDto {
  @IsUUID()
  serviceId!: string;
}

export class PublicBookingAvailabilityQueryDto extends PublicBookingStylistsQueryDto {
  @IsOptional()
  @IsUUID()
  stylistId?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  nextAvailable?: 'true' | 'false';

  @IsISO8601()
  dateFrom!: string;

  @IsISO8601()
  dateTo!: string;
}

export class PublicBookingClientDto {
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
  @MaxLength(180)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}

export class CreatePublicBookingDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  serviceId!: string;

  @IsUUID()
  staffProfileId!: string;

  @IsISO8601()
  selectedStartAt!: string;

  @IsIn(['specific_staff', 'next_available'])
  staffRequestMode!: 'specific_staff' | 'next_available';

  @ValidateNested()
  @Type(() => PublicBookingClientDto)
  client!: PublicBookingClientDto;

  @IsIn(['whatsapp', 'sms', 'email'])
  communicationPreference!: 'whatsapp' | 'sms' | 'email';

  @IsUUID()
  clientProfileId!: string;

  @IsUUID()
  bookedByUserProfileId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  clientNote?: string;
}
