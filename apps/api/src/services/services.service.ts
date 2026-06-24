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
import { userHasRole, userHasAnyRole } from '@sheer/domain';
import type {
  AuthUser,
  ListManagedServicesResponse,
  ListServiceCategoriesResponse,
  ManagedService,
  ManagedServiceResponse,
  ServiceCategory,
  ServiceCategoryResponse,
  UnassignedServicesResponse,
} from '@sheer/domain';
import type {
  CreateServiceCategoryDto,
  ServiceCategoryQueryDto,
  ServiceQueryDto,
  UpdateServiceCategoryDto,
  UpsertServiceDto,
} from './dto';

interface CategoryRow {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  color_hex: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ServiceRow {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  description: string | null;
  service_category_id: string | null;
  estimated_duration_minutes: number;
  processing_time_minutes: number;
  base_price: number | string;
  deposit_type: 'none' | 'fixed_amount' | 'percentage';
  deposit_value: number | string;
  requires_patch_test: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const CATEGORY_COLUMNS = 'id,business_id,name,description,color_hex,is_active,sort_order,created_at,updated_at';
const SERVICE_COLUMNS =
  'id,business_id,location_id,name,description,service_category_id,estimated_duration_minutes,processing_time_minutes,base_price,deposit_type,deposit_value,requires_patch_test,is_active,sort_order,created_at,updated_at';

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // --- Service categories ---------------------------------------------------

