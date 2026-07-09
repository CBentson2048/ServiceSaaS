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

const SALON_COLUMNS =
  'id,business_id,name,slug,public_code,city,region,postal_code,country_code,phone,businesses!inner(name,slug)';

const SEARCH_LIMIT = 20;

/**
 * Public discovery of salons/locations by their Salon Code or name. Backs the
 * Week 9 Salon Suite ("search by Salon Code or name"). Only active locations are
 * exposed and only public-safe fields are returned.
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

  /**
   * Search by Salon Code or name. An input that looks like a code first tries an
   * exact code match (a code resolves to exactly one salon); otherwise falls back
   * to a name search so partial names still return results.
   */
  async search(rawQuery: string): Promise<PublicSalonSummary[]> {
    const query = (rawQuery ?? '').trim();
    if (query.length < 2) return [];

    const code = normalizeCode(query);
    if (code.length === 6) {
      const exact = await this.lookupByCode(code);
      if (exact) return [exact];
    }

    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select(SALON_COLUMNS)
      .eq('is_active', true)
      .ilike('name', `%${escapeIlike(query)}%`)
      .order('name', { ascending: true })
      .limit(SEARCH_LIMIT)
      .returns<SalonRow[]>();

    if (error) {
      this.logger.error(`search failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to search salons');
    }
    return (data ?? []).map(toSalonSummary);
  }
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
