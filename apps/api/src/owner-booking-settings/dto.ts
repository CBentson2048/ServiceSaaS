import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateLocationCommunicationSettingsDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  sendBookingConfirmation?: boolean;

  @IsOptional()
  @IsBoolean()
  reminder24hEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  reminder48hEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  reminder1wEnabled?: boolean;
}

export class UpsertServiceRequirementRuleDto {
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsUUID()
  triggerServiceId!: string;

  @IsString()
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  requiredServiceIds!: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpsertServiceUpgradeSuggestionDto {
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsUUID()
  triggerServiceId!: string;

  @IsUUID()
  suggestedServiceId!: string;

  @IsString()
  @MaxLength(120)
  title!: string;

  @IsString()
  @MaxLength(300)
  description!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
