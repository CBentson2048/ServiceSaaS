import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
  type ValidationError,
} from 'class-validator';

/** Shell / CI often sets `PORT=` (empty). Dotenv does not override existing keys, so empty wins over `.env`. */
function normalizePort(value: unknown): unknown {
  const fallback = 3001;
  if (value === '' || value === undefined || value === null) return fallback;
  const s = String(value).trim();
  if (s === '') return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? value : n;
}

export enum NodeEnv {
  Development = 'development',
  Staging = 'staging',
  Production = 'production',
  Test = 'test',
}

export class EnvConfig {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(({ value }) => normalizePort(value))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3001;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsString()
  SUPABASE_URL!: string;

  @IsString()
  SUPABASE_ANON_KEY!: string;

  @IsString()
  SUPABASE_SERVICE_ROLE_KEY!: string;

  /** Resend API key. Optional in dev — when missing, the EmailService logs payloads instead of sending. */
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  /**
   * RFC 5322 sender used by Resend (e.g. `Sheer <team@sheer.app>`). Must be on a verified
   * domain in your Resend account. Falls back to `Sheer <onboarding@resend.dev>` (Resend's
   * test sender) when unset, which can only deliver to the account owner's email.
   */
  @IsOptional()
  @IsString()
  RESEND_FROM_EMAIL?: string;

  /** Bare-email alias for RESEND_FROM_EMAIL. The API wraps it as `Sheer <addr>` for RFC 5322. */
  @IsOptional()
  @IsString()
  RESEND_FROM?: string;

  /** Public base URL the staff invitation link points to. Defaults to the first CORS origin. */
  @IsOptional()
  @IsString()
  STAFF_INVITE_BASE_URL?: string;

  /** Public base URL the password-reset email link points to. Defaults to the first CORS origin. */
  @IsOptional()
  @IsString()
  PASSWORD_RESET_BASE_URL?: string;

  /** Stripe secret key used for server-side PaymentIntent creation. */
  @IsOptional()
  @IsString()
  STRIPE_SECRET_KEY?: string;

  /** Stripe webhook signing secret used to verify incoming payment events. */
  @IsOptional()
  @IsString()
  STRIPE_WEBHOOK_SECRET?: string;
}

/**
 * Validate process.env against EnvConfig.
 * Used by `ConfigModule.forRoot({ validate })`.
 * Keeps a single source of truth for env shape — add new vars here as the API grows.
 */
export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const validated = plainToInstance(EnvConfig, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const message = errors
      .map((e: ValidationError) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return validated;
}
