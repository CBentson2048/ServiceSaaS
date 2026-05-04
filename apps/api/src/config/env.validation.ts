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
