import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { AppSurface } from '@sheer/domain';
import { IsPhoneField } from '../communications/phone-field.decorator';

export class CreateAccountDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(2)
  fullName!: string;

  @IsString()
  @MinLength(2)
  businessName!: string;

  @IsOptional()
  @IsIn(['api', 'web_dashboard'])
  surface?: Extract<AppSurface, 'api' | 'web_dashboard'>;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsIn(['api', 'web_dashboard', 'sheer_app', 'sheer_lab'])
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;
}

export class RefreshSessionDto {
  @IsString()
  refreshToken!: string;

  @IsOptional()
  @IsIn(['api', 'web_dashboard', 'sheer_app', 'sheer_lab'])
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;
}

export class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class PasswordResetRequestDto {
  @IsEmail()
  email!: string;
}

export class PasswordResetInspectQueryDto {
  @IsString()
  @MinLength(20)
  token!: string;
}

export class PasswordResetCompleteDto {
  @IsString()
  @MinLength(20)
  token!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class ClientBookingAccountDto {
  @IsUUID()
  locationId!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @IsPhoneField()
  phone?: string;

  @IsIn(['whatsapp', 'sms', 'email'])
  communicationPreference!: 'whatsapp' | 'sms' | 'email';
}

export class ClientBookingLoginDto {
  @IsUUID()
  locationId!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @IsPhoneField()
  phone?: string;
}
