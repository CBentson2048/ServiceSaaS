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

  /** Bare-email alias for RESEND_FROM_EMAIL. The API wraps it as `QLOOQO <addr>` for RFC 5322. */
  @IsOptional()
  @IsString()
  RESEND_FROM?: string;

  /**
   * Resend (Svix) webhook signing secret — `whsec_…` — for the email delivery/bounce webhook at
   * `POST /api/email/status`. Optional in dev; when unset the webhook rejects all requests (the
   * email channel then advances to `delivered`/`failed` only if/when configured). A hard bounce on
   * this webhook escalates the notification to SMS.
   */
  @IsOptional()
  @IsString()
  RESEND_WEBHOOK_SECRET?: string;

  /**
   * Default region (ISO-3166 alpha-2, e.g. `GB`) used to parse national-format phone numbers
   * (leading `0`, or bare, no `+`) into E.164 for WhatsApp/SMS eligibility + delivery. Preferred over
   * DEFAULT_PHONE_COUNTRY_CALLING_CODE. When neither is set the platform default region (GB) is used.
   */
  @IsOptional()
  @IsString()
  DEFAULT_PHONE_COUNTRY?: string;

  /**
   * Legacy: default country calling code (digits only, e.g. `44` for the UK). Still honoured (mapped to
   * a region) for backward compatibility; prefer DEFAULT_PHONE_COUNTRY.
   */
  @IsOptional()
  @IsString()
  DEFAULT_PHONE_COUNTRY_CALLING_CODE?: string;

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

  /** Server-side pepper for hashing Sheer Lab PINs. Required before real PIN credentials are issued. */
  @IsOptional()
  @IsString()
  SHEER_LAB_PIN_PEPPER?: string;

  /** Server-side pepper for hashing shared Sheer Lab device session tokens. */
  @IsOptional()
  @IsString()
  SHEER_LAB_DEVICE_TOKEN_PEPPER?: string;

  /**
   * Twilio Account SID for WhatsApp booking notifications. Optional in dev — when any of the
   * three Twilio vars is missing, WhatsAppService logs payloads instead of delivering.
   */
  @IsOptional()
  @IsString()
  TWILIO_ACCOUNT_SID?: string;

  /** Twilio Auth Token paired with TWILIO_ACCOUNT_SID. */
  @IsOptional()
  @IsString()
  TWILIO_AUTH_TOKEN?: string;

  /** Twilio WhatsApp sender number, e.g. `+14155238886` (sandbox). The `whatsapp:` prefix is added. */
  @IsOptional()
  @IsString()
  TWILIO_WHATSAPP_FROM?: string;

  /**
   * Twilio Messaging Service SID (`MGxx...`). Preferred sender for both WhatsApp and SMS — when set,
   * messages go out via the Messaging Service (sender pool, compliance) instead of a single number.
   */
  @IsOptional()
  @IsString()
  TWILIO_MESSAGING_SERVICE_SID?: string;

  /** Twilio SMS sender number, e.g. `+441234567890`. Fallback sender for SMS when no Messaging Service. */
  @IsOptional()
  @IsString()
  TWILIO_SMS_FROM?: string;

  /** Approved Twilio Content template SID (`HXxx...`) for the booking confirmation WhatsApp. */
  @IsOptional()
  @IsString()
  TWILIO_WHATSAPP_CONFIRMATION_CONTENT_SID?: string;

  /** Approved Twilio Content template SID (`HXxx...`) for the 2-hour reminder WhatsApp. */
  @IsOptional()
  @IsString()
  TWILIO_WHATSAPP_REMINDER_2H_CONTENT_SID?: string;

  /** Approved Twilio Content template SID (`HXxx...`) for the 24-hour reminder WhatsApp. */
  @IsOptional()
  @IsString()
  TWILIO_WHATSAPP_REMINDER_24H_CONTENT_SID?: string;

  /** Approved Twilio Content template SID (`HXxx...`) for the 48-hour reminder WhatsApp. */
  @IsOptional()
  @IsString()
  TWILIO_WHATSAPP_REMINDER_48H_CONTENT_SID?: string;

  /** Approved Twilio Content template SID (`HXxx...`) for the 1-week reminder WhatsApp (optional). */
  @IsOptional()
  @IsString()
  TWILIO_WHATSAPP_REMINDER_1W_CONTENT_SID?: string;

  // Legacy aliases for the Content template SIDs — accepted as a fallback by WhatsAppTemplateConfig so
  // an env configured under the older `TWILIO_TEMPLATE_BOOKING_*_SID` convention still works.
  @IsOptional()
  @IsString()
  TWILIO_TEMPLATE_BOOKING_CONFIRMATION_SID?: string;

  @IsOptional()
  @IsString()
  TWILIO_TEMPLATE_BOOKING_REMINDER_2H_SID?: string;

  @IsOptional()
  @IsString()
  TWILIO_TEMPLATE_BOOKING_REMINDER_24H_SID?: string;

  @IsOptional()
  @IsString()
  TWILIO_TEMPLATE_BOOKING_REMINDER_48H_SID?: string;

  @IsOptional()
  @IsString()
  TWILIO_TEMPLATE_BOOKING_REMINDER_1W_SID?: string;

  /**
   * Public URL Twilio posts delivery-status callbacks to, e.g.
   * `https://api.yourdomain.com/api/twilio/messaging/status`. Passed as `StatusCallback` on every
   * send so `comms.message_logs` can advance queued → sent → delivered/failed/undelivered/read.
   * Also used to verify the inbound `X-Twilio-Signature` when behind a proxy that rewrites Host.
   */
  @IsOptional()
  @IsString()
  TWILIO_STATUS_CALLBACK_URL?: string;

  /** Public URL configured in Twilio for inbound WhatsApp replies (used for signature verification behind a proxy). */
  @IsOptional()
  @IsString()
  TWILIO_INBOUND_CALLBACK_URL?: string;

  /** Set to `false` to disable the background notification dispatcher (e.g. in tests/CI). Defaults on. */
  @IsOptional()
  @IsString()
  COMMS_DISPATCH_ENABLED?: string;

  /** Dispatcher poll interval in ms (default 60000, clamped 5000–3600000). */
  @IsOptional()
  @IsString()
  COMMS_DISPATCH_INTERVAL_MS?: string;

  /** Max events processed per dispatcher tick (default 25). */
  @IsOptional()
  @IsString()
  COMMS_DISPATCH_BATCH_SIZE?: string;

  /** Max send attempts before a notification event is marked failed (default 3). */
  @IsOptional()
  @IsString()
  COMMS_DISPATCH_MAX_ATTEMPTS?: string;

  /** Max full batches a single dispatcher tick may drain for downtime catch-up (default 20). */
  @IsOptional()
  @IsString()
  COMMS_DISPATCH_MAX_DRAIN_BATCHES?: string;

  /**
   * Set to `true` to include HTTP request/response bodies in the application log.
   * LOCAL DEVELOPMENT ONLY — ordinary QLOOQO payloads carry client and staff
   * personal data (names, emails, phone numbers, and free-text notes that often
   * contain health information). Logs have a different access model and retention
   * period from the database and sit outside subject-access/erasure processes, so
   * this must stay unset in every deployed environment. Even when enabled,
   * credential and personal-data keys are redacted and `/api/zac` and
   * `/api/payroll` bodies remain suppressed. Defaults off.
   */
  @IsOptional()
  @IsString()
  LOG_HTTP_BODIES?: string;

  /**
   * Kill-switch for the ZAC assistant. ZAC is ON by default (general
   * availability); set exactly `false` to hide every `/api/zac/*` route (404)
   * regardless of the `zac.access` permission. Unset or any other value leaves
   * ZAC enabled.
   */
  @IsOptional()
  @IsString()
  ZAC_ENABLED?: string;

  /**
   * Optional comma-separated business-id allowlist for a controlled ZAC rollout.
   * When set, only the listed businesses can reach ZAC (others get 404 even with
   * ZAC enabled and `zac.access` held). Unset/empty = no business restriction —
   * the default now that ZAC is generally available.
   */
  @IsOptional()
  @IsString()
  ZAC_ALLOWED_BUSINESS_IDS?: string;

  /**
   * Anthropic API key for the ZAC live model provider. Optional: when unset,
   * ZAC binds the deterministic stub provider (local dev, CI, dark builds) and
   * every answer stays template-composed — no network call, no key needed.
   */
  @IsOptional()
  @IsString()
  ANTHROPIC_API_KEY?: string;

  /** ZAC model id (defaults to claude-opus-5 in code) — a config choice, not a code edit. */
  @IsOptional()
  @IsString()
  ZAC_MODEL_ID?: string;

  /** Max output tokens per ZAC narration (default 8192; the cap covers thinking + text). */
  @IsOptional()
  @IsString()
  ZAC_MODEL_MAX_TOKENS?: string;

  /**
   * Live-provider pricing in USD per million tokens (decision D33: configurable
   * planning constants, never hardcoded vendor prices). Set from the provider's
   * official pricing page at deploy time; unset = cost estimates report 0 and
   * the provider logs a startup warning.
   */
  @IsOptional()
  @IsString()
  ZAC_PRICE_INPUT_USD_PER_MTOK?: string;

  @IsOptional()
  @IsString()
  ZAC_PRICE_OUTPUT_USD_PER_MTOK?: string;

  @IsOptional()
  @IsString()
  ZAC_PRICE_CACHE_READ_USD_PER_MTOK?: string;

  @IsOptional()
  @IsString()
  ZAC_PRICE_CACHE_WRITE_USD_PER_MTOK?: string;
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
