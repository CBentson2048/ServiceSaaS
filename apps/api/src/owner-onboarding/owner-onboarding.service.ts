import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthSession,
  AuthUser,
  BusinessSlugAvailabilityResponse,
  BusinessTier,
  OwnerOnboardingBootstrap,
  OwnerOnboardingRequest,
  OwnerOnboardingResponse,
} from '@sheer/domain';
import { AuthService } from '../auth/auth.service';

interface BootstrapRow {
  user_profile_id: string;
  business_id: string;
  location_id: string;
  membership_id: string;
}

const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'console',
  'dashboard',
  'help',
  'login',
  'logout',
  'onboarding',
  'owner',
  'public',
  'register',
  'settings',
  'sheer',
  'signin',
  'signup',
  'static',
  'support',
  'system',
  'www',
]);

const DEFAULT_BOOTSTRAP: OwnerOnboardingBootstrap = {
  defaultCurrency: 'GBP',
  defaultTimezone: 'Europe/London',
  defaultCountryCode: 'GB',
  currencies: [
    { code: 'GBP', label: 'British Pound (£)' },
    { code: 'EUR', label: 'Euro (€)' },
    { code: 'USD', label: 'US Dollar ($)' },
    { code: 'AED', label: 'UAE Dirham (د.إ)' },
    { code: 'AUD', label: 'Australian Dollar (A$)' },
    { code: 'CAD', label: 'Canadian Dollar (C$)' },
    { code: 'CHF', label: 'Swiss Franc (CHF)' },
    { code: 'NZD', label: 'New Zealand Dollar (NZ$)' },
  ],
  timezones: [
    { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
    { value: 'Europe/Dublin', label: 'Europe/Dublin' },
    { value: 'Europe/Paris', label: 'Europe/Paris' },
    { value: 'Europe/Madrid', label: 'Europe/Madrid' },
    { value: 'Europe/Berlin', label: 'Europe/Berlin' },
    { value: 'Europe/Rome', label: 'Europe/Rome' },
    { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam' },
    { value: 'America/New_York', label: 'America/New_York' },
    { value: 'America/Chicago', label: 'America/Chicago' },
    { value: 'America/Denver', label: 'America/Denver' },
    { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
    { value: 'America/Toronto', label: 'America/Toronto' },
    { value: 'Asia/Dubai', label: 'Asia/Dubai' },
    { value: 'Asia/Singapore', label: 'Asia/Singapore' },
    { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
    { value: 'Australia/Sydney', label: 'Australia/Sydney' },
  ],
  countries: [
    { code: 'GB', label: 'United Kingdom' },
    { code: 'IE', label: 'Ireland' },
    { code: 'FR', label: 'France' },
    { code: 'DE', label: 'Germany' },
    { code: 'ES', label: 'Spain' },
    { code: 'IT', label: 'Italy' },
    { code: 'NL', label: 'Netherlands' },
    { code: 'US', label: 'United States' },
    { code: 'CA', label: 'Canada' },
    { code: 'AE', label: 'United Arab Emirates' },
    { code: 'AU', label: 'Australia' },
    { code: 'NZ', label: 'New Zealand' },
  ],
};

@Injectable()
export class OwnerOnboardingService {
  private readonly logger = new Logger(OwnerOnboardingService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly auth: AuthService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  getBootstrap(): OwnerOnboardingBootstrap {
    return DEFAULT_BOOTSTRAP;
  }

  async checkBusinessSlug(rawSlug: string): Promise<BusinessSlugAvailabilityResponse> {
    const slug = normalizeSlug(rawSlug);
    if (!slug) {
      return { slug: rawSlug, available: false, reason: 'Slug cannot be empty' };
    }
    if (RESERVED_SLUGS.has(slug)) {
      return { slug, available: false, reason: 'This slug is reserved' };
    }

    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('id')
      .eq('slug', slug)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`checkBusinessSlug query failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to check slug availability');
    }

    if (data) {
      return { slug, available: false, reason: 'A business with this slug already exists' };
    }

    return { slug, available: true };
  }

  async register(input: OwnerOnboardingRequest): Promise<OwnerOnboardingResponse> {
    const owner = sanitizeOwner(input.owner);
    const business = sanitizeBusiness(input.business);
    const location = sanitizeLocation(input.location, business);

    if (RESERVED_SLUGS.has(business.slug)) {
      throw new ConflictException('This business slug is reserved, please pick another');
    }

    // Pre-flight checks. These are best-effort: the database still
    // enforces uniqueness so we cannot rely on them, but they let us
    // surface friendly errors before creating the auth user.
    await this.assertEmailNotTaken(owner.email);
    const slugCheck = await this.checkBusinessSlug(business.slug);
    if (!slugCheck.available) {
      throw new ConflictException(slugCheck.reason ?? 'Business slug is not available');
    }

    let createdUserId: string | undefined;

    try {
      const { data: createdUser, error: createError } = await this.admin.auth.admin.createUser({
        email: owner.email,
        password: owner.password,
        email_confirm: true,
        phone: owner.phone || undefined,
        user_metadata: {
          full_name: owner.fullName,
          first_name: owner.firstName,
          last_name: owner.lastName,
          onboarding_role: 'owner',
        },
      });

      if (createError || !createdUser.user) {
        throw this.describeCreateUserError(createError);
      }

      createdUserId = createdUser.user.id;

      const { data: bootstrapRows, error: bootstrapError } = await this.admin
        .schema('core')
        .rpc('bootstrap_owner_business', {
          p_user_id: createdUserId,
          p_email: owner.email,
          p_full_name: owner.fullName,
          p_phone: owner.phone ?? '',
          p_business_name: business.name,
          p_business_slug: business.slug,
          p_business_currency: business.defaultCurrency,
          p_business_country: business.countryCode,
          p_business_timezone: business.defaultTimezone,
          p_location_name: location.name,
          p_location_slug: location.slug,
          p_location_code: location.code,
          p_location_phone: location.phone ?? '',
          p_location_email: location.email ?? '',
          p_location_timezone: location.timezone,
          p_location_address_line_1: location.addressLine1 ?? '',
          p_location_address_line_2: location.addressLine2 ?? '',
          p_location_city: location.city ?? '',
          p_location_region: location.region ?? '',
          p_location_postal_code: location.postalCode ?? '',
          p_location_country: location.countryCode,
          p_business_tier: business.tier,
        });

      if (bootstrapError || !bootstrapRows) {
        throw this.translateBootstrapError(bootstrapError?.message ?? 'Bootstrap failed');
      }

      const row = pickBootstrapRow(bootstrapRows);
      if (!row) {
        throw new InternalServerErrorException('Bootstrap helper returned no rows');
      }

      const session = await this.tryAutoSignIn(owner.email, owner.password);

      return {
        userProfileId: row.user_profile_id,
        businessId: row.business_id,
        locationId: row.location_id,
        nextStep: session ? 'dashboard' : 'sign_in',
        redirectTo: session ? '/dashboard' : '/login?onboarded=1',
        // Owner onboarding always produces an `owner` role on the web
        // dashboard. We surface those constants explicitly so the web
        // client can use the same role-aware switch it uses for the
        // staff invitation acceptance response.
        role: 'owner',
        targetSurface: 'web',
        nextAction: 'redirect_to_dashboard',
        session: session?.session,
        user: session?.user,
      };
    } catch (error) {
      await this.rollbackAuthUser(createdUserId);
      throw this.toHttpError(error);
    }
  }

  private async tryAutoSignIn(
    email: string,
    password: string,
  ): Promise<{ session: AuthSession; user: AuthUser } | undefined> {
    try {
      const result = await this.auth.login(email, password, 'web_dashboard');
      return { session: result.session, user: result.user };
    } catch (error) {
      this.logger.warn(
        `Owner onboarding succeeded but auto sign-in failed for ${email}: ${
          (error as Error).message
        }`,
      );
      return undefined;
    }
  }

  private async assertEmailNotTaken(email: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`assertEmailNotTaken query failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify email availability');
    }
    if (data) {
      throw new ConflictException('An account already exists for this email');
    }
  }

  /**
   * Turns a Supabase auth `createUser` failure into a precise, honest error.
   *
   * `auth.users` has a UNIQUE index on `phone` as well as `email`, and the
   * owner form submits an optional phone. When that phone is already used by
   * another auth user (a prior owner, or an accepted staff invitation) gotrue
   * rejects the create. The previous handler pattern-matched any
   * "already/exists/registered" message and blamed the email — which is very
   * confusing when the tester is deliberately using a fresh email each time.
   * We now use the structured error `code` (with a message fallback) so a
   * duplicate phone reports as a phone conflict and only a real duplicate
   * email reports as an email conflict.
   */
  private describeCreateUserError(error: { message?: string; code?: string } | null): Error {
    const message = error?.message ?? 'Unable to create owner account';
    const code = error?.code ?? '';
    const normalized = message.toLowerCase();

    const isPhoneConflict =
      code === 'phone_exists' ||
      (normalized.includes('phone') && /already|exists|registered|taken/.test(normalized));
    if (isPhoneConflict) {
      return new ConflictException(
        'This phone number is already registered to another account. Use a different number or leave it blank.',
      );
    }

    const isEmailConflict =
      code === 'email_exists' ||
      code === 'user_already_exists' ||
      (/already|exists|registered/.test(normalized) &&
        (normalized.includes('email') || normalized.includes('user')));
    if (isEmailConflict) {
      return new ConflictException('An account already exists for this email');
    }

    return new BadRequestException(message);
  }

  private async rollbackAuthUser(userId?: string): Promise<void> {
    if (!userId) return;
    try {
      await this.admin.auth.admin.deleteUser(userId);
    } catch (error) {
      this.logger.error(
        `Failed to roll back auth user ${userId} after onboarding failure: ${
          (error as Error).message
        }`,
      );
    }
  }

  private translateBootstrapError(message: string): Error {
    const normalized = message.toLowerCase();
    if (normalized.includes('businesses_slug_key') || normalized.includes('slug')) {
      return new ConflictException('This business slug is already taken');
    }
    if (normalized.includes('locations_business_id_slug_key')) {
      return new ConflictException('This location slug is already taken inside the business');
    }
    if (normalized.includes('locations_business_id_code_key')) {
      return new ConflictException('This location code is already taken inside the business');
    }
    if (normalized.includes('user_profiles_email_key')) {
      return new ConflictException('An account already exists for this email');
    }
    this.logger.error(`bootstrap_owner_business failed: ${message}`);
    return new InternalServerErrorException('Unable to provision owner business');
  }

  private toHttpError(error: unknown): Error {
    if (error instanceof BadRequestException) return error;
    if (error instanceof ConflictException) return error;
    if (error instanceof InternalServerErrorException) return error;
    this.logger.error(`Unhandled onboarding error: ${(error as Error).message ?? error}`);
    return new InternalServerErrorException('Owner onboarding failed unexpectedly');
  }
}

interface SanitizedOwner {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  password: string;
  phone?: string;
}

interface SanitizedBusiness {
  name: string;
  slug: string;
  defaultCurrency: string;
  defaultTimezone: string;
  countryCode: string;
  tier: BusinessTier;
}

interface SanitizedLocation {
  name: string;
  slug: string;
  code: string;
  phone?: string;
  email?: string;
  timezone: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
}

function sanitizeOwner(input: OwnerOnboardingRequest['owner']): SanitizedOwner {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    email: input.email.trim().toLowerCase(),
    password: input.password,
    phone: input.phone?.trim() || undefined,
  };
}

const VALID_TIERS: readonly BusinessTier[] = ['solo', 'studio', 'salon', 'group'];

function sanitizeBusiness(input: OwnerOnboardingRequest['business']): SanitizedBusiness {
  return {
    name: input.name.trim(),
    slug: normalizeSlug(input.slug),
    defaultCurrency: input.defaultCurrency.trim().toUpperCase(),
    defaultTimezone: input.defaultTimezone.trim(),
    countryCode: input.countryCode.trim().toUpperCase(),
    tier: input.tier && VALID_TIERS.includes(input.tier) ? input.tier : 'solo',
  };
}

function sanitizeLocation(
  input: OwnerOnboardingRequest['location'],
  business: SanitizedBusiness,
): SanitizedLocation {
  const slug = normalizeSlug(input.slug);
  const code = slug.replace(/-/g, '_').toUpperCase().slice(0, 12) || `LOC_${randomSuffix()}`;
  return {
    name: input.name.trim(),
    slug,
    code,
    phone: input.phone?.trim() || undefined,
    email: input.email?.trim().toLowerCase() || undefined,
    timezone: input.timezone?.trim() || business.defaultTimezone,
    addressLine1: input.addressLine1?.trim() || undefined,
    addressLine2: input.addressLine2?.trim() || undefined,
    city: input.city?.trim() || undefined,
    region: input.region?.trim() || undefined,
    postalCode: input.postalCode?.trim() || undefined,
    countryCode: (input.countryCode?.trim() || business.countryCode).toUpperCase(),
  };
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function pickBootstrapRow(value: unknown): BootstrapRow | undefined {
  if (Array.isArray(value)) {
    return value[0] as BootstrapRow | undefined;
  }
  if (value && typeof value === 'object') {
    return value as BootstrapRow;
  }
  return undefined;
}
