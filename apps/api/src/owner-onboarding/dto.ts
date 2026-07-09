import { Type } from 'class-transformer';
import type { BusinessTier } from '@sheer/domain';
import {
  IsEmail,
  IsIn,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const BUSINESS_TIERS: BusinessTier[] = ['solo', 'studio', 'salon', 'group'];

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const CURRENCY_REGEX = /^[A-Za-z]{3}$/;

export class OwnerOnboardingOwnerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}

export class OwnerOnboardingBusinessDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(SLUG_REGEX, {
    message:
      'Business slug must be 2-40 chars, lowercase letters, numbers, or single dashes (no leading/trailing dash)',
  })
  slug!: string;

  @IsString()
  @Matches(CURRENCY_REGEX, { message: 'Currency must be a 3 letter ISO 4217 code' })
  defaultCurrency!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  defaultTimezone!: string;

  @IsISO31661Alpha2({ message: 'Country code must be a 2 letter ISO 3166-1 alpha-2 code' })
  countryCode!: string;

  @IsOptional()
  @IsIn(BUSINESS_TIERS, { message: 'tier must be one of solo, studio, salon, group' })
  tier?: BusinessTier;
}

export class OwnerOnboardingLocationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(SLUG_REGEX, {
    message:
      'Location slug must be 2-40 chars, lowercase letters, numbers, or single dashes (no leading/trailing dash)',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @IsISO31661Alpha2({ message: 'Country code must be a 2 letter ISO 3166-1 alpha-2 code' })
  countryCode?: string;
}

export class OwnerOnboardingRequestDto {
  @ValidateNested()
  @Type(() => OwnerOnboardingOwnerDto)
  owner!: OwnerOnboardingOwnerDto;

  @ValidateNested()
  @Type(() => OwnerOnboardingBusinessDto)
  business!: OwnerOnboardingBusinessDto;

  @ValidateNested()
  @Type(() => OwnerOnboardingLocationDto)
  location!: OwnerOnboardingLocationDto;
}

export class CheckBusinessSlugDto {
  @IsString()
  @Length(2, 40)
  slug!: string;
}
