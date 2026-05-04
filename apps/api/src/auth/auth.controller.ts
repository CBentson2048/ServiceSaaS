import { Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { CurrentUserResponse, LoginResponse } from '@sheer/domain';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto, LogoutDto, RefreshSessionDto } from './dto';
import { SupabaseAuthGuard } from './supabase-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() body: LoginDto): Promise<LoginResponse> {
    return this.auth.login(body.email, body.password, body.surface);
  }

  @Post('refresh')
  async refresh(@Body() body: RefreshSessionDto): Promise<LoginResponse> {
    return this.auth.refresh(body.refreshToken, body.surface);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() body: LogoutDto,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    await this.auth.logout(extractBearer(authorization), body.refreshToken);
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  me(@CurrentUser() user: CurrentUserResponse['user']): CurrentUserResponse {
    return { user };
  }
}

function extractBearer(authorization?: string): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim() || undefined;
}
