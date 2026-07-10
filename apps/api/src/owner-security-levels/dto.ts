import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ALL_PERMISSIONS, type Permission, type SecurityLevelBaseRole } from '@sheer/domain';

const BASE_ROLES: readonly SecurityLevelBaseRole[] = ['owner', 'manager', 'stylist'];
const PERMISSION_KEYS = [...ALL_PERMISSIONS] as string[];

export class CreateSecurityLevelDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @ValidateIf((o) => o.description !== null)
  @IsString()
  @MaxLength(280)
  description?: string | null;

  @IsIn(BASE_ROLES)
  baseRole!: SecurityLevelBaseRole;

  @IsArray()
  @ArrayUnique()
  @IsIn(PERMISSION_KEYS, { each: true })
  permissions!: Permission[];
}

export class UpdateSecurityLevelDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @ValidateIf((o) => o.description !== null)
  @IsString()
  @MaxLength(280)
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(PERMISSION_KEYS, { each: true })
  permissions?: Permission[];
}