  async listCategories(actor: AuthUser, query: ServiceCategoryQueryDto): Promise<ListServiceCategoriesResponse> {
    this.assertManagerOrOwner(actor);
    let request = this.admin
      .schema('booking')
      .from('service_categories')
      .select(CATEGORY_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (!query.includeInactive) request = request.eq('is_active', true);
    if (query.q?.trim()) {
      const term = escapeSupabaseOr(query.q.trim());
      request = request.or(`name.ilike.%${term}%,description.ilike.%${term}%`);
    }

    const { data, error } = await request.returns<CategoryRow[]>();
    if (error) {
      this.logger.error(`listCategories failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load service categories');
    }
    return { categories: (data ?? []).map(toCategory) };
  }

  async createCategory(actor: AuthUser, dto: CreateServiceCategoryDto): Promise<ServiceCategoryResponse> {
    this.assertManagerOrOwner(actor);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name is required');

    const { data, error } = await this.admin
      .schema('booking')
      .from('service_categories')
      .insert({
        business_id: actor.businessId,
        name,
        description: clean(dto.description),
        color_hex: dto.colorHex ?? null,
        is_active: dto.isActive ?? true,
        sort_order: dto.sortOrder ?? 0,
      })
      .select(CATEGORY_COLUMNS)
      .single<CategoryRow>();

    if (error || !data) {
      if (error?.code === '23505') {
        throw new ConflictException('A service category with this name already exists');
      }
      this.logger.error(`createCategory failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create service category');
    }
    return { category: toCategory(data) };
  }

  async updateCategory(
    actor: AuthUser,
    categoryId: string,
    dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryResponse> {
    this.assertManagerOrOwner(actor);
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('name must not be empty');
      patch.name = name;
    }
    if ('description' in dto) patch.description = clean(dto.description);
    if ('colorHex' in dto) patch.color_hex = dto.colorHex ?? null;
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;
    if (dto.sortOrder !== undefined) patch.sort_order = dto.sortOrder;
    if (Object.keys(patch).length === 0) throw new BadRequestException('No category fields to update');

    const { data, error } = await this.admin
      .schema('booking')
      .from('service_categories')
      .update(patch)
      .eq('id', categoryId)
      .eq('business_id', actor.businessId)
      .select(CATEGORY_COLUMNS)
      .maybeSingle<CategoryRow>();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('A service category with this name already exists');
      }
      this.logger.error(`updateCategory failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update service category');
    }
    if (!data) throw new NotFoundException('Service category not found');
    return { category: toCategory(data) };
  }

  async deleteCategory(actor: AuthUser, categoryId: string): Promise<ServiceCategoryResponse> {
    this.assertOwner(actor);
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_categories')
      .delete()
      .eq('id', categoryId)
      .eq('business_id', actor.businessId)
      .select(CATEGORY_COLUMNS)
      .maybeSingle<CategoryRow>();

    if (error) {
      this.logger.error(`deleteCategory failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete service category');
    }
    if (!data) throw new NotFoundException('Service category not found');
    return { category: toCategory(data) };
  }

  // --- Services -------------------------------------------------------------

  async listServices(actor: AuthUser, query: ServiceQueryDto): Promise<ListManagedServicesResponse> {
    this.assertManagerOrOwner(actor);
    let request = this.admin
      .schema('booking')
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (!query.includeInactive) request = request.eq('is_active', true);
    if (query.serviceCategoryId) request = request.eq('service_category_id', query.serviceCategoryId);
    if (query.locationId) request = request.or(`location_id.is.null,location_id.eq.${query.locationId}`);
    if (query.q?.trim()) {
      const term = escapeSupabaseOr(query.q.trim());
      request = request.or(`name.ilike.%${term}%,description.ilike.%${term}%`);
    }

    const { data, error } = await request.returns<ServiceRow[]>();
    if (error) {
      this.logger.error(`listServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load services');
    }
    const rows = data ?? [];
    const [currencyCode, categoryNames] = await Promise.all([
      this.fetchBusinessCurrency(actor.businessId),
      this.fetchCategoryNames(actor.businessId, rows.map((row) => row.service_category_id)),
    ]);
    return { services: rows.map((row) => toService(row, currencyCode, categoryNames)) };
  }

  async createService(actor: AuthUser, dto: UpsertServiceDto): Promise<ManagedServiceResponse> {
    this.assertManagerOrOwner(actor);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name is required');
    const locationId = dto.locationId ?? null;
    if (locationId) await this.assertLocation(actor.businessId, locationId);
    if (dto.serviceCategoryId) await this.assertCategory(actor.businessId, dto.serviceCategoryId);

    const slug = await this.generateServiceSlug(actor.businessId, locationId, name);
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .insert({
        business_id: actor.businessId,
        location_id: locationId,
        slug,
        ...toServicePatch(dto),
        is_active: dto.isActive ?? true,
      })
      .select(SERVICE_COLUMNS)
      .single<ServiceRow>();

    if (error || !data) {
      if (error?.code === '23505') {
        throw new ConflictException('A service with this name already exists at this location');
      }
      this.logger.error(`createService failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create service');
    }
    return this.respondWithService(actor.businessId, data);
  }

  async updateService(actor: AuthUser, serviceId: string, dto: UpsertServiceDto): Promise<ManagedServiceResponse> {
    this.assertManagerOrOwner(actor);
    if (dto.serviceCategoryId) await this.assertCategory(actor.businessId, dto.serviceCategoryId);

    // Slug and location are fixed at creation time to keep public booking links
    // stable; only the editable fields are patched here.
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .update(toServicePatch(dto))
      .eq('id', serviceId)
      .eq('business_id', actor.businessId)
      .select(SERVICE_COLUMNS)
      .maybeSingle<ServiceRow>();

    if (error) {
      this.logger.error(`updateService failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update service');
    }
    if (!data) throw new NotFoundException('Service not found');
    return this.respondWithService(actor.businessId, data);
  }

  async archiveService(actor: AuthUser, serviceId: string): Promise<ManagedServiceResponse> {
    this.assertOwner(actor);
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .update({ is_active: false })
      .eq('id', serviceId)
      .eq('business_id', actor.businessId)
      .select(SERVICE_COLUMNS)
      .maybeSingle<ServiceRow>();

    if (error) {
      this.logger.error(`archiveService failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to archive service');
    }
    if (!data) throw new NotFoundException('Service not found');
    return this.respondWithService(actor.businessId, data);
  }

  /**
   * Active services that have no bookable stylist qualified to perform them.
   * Surfaced as a dashboard warning so owners can assign stylists — a service
   * with no eligible stylist cannot be booked. A service counts as "covered"
   * only when at least one of its eligible stylists is currently bookable.
   */
  async listServicesMissingStaff(actor: AuthUser): Promise<UnassignedServicesResponse> {
    this.assertManagerOrOwner(actor);

    const { data: serviceRows, error: serviceError } = await this.admin
      .schema('booking')
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .returns<ServiceRow[]>();
    if (serviceError) {
      this.logger.error(`listServicesMissingStaff services failed: ${serviceError.message}`);
      throw new InternalServerErrorException('Unable to load services');
    }
    const rows = serviceRows ?? [];
    if (rows.length === 0) return { services: [] };

    const [{ data: staffRows, error: staffError }, { data: eligibilityRows, error: eligibilityError }] =
      await Promise.all([
        this.admin
          .schema('core')
          .from('staff_profiles')
          .select('id')
          .eq('business_id', actor.businessId)
          .eq('is_bookable', true)
          .neq('employment_status', 'terminated')
          .returns<{ id: string }[]>(),
        this.admin
          .schema('booking')
          .from('staff_service_eligibility')
          .select('service_id,staff_profile_id')
          .eq('business_id', actor.businessId)
          .returns<{ service_id: string; staff_profile_id: string }[]>(),
      ]);
    if (staffError) {
      this.logger.error(`listServicesMissingStaff staff failed: ${staffError.message}`);
      throw new InternalServerErrorException('Unable to load stylists');
    }
    if (eligibilityError) {
      this.logger.error(`listServicesMissingStaff eligibility failed: ${eligibilityError.message}`);
      throw new InternalServerErrorException('Unable to load stylist eligibility');
    }

    const bookableStaffIds = new Set((staffRows ?? []).map((row) => row.id));
    const coveredServiceIds = new Set<string>();
    for (const row of eligibilityRows ?? []) {
      if (bookableStaffIds.has(row.staff_profile_id)) coveredServiceIds.add(row.service_id);
    }

    const missing = rows.filter((row) => !coveredServiceIds.has(row.id));
    if (missing.length === 0) return { services: [] };

    const [currencyCode, categoryNames] = await Promise.all([
      this.fetchBusinessCurrency(actor.businessId),
      this.fetchCategoryNames(actor.businessId, missing.map((row) => row.service_category_id)),
    ]);
    return { services: missing.map((row) => toService(row, currencyCode, categoryNames)) };
  }

  async reorderCategories(actor: AuthUser, ids: string[]): Promise<ListServiceCategoriesResponse> {
    this.assertManagerOrOwner(actor);
    await this.applyReorder('service_categories', actor.businessId, ids);
    return this.listCategories(actor, { includeInactive: true });
  }

  async reorderServices(actor: AuthUser, ids: string[]): Promise<ListManagedServicesResponse> {
    this.assertManagerOrOwner(actor);
    await this.applyReorder('services', actor.businessId, ids);
    return this.listServices(actor, { includeInactive: true });
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * Persists a new display order for a catalogue table. The submitted ids are
   * assigned sort_order 0..n-1 in the given order; any other rows for the
   * business keep their relative order and are pushed after them, so the result
   * is always a clean, collision-free sequence regardless of which subset the
   * caller reordered (e.g. when inactive rows are hidden in the UI).
   */
  private async applyReorder(
    table: 'services' | 'service_categories',
    businessId: string,
    ids: string[],
  ): Promise<void> {
    const { data, error } = await this.admin
      .schema('booking')
      .from(table)
      .select('id')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .returns<{ id: string }[]>();
    if (error) {
      this.logger.error(`applyReorder(${table}) load failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reorder catalogue');
    }

    const existing = new Set((data ?? []).map((row) => row.id));
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of ids) {
      if (existing.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    for (const row of data ?? []) {
      if (!seen.has(row.id)) ordered.push(row.id);
    }

    const results = await Promise.all(
      ordered.map((id, index) =>
        this.admin
          .schema('booking')
          .from(table)
          .update({ sort_order: index })
          .eq('id', id)
          .eq('business_id', businessId),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      this.logger.error(`applyReorder(${table}) update failed: ${failed.error.message}`);
      throw new InternalServerErrorException('Unable to reorder catalogue');
    }
  }

  private async respondWithService(businessId: string, row: ServiceRow): Promise<ManagedServiceResponse> {
    const [currencyCode, categoryNames] = await Promise.all([
      this.fetchBusinessCurrency(businessId),
      this.fetchCategoryNames(businessId, [row.service_category_id]),
    ]);
    return { service: toService(row, currencyCode, categoryNames) };
  }

  private async generateServiceSlug(businessId: string, locationId: string | null, name: string): Promise<string> {
    const base = slugify(name) || 'service';
    let request = this.admin.schema('booking').from('services').select('slug').eq('business_id', businessId);
    request = locationId ? request.eq('location_id', locationId) : request.is('location_id', null);
    const { data, error } = await request.returns<{ slug: string }[]>();
    if (error) {
      this.logger.error(`generateServiceSlug failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to allocate service slug');
    }
    const taken = new Set((data ?? []).map((row) => row.slug.toLowerCase()));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new ConflictException('Unable to allocate a unique slug for this service');
  }

  private async fetchCategoryNames(
    businessId: string,
    categoryIds: (string | null)[],
  ): Promise<Map<string, string>> {
    const ids = Array.from(new Set(categoryIds.filter((id): id is string => Boolean(id))));
    if (ids.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_categories')
      .select('id,name')
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<{ id: string; name: string }[]>();
    if (error) {
      this.logger.error(`fetchCategoryNames failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load service categories');
    }
    return new Map((data ?? []).map((row) => [row.id, row.name]));
  }

  private async assertCategory(businessId: string, categoryId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_categories')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', categoryId)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertCategory failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate service category');
    }
    if (!data) throw new BadRequestException('serviceCategoryId is not valid for this business');
  }

  private async assertLocation(businessId: string, locationId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', locationId)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate location');
    }
    if (!data) throw new BadRequestException('locationId is not valid for this business');
  }

  private async fetchBusinessCurrency(businessId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('default_currency_code')
      .eq('id', businessId)
      .maybeSingle<{ default_currency_code: string }>();
    if (error) {
      this.logger.error(`fetchBusinessCurrency failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load business currency');
    }
    return data?.default_currency_code ?? 'GBP';
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Service management is limited to owners and managers');
    }
  }

  private assertOwner(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) throw new ForbiddenException('Only owners can delete or archive catalogue items');
  }
}

function toServicePatch(dto: UpsertServiceDto): Record<string, unknown> {
  const depositType = dto.depositType ?? 'none';
  // DB check constraint: deposit_value must be 0 when deposit_type is 'none'.
  const depositValue = depositType === 'none' ? 0 : dto.depositValue ?? 0;
  const patch: Record<string, unknown> = {
    name: dto.name.trim(),
    description: clean(dto.description),
    service_category_id: dto.serviceCategoryId ?? null,
    estimated_duration_minutes: dto.estimatedDurationMinutes,
    processing_time_minutes: dto.processingTimeMinutes ?? 0,
    base_price: dto.basePrice ?? 0,
    deposit_type: depositType,
    deposit_value: depositValue,
    requires_patch_test: dto.requiresPatchTest ?? false,
  };
  if (dto.sortOrder !== undefined) patch.sort_order = dto.sortOrder;
  return patch;
}

function clean(value: string | null | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function escapeSupabaseOr(value: string): string {
  return value.replace(/[%(),]/g, '');
}

function toCategory(row: CategoryRow): ServiceCategory {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description ?? undefined,
    colorHex: row.color_hex ?? undefined,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toService(row: ServiceRow, currencyCode: string, categoryNames?: Map<string, string>): ManagedService {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    serviceCategoryId: row.service_category_id ?? undefined,
    category: row.service_category_id ? categoryNames?.get(row.service_category_id) : undefined,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    processingTimeMinutes: row.processing_time_minutes,
    basePrice: Number(row.base_price),
    depositType: row.deposit_type,
    depositValue: Number(row.deposit_value),
    requiresPatchTest: row.requires_patch_test,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    currencyCode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
