import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import type { AppSurface } from '@sheer/domain';

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
