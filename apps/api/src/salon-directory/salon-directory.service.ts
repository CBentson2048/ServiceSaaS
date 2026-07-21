import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PublicSalonSummary } from '@sheer/domain';

interface SalonRow {
  id: string;
  business_id: string;
  name: string;
  slug: string;
  public_code: string;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
  businesses: { name: string; slug: string } | { name: string; slug: string }[] | null;
}

interface StaffQCodeRow {
  primary_location_id: string;
}

interface BusinessMatchRow {
  id: string;
}

const SALON_COLUMNS =
  'id,business_id,name,slug,public_code,city,region,postal_code,country_code,phone,businesses!inner(name,slug)';

const SEARCH_LIMIT = 20;

/**
 * Public discovery of salons/locations by Salon Code, salon name, or a
 * provider's Q Code. Only active locations and public-safe fields are exposed.
 */
@Injectable()
export class SalonDirectoryService {
  private readonly logger = new Logger(SalonDirectoryService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Resolve exactly one salon from an exact (normalized) Salon Code, or null. */
  async lookupByCode(rawCode: string): Promise<PublicSalonSummary | null> {
    const code = normalizeCode(rawCode);
    if (!code) return null;

    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select(SALON_COLUMNS)
      .eq('is_active', true)
      .eq('public_code', code)
      .maybeSingle<SalonRow>();

    if (error) {
      this.logger.error(`lookupByCode failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve Salon Code');
    }
    return data ? toSalonSummary(data) : null;
  }

  /** Resolve the active salon a currently-active provider's exact Q Code belongs to. */
  async lookupByQCode(rawCode: string): Promise<PublicSalonSummary | null> {
    const code = normalizeCode(rawCode);
    if (!/^Q[A-Z0-9]{5}$/.test(code)) return null;

    const { data: staff, error: staffError } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('primary_location_id')
      .eq('q_code', code)
      .eq('employment_status', 'active')
      .maybeSingle<StaffQCodeRow>();

    if (staffError) {
      this.logger.error(`lookupByQCode failed: ${staffError.message}`);
      throw new InternalServerErrorException('Unable to resolve Q Code');
    }
    if (!staff) return null;

    const { data: salon, error: salonError } = await this.admin
      .schema('core')
      .from('locations')
      .select(SALON_COLUMNS)
      .eq('id', staff.primary_location_id)
      .eq('is_active', true)
      .maybeSingle<SalonRow>();

    if (salonError) {
      this.logger.error(`lookupByQCode salon lookup failed: ${salonError.message}`);
      throw new InternalServerErrorException('Unable to resolve Q Code');
    }
    return salon ? toSalonSummary(salon) : null;
  }

  /**
   * Search by Salon Code, salon name, or provider Q Code. Exact identifier
   * matches are returned first; otherwise partial salon names are searched.
   */
  async search(rawQuery: string): Promise<PublicSalonSummary[]> {
    const query = (rawQuery ?? '').trim();
    if (query.length < 2) return [];

    // Exact-identifier fast path. Salon Codes and provider Q Codes are both
    // 8 chars (Salon Code widened in 0065, Q Code in 0056); 6 is kept so any
    // legacy 6-char Salon Code still resolves exactly during rollout.
    const code = normalizeCode(query);
    if (code.length === 6 || code.length === 8) {
      const [salonCodeMatch, qCodeMatch] = await Promise.all([
        this.lookupByCode(code),
        code.startsWith('Q') ? this.lookupByQCode(code) : Promise.resolve(null),
      ]);
      const exactMatches = uniqueSalons([salonCodeMatch, qCodeMatch]);
      if (exactMatches.length > 0) return exactMatches;
    }

    const escapedQuery = escapeIlike(query);
    const escapedCode = escapeIlike(code);
    const [directResult, businessResult, staffResult] = await Promise.all([
      this.admin
        .schema('core')
        .from('locations')
        .select(SALON_COLUMNS)
        .eq('is_active', true)
        .or(`name.ilike.%${escapedQuery}%,public_code.ilike.${escapedCode}%`)
        .order('name', { ascending: true })
        .limit(SEARCH_LIMIT)
        .returns<SalonRow[]>(),
      this.admin
        .schema('core')
        .from('businesses')
        .select('id')
        .ilike('name', `%${escapedQuery}%`)
        .limit(SEARCH_LIMIT)
        .returns<BusinessMatchRow[]>(),
      code.length >= 2
        ? this.admin
            .schema('core')
            .from('staff_profiles')
            .select('primary_location_id')
            .eq('employment_status', 'active')
            .ilike('q_code', `${escapedCode}%`)
            .limit(SEARCH_LIMIT)
            .returns<StaffQCodeRow[]>()
        : Promise.resolve({ data: [] as StaffQCodeRow[], error: null }),
    ]);

    const firstError = directResult.error ?? businessResult.error ?? staffResult.error;
    if (firstError) {
      this.logger.error(`search failed: ${firstError.message}`);
      throw new InternalServerErrorException('Unable to search salons');
    }

    const businessIds = (businessResult.data ?? []).map((row) => row.id);
    const qCodeLocationIds = [
      ...new Set((staffResult.data ?? []).map((row) => row.primary_location_id)),
    ];
    const [businessLocations, qCodeLocations] = await Promise.all([
      this.fetchActiveLocationsBy('business_id', businessIds),
      this.fetchActiveLocationsBy('id', qCodeLocationIds),
    ]);

    return uniqueSalons([
      ...(directResult.data ?? []).map(toSalonSummary),
      ...businessLocations.map(toSalonSummary),
      ...qCodeLocations.map(toSalonSummary),
    ])
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, SEARCH_LIMIT);
  }

  private async fetchActiveLocationsBy(
    column: 'id' | 'business_id',
    values: string[],
  ): Promise<SalonRow[]> {
    if (values.length === 0) return [];
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select(SALON_COLUMNS)
      .eq('is_active', true)
      .in(column, values)
      .limit(SEARCH_LIMIT)
      .returns<SalonRow[]>();
    if (error) {
      this.logger.error(`fetchActiveLocationsBy ${column} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to search salons');
    }
    return data ?? [];
  }
}

function uniqueSalons(
  salons: Array<PublicSalonSummary | null>,
): PublicSalonSummary[] {
  const byLocation = new Map<string, PublicSalonSummary>();
  for (const salon of salons) {
    if (salon) byLocation.set(salon.locationId, salon);
  }
  return [...byLocation.values()];
}

/** Uppercase and strip anything outside the Salon Code alphabet (spaces, dashes). */
function normalizeCode(value: string): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Escape PostgREST ilike wildcards so user input is treated literally. */
function escapeIlike(value: string): string {
  return value.replace(/[%_,]/g, (match) => `\\${match}`);
}

function toSalonSummary(row: SalonRow): PublicSalonSummary {
  const business = Array.isArray(row.businesses) ? row.businesses[0] : row.businesses;
  return {
    locationId: row.id,
    businessId: row.business_id,
    salonCode: row.public_code,
    name: row.name,
    businessName: business?.name ?? row.name,
    slug: row.slug,
    businessSlug: business?.slug ?? '',
    city: row.city ?? undefined,
    region: row.region ?? undefined,
    postalCode: row.postal_code ?? undefined,
    countryCode: row.country_code ?? undefined,
    phone: row.phone ?? undefined,
  };
}
