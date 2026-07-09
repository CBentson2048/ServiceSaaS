import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  BusinessLocation,
  CreateLocationRequest,
  ListLocationsResponse,
  UpdateLocationRequest,
} from '@sheer/domain';
import {
  BUSINESS_TIER_LABELS,
  getBusinessTierLimits,
  suggestTierUpgrade,
  userHasRole,
  userHasAnyRole,
} from '@sheer/domain';

interface BusinessRow {
  id: string;
  default_country_code: string;
  default_currency_code: string;
  timezone: string;
}

interface LocationRow {
  id: string;
  business_id: string;
  name: string;
  slug: string;
  code: string;
  public_code: string;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string;
  timezone: string;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const CODE_MAX_LENGTH = 12;

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // -------------------------------------------------------------------------
  // Reads (owner + manager)
  // -------------------------------------------------------------------------

  async listForActor(actor: AuthUser): Promise<ListLocationsResponse> {
    this.assertManagerOrOwner(actor);

    let query = this.admin
      .schema('core')
      .from('locations')
      .select(
        'id,business_id,name,slug,code,public_code,address_line_1,address_line_2,city,region,postal_code,country_code,timezone,phone,email,is_active,sort_order,created_at,updated_at',
      )
      .eq('business_id', actor.businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (userHasRole(actor, 'manager')) {
      // Manager only sees the location(s) attached to their active membership.
      // `allowedLocationIds` is computed by AuthService from user_memberships.
      if (actor.allowedLocationIds.length === 0) {
        return { locations: [], scope: 'manager' };
      }
      query = query.in('id', actor.allowedLocationIds);
    }

    const { data, error } = await query.returns<LocationRow[]>();
    if (error) {
      this.logger.error(`listForActor failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load locations');
    }

    return {
      locations: (data ?? []).map(toBusinessLocation),
      scope: userHasRole(actor, 'owner') ? 'owner' : 'manager',
    };
  }

  async getForActor(actor: AuthUser, locationId: string): Promise<BusinessLocation> {
    this.assertManagerOrOwner(actor);

    if (userHasRole(actor, 'manager') && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your assigned scope');
    }

    const row = await this.fetchLocation(actor.businessId, locationId);
    return toBusinessLocation(row);
  }

  // -------------------------------------------------------------------------
  // Owner-only writes
  // -------------------------------------------------------------------------

  async create(actor: AuthUser, input: CreateLocationRequest): Promise<BusinessLocation> {
    this.assertOwner(actor);
    await this.assertLocationTierLimit(actor);

    const business = await this.fetchBusinessDefaults(actor.businessId);
    const slug = normalizeSlug(input.slug);
    if (!SLUG_REGEX.test(slug)) {
      throw new BadRequestException('Slug must be 2-40 lowercase chars (letters, numbers, dashes)');
    }
    await this.assertSlugAvailable(actor.businessId, slug);

    const code = generateCode(slug);
    await this.assertCodeAvailable(actor.businessId, code);

    const row = {
      business_id: actor.businessId,
      name: input.name.trim(),
      slug,
      code,
      timezone: (input.timezone?.trim() || business.timezone || 'Europe/London'),
      phone: input.phone?.trim() || null,
      email: input.email?.trim().toLowerCase() || null,
      address_line_1: input.addressLine1?.trim() ?? '',
      address_line_2: input.addressLine2?.trim() || null,
      city: input.city?.trim() ?? '',
      region: input.region?.trim() || null,
      postal_code: input.postalCode?.trim() ?? '',
      country_code: (input.countryCode?.trim() || business.default_country_code || 'GB').toUpperCase(),
      is_active: true,
    };

    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .insert(row)
      .select(
        'id,business_id,name,slug,code,public_code,address_line_1,address_line_2,city,region,postal_code,country_code,timezone,phone,email,is_active,sort_order,created_at,updated_at',
      )
      .single<LocationRow>();

    if (error || !data) {
      const message = error?.message ?? 'Insert returned no row';
      const lower = message.toLowerCase();
      if (lower.includes('locations_business_id_slug_key')) {
        throw new ConflictException('A location with this slug already exists in your business');
      }
      if (lower.includes('locations_business_id_code_key')) {
        throw new ConflictException('A location with this code already exists in your business');
      }
      this.logger.error(`createLocation insert failed: ${message}`);
      throw new InternalServerErrorException('Unable to create location');
    }

    // Seed the per-location settings row so downstream reporting/policy reads
    // resolve real values (record fields, thresholds, fixed costs all key off it).
    await this.ensureLocationSettings(actor.businessId, data.id, business.default_currency_code);

    return toBusinessLocation(data);
  }

  /**
   * Guarantees a core.location_settings row exists for a location. Uses an upsert
   * on the unique location_id so it is safe to call repeatedly and never clobbers
   * existing settings. All record fields fall back to their column defaults.
   */
  private async ensureLocationSettings(
    businessId: string,
    locationId: string,
    currencyCode: string | null | undefined,
  ): Promise<void> {
    const { error } = await this.admin
      .schema('core')
      .from('location_settings')
      .upsert(
        {
          business_id: businessId,
          location_id: locationId,
          currency_code: (currencyCode || 'GBP').toUpperCase(),
        },
        { onConflict: 'location_id', ignoreDuplicates: true },
      );
    if (error) {
      // Non-fatal: the location exists; settings will also be backfilled by
      // migration/other paths. Log so it is visible but don't fail creation.
      this.logger.error(`ensureLocationSettings failed for ${locationId}: ${error.message}`);
    }
  }

  async update(
    actor: AuthUser,
    locationId: string,
    input: UpdateLocationRequest,
  ): Promise<BusinessLocation> {
    this.assertOwner(actor);
    const existing = await this.fetchLocation(actor.businessId, locationId);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new BadRequestException('Name cannot be empty');
      patch.name = trimmed;
    }

    if (input.slug !== undefined) {
      const slug = normalizeSlug(input.slug);
      if (!SLUG_REGEX.test(slug)) {
        throw new BadRequestException('Slug must be 2-40 lowercase chars (letters, numbers, dashes)');
      }
      if (slug !== existing.slug) {
        await this.assertSlugAvailable(actor.businessId, slug, locationId);
      }
      patch.slug = slug;
    }

    if (input.timezone !== undefined) {
      const trimmed = input.timezone.trim();
      if (!trimmed) throw new BadRequestException('Timezone cannot be empty');
      patch.timezone = trimmed;
    }

    if (input.countryCode !== undefined) {
      patch.country_code = input.countryCode.trim().toUpperCase();
    }

    // Optional / nullable string fields. `null` clears, `''` is treated as null
    // for cleanliness, anything else is trimmed.
    applyOptionalString(patch, 'phone', input.phone, { allowNull: true });
    applyOptionalString(patch, 'email', input.email, { allowNull: true, lowercase: true });
    applyOptionalString(patch, 'address_line_1', input.addressLine1, { defaultEmpty: true });
    applyOptionalString(patch, 'address_line_2', input.addressLine2, { allowNull: true });
    applyOptionalString(patch, 'city', input.city, { defaultEmpty: true });
    applyOptionalString(patch, 'region', input.region, { allowNull: true });
    applyOptionalString(patch, 'postal_code', input.postalCode, { defaultEmpty: true });

    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .update(patch)
      .eq('id', locationId)
      .eq('business_id', actor.businessId)
      .select(
        'id,business_id,name,slug,code,public_code,address_line_1,address_line_2,city,region,postal_code,country_code,timezone,phone,email,is_active,sort_order,created_at,updated_at',
      )
      .single<LocationRow>();

    if (error || !data) {
      const message = error?.message ?? 'Update returned no row';
      if (message.toLowerCase().includes('locations_business_id_slug_key')) {
        throw new ConflictException('A location with this slug already exists in your business');
      }
      this.logger.error(`updateLocation failed: ${message}`);
      throw new InternalServerErrorException('Unable to update location');
    }

    return toBusinessLocation(data);
  }

  deactivate(actor: AuthUser, locationId: string): Promise<BusinessLocation> {
    return this.setActive(actor, locationId, false);
  }

  reactivate(actor: AuthUser, locationId: string): Promise<BusinessLocation> {
    return this.setActive(actor, locationId, true);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async setActive(
    actor: AuthUser,
    locationId: string,
    isActive: boolean,
  ): Promise<BusinessLocation> {
    this.assertOwner(actor);
    await this.fetchLocation(actor.businessId, locationId);

    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', locationId)
      .eq('business_id', actor.businessId)
      .select(
        'id,business_id,name,slug,code,public_code,address_line_1,address_line_2,city,region,postal_code,country_code,timezone,phone,email,is_active,sort_order,created_at,updated_at',
      )
      .single<LocationRow>();

    if (error || !data) {
      this.logger.error(
        `setActive(${isActive}) failed for ${locationId}: ${error?.message ?? 'no row'}`,
      );
      throw new InternalServerErrorException('Unable to update location status');
    }

    return toBusinessLocation(data);
  }

  private assertOwner(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only owners can perform this action');
    }
  }

  /**
   * Block creating a new location when the account tier's location cap is
   * already reached. The error names the tier to upgrade to so the client can
   * surface an upgrade prompt (Solo/Studio → Salon → Group).
   */
  private async assertLocationTierLimit(actor: AuthUser): Promise<void> {
    const tier = actor.businessTier ?? 'solo';
    const { maxLocations } = getBusinessTierLimits(tier);
    if (maxLocations === null) return;

    const { count, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', actor.businessId)
      .eq('is_active', true);

    if (error) {
      this.logger.error(`assertLocationTierLimit count failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify location limit');
    }

    if ((count ?? 0) >= maxLocations) {
      const upgradeTo = suggestTierUpgrade(tier, 'locations');
      const suffix = upgradeTo ? ` Upgrade to ${BUSINESS_TIER_LABELS[upgradeTo]} to add more.` : '';
      throw new ForbiddenException(
        `Your ${BUSINESS_TIER_LABELS[tier]} plan allows up to ${maxLocations} location(s).${suffix}`,
      );
    }
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Locations are accessible to owners and managers only');
    }
  }

  private async fetchLocation(businessId: string, locationId: string): Promise<LocationRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select(
        'id,business_id,name,slug,code,public_code,address_line_1,address_line_2,city,region,postal_code,country_code,timezone,phone,email,is_active,sort_order,created_at,updated_at',
      )
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<LocationRow>();
    if (error) {
      this.logger.error(`fetchLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location');
    }
    if (!data) throw new NotFoundException('Location not found in your business');
    return data;
  }

  private async fetchBusinessDefaults(businessId: string): Promise<BusinessRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('id,default_country_code,default_currency_code,timezone')
      .eq('id', businessId)
      .maybeSingle<BusinessRow>();
    if (error) {
      this.logger.error(`fetchBusinessDefaults failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load business defaults');
    }
    if (!data) throw new NotFoundException('Business not found');
    return data;
  }

  private async assertSlugAvailable(
    businessId: string,
    slug: string,
    ignoreLocationId?: string,
  ): Promise<void> {
    let query = this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('business_id', businessId)
      .eq('slug', slug);
    if (ignoreLocationId) query = query.neq('id', ignoreLocationId);
    const { data, error } = await query.maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertSlugAvailable failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify slug uniqueness');
    }
    if (data) {
      throw new ConflictException('A location with this slug already exists in your business');
    }
  }

