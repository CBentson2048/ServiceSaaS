import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  CreateAccountResponse,
  CurrentUserResponse,
  LoginResponse,
  PasswordResetCompleteResponse,
  PasswordResetInspectResponse,
  PasswordResetRequestResponse,
} from '@sheer/domain';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import {
  ClientBookingAccountDto,
  ClientBookingLoginDto,
  CreateAccountDto,
  CreateCustomerAccountDto,
  LoginDto,
  LogoutDto,
  PasswordResetCompleteDto,
  PasswordResetInspectQueryDto,
  PasswordResetRequestDto,
  RefreshSessionDto,
} from './dto';
import { SupabaseAuthGuard } from './supabase-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  async register(@Body() body: CreateAccountDto): Promise<CreateAccountResponse> {
    return this.auth.createAccount(body);
  }

  @Post('login')
  async login(@Body() body: LoginDto): Promise<LoginResponse> {
    return this.auth.login(body.email, body.password, body.surface);
  }

  @Post('client-booking/register')
  async registerClientForBooking(@Body() body: ClientBookingAccountDto): Promise<LoginResponse> {
    return this.auth.createClientBookingAccount(body);
  }

  // Salon-agnostic customer sign-up (QLOOQO app). Creates a global account with
  // no salon membership yet and returns a `sheer_app` session, exactly like
  // login. The customer joins salons lazily on their first booking.
  @Post('register-customer')
  async registerCustomer(@Body() body: CreateCustomerAccountDto): Promise<LoginResponse> {
    return this.auth.createCustomerAccount(body);
  }

  @Post('client-booking/login')
  async loginClientForBooking(@Body() body: ClientBookingLoginDto): Promise<LoginResponse> {
    return this.auth.loginClientForBooking(body);
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

  // -------------------------------------------------------------------------
  // Public password reset flow (anonymous; no bearer required)
  //
  // Three endpoints, all returning the schema documented in
  // `packages/domain/src/index.ts`:
  //
  //   POST /api/auth/password-reset/request  → always { accepted: true }
  //   GET  /api/auth/password-reset/inspect  → { status, emailMasked?, expiresAt? }
  //   POST /api/auth/password-reset/complete → { success, redirectTo, role, ... }
  //
  // Acceptance and completion only return the user's role — never an
  // access token — because stylist/client are not allowed in the web
  // dashboard. The web client uses `nextAction` to decide whether to
  // send the user to `/login` or to the role-aware completion page.
  // -------------------------------------------------------------------------

  @Post('password-reset/request')
  @HttpCode(200)
  async requestPasswordReset(
    @Body() body: PasswordResetRequestDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PasswordResetRequestResponse> {
    return this.auth.requestPasswordReset(body.email, { ip, userAgent });
  }

  @Get('password-reset/inspect')
  inspectPasswordReset(
    @Query() query: PasswordResetInspectQueryDto,
  ): Promise<PasswordResetInspectResponse> {
    return this.auth.inspectPasswordResetToken(query.token);
  }

  @Post('password-reset/complete')
  completePasswordReset(
    @Body() body: PasswordResetCompleteDto,
  ): Promise<PasswordResetCompleteResponse> {
    return this.auth.completePasswordReset(body.token, body.password);
  }
}

function extractBearer(authorization?: string): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim() || undefined;
}
