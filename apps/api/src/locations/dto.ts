import {
  IsEmail,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

/**
 * Create a location under the caller's business. `code` is generated server-side
 * from the slug (mirrors the owner-onboarding pattern), so we don't accept it
 * from the client.
 */
export class CreateLocationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(SLUG_REGEX, {
    message:
      'Slug must be 2-40 chars, lowercase letters, numbers, or single dashes (no leading/trailing dash)',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

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

/**
 * Partial update. `null` clears optional fields where the schema allows it
 * (phone, email, address_line_2, region). Required NOT NULL columns
 * (name, slug, timezone, address_line_1, city, postal_code) are coerced to
 * empty strings on create — they cannot be set to null via update.
 */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(SLUG_REGEX, {
    message:
      'Slug must be 2-40 chars, lowercase letters, numbers, or single dashes (no leading/trailing dash)',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @MaxLength(254)
  email?: string | null;

  @IsOptional()
  @MaxLength(160)
  addressLine1?: string | null;

  @IsOptional()
  @MaxLength(160)
  addressLine2?: string | null;

  @IsOptional()
  @MaxLength(80)
  city?: string | null;

  @IsOptional()
  @MaxLength(80)
  region?: string | null;

  @IsOptional()
  @MaxLength(20)
  postalCode?: string | null;

  @IsOptional()
  @IsISO31661Alpha2({ message: 'Country code must be a 2 letter ISO 3166-1 alpha-2 code' })
  countryCode?: string;
}