  private async assertCodeAvailable(businessId: string, code: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('business_id', businessId)
      .eq('code', code)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertCodeAvailable failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify code uniqueness');
    }
    if (data) {
      throw new ConflictException(
        'A location with a conflicting code exists. Try a slightly different slug.',
      );
    }
  }
}

function toBusinessLocation(row: LocationRow): BusinessLocation {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    slug: row.slug,
    code: row.code,
    publicCode: row.public_code,
    timezone: row.timezone,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    addressLine1: row.address_line_1 ?? undefined,
    addressLine2: row.address_line_2 ?? undefined,
    city: row.city ?? undefined,
    region: row.region ?? undefined,
    postalCode: row.postal_code ?? undefined,
    countryCode: row.country_code,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateCode(slug: string): string {
  const code = slug.replace(/-/g, '_').toUpperCase().slice(0, CODE_MAX_LENGTH);
  return code || `LOC_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

interface ApplyOptions {
  allowNull?: boolean;
  defaultEmpty?: boolean;
  lowercase?: boolean;
}

/** Maps an optional/nullable client-side value into the patch object. */
function applyOptionalString(
  patch: Record<string, unknown>,
  column: string,
  value: string | null | undefined,
  opts: ApplyOptions = {},
): void {
  if (value === undefined) return;
  if (value === null) {
    patch[column] = opts.allowNull ? null : opts.defaultEmpty ? '' : null;
    return;
  }
  const trimmed = opts.lowercase ? value.trim().toLowerCase() : value.trim();
  if (trimmed === '') {
    patch[column] = opts.allowNull ? null : opts.defaultEmpty ? '' : null;
    return;
  }
  patch[column] = trimmed;
}
