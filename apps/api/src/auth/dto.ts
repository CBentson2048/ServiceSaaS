import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import type { AppSurface } from '@sheer/domain';

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
  @IsIn(['api', 'web_dashboard', 'sheer_app'])
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app'>;
}

export class RefreshSessionDto {
  @IsString()
  refreshToken!: string;

  @IsOptional()
  @IsIn(['api', 'web_dashboard', 'sheer_app'])
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app'>;
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
