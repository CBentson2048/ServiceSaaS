import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const INVITABLE_ROLES = ['manager', 'stylist'] as const;

export class CreateStaffInvitationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsIn(INVITABLE_ROLES)
  role!: (typeof INVITABLE_ROLES)[number];

  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsHexColor()
  colorHex?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 30)
  expiresInHours?: number;
}

export class ListStaffInvitationsQueryDto {
  @IsOptional()
  @IsIn(['pending', 'accepted', 'revoked', 'expired', 'all'])
  status?: 'pending' | 'accepted' | 'revoked' | 'expired' | 'all';
}

export class AcceptStaffInvitationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(256)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}

export class InspectInvitationQueryDto {
  @IsString()
  @MinLength(20)
  @MaxLength(256)
  token!: string;
}

export class UpdateStaffMemberDto {
  // Full desired set of the member's roles at their location. When present, the
  // member's role memberships are synced to exactly these (manager and/or stylist).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(INVITABLE_ROLES, { each: true })
  roles?: (typeof INVITABLE_ROLES)[number][];

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['active', 'suspended', 'revoked'])
  membershipStatus?: 'active' | 'suspended' | 'revoked';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsHexColor()
  colorHex?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @IsOptional()
  @IsBoolean()
  isBookable?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  hourlyRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(168)
  contractedHours?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  averageBillBenchmark?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  leaveNotes?: string | null;

  // Full replacement set of services this stylist can perform. When present,
  // eligibility is replaced with exactly these IDs; omit to leave unchanged.
  // Legacy alias for `serviceAssignments` with no per-stylist prices.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  serviceIds?: string[];

  // Full replacement set of services this stylist can perform, each with an
  // optional per-stylist price (major currency units; omit/null inherits the
  // service base price). Takes precedence over `serviceIds` when present.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StaffServiceAssignmentDto)
  serviceAssignments?: StaffServiceAssignmentDto[];
}

export class StaffServiceAssignmentDto {
  @IsUUID()
  serviceId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  priceAmount?: number | null;
}
