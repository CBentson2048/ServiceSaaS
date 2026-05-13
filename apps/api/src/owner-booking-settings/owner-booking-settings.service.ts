import {
  BadRequestException,
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
  BusinessLocationSummary,
  OwnerBookingService,
  OwnerBookingSettingsResponse,
  OwnerServiceRequirementRule,
  OwnerServiceUpgradeSuggestion,
  UpsertServiceRequirementRuleRequest,
  UpsertServiceUpgradeSuggestionRequest,
} from '@sheer/domain';

interface LocationRow {
  id: string;
  name: string;
  code: string | null;
  slug: string | null;
  is_active: boolean;
  location_settings:
    | { currency_code: string }[]
    | { currency_code: string }
    | null;
}

interface BusinessCurrencyRow {
  default_currency_code: string;
}

interface ServiceRow {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  description: string | null;
  category: string | null;
  estimated_duration_minutes: number;
  base_price: number | string;
  deposit_type: 'none' | 'fixed_amount' | 'percentage';
  deposit_value: number | string;
  is_active: boolean;
  sort_order: number;
}

interface RequirementRuleRow {
  id: string;
  business_id: string;
  location_id: string | null;
  trigger_service_id: string;
  title: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  service_requirement_options:
    | Array<{ service_id: string; sort_order: number }>
    | { service_id: string; sort_order: number }
    | null;
}

interface UpgradeSuggestionRow {
  id: string;
  business_id: string;
  location_id: string | null;
  trigger_service_id: string;
  suggested_service_id: string;
  title: string;
  description: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const SERVICE_COLUMNS =
  'id,business_id,location_id,name,description,category,estimated_duration_minutes,base_price,deposit_type,deposit_value,is_active,sort_order';
const REQUIREMENT_COLUMNS =
  'id,business_id,location_id,trigger_service_id,title,description,is_active,created_at,updated_at,service_requirement_options(service_id,sort_order)';
const UPGRADE_COLUMNS =
  'id,business_id,location_id,trigger_service_id,suggested_service_id,title,description,is_active,sort_order,created_at,updated_at';

@Injectable()
export class OwnerBookingSettingsService {
  private readonly logger = new Logger(OwnerBookingSettingsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async getSettings(actor: AuthUser, locationId?: string): Promise<OwnerBookingSettingsResponse> {
    this.assertOwner(actor);
    if (locationId) await this.assertLocationBelongsToBusiness(actor.businessId, locationId);

    const [locations, services, requirementRules, upgradeSuggestions, currencyCode] = await Promise.all([
      this.fetchLocations(actor.businessId),
      this.fetchServices(actor.businessId, locationId),
      this.fetchRequirementRules(actor.businessId, locationId),
      this.fetchUpgradeSuggestions(actor.businessId, locationId),
      this.fetchBusinessCurrency(actor.businessId),
    ]);

    return {
      locations,
      services: services.map((service) => toOwnerService(service, currencyCode)),
      requirementRules,
      upgradeSuggestions,
    };
  }

  async createRequirementRule(
    actor: AuthUser,
    input: UpsertServiceRequirementRuleRequest,
  ): Promise<OwnerServiceRequirementRule> {
    this.assertOwner(actor);
    await this.validateRequirementInput(actor.businessId, input);

    const { data, error } = await this.admin
      .schema('booking')
      .from('service_requirement_rules')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId ?? null,
        trigger_service_id: input.triggerServiceId,
        title: cleanRequired(input.title, 'title'),
        description: cleanOptional(input.description),
        is_active: input.isActive ?? true,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !data) {
      this.logger.error(`createRequirementRule failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create service requirement rule');
    }

    await this.replaceRequirementOptions(actor.businessId, input.locationId ?? null, data.id, input.requiredServiceIds);
    return this.fetchRequirementRule(actor.businessId, data.id);
  }

  async updateRequirementRule(
    actor: AuthUser,
    ruleId: string,
    input: UpsertServiceRequirementRuleRequest,
  ): Promise<OwnerServiceRequirementRule> {
    this.assertOwner(actor);
    await this.fetchRequirementRule(actor.businessId, ruleId);
    await this.validateRequirementInput(actor.businessId, input);

    const { error } = await this.admin
      .schema('booking')
      .from('service_requirement_rules')
      .update({
        location_id: input.locationId ?? null,
        trigger_service_id: input.triggerServiceId,
        title: cleanRequired(input.title, 'title'),
        description: cleanOptional(input.description),
        is_active: input.isActive ?? true,
      })
      .eq('id', ruleId)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`updateRequirementRule failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update service requirement rule');
    }

    await this.replaceRequirementOptions(actor.businessId, input.locationId ?? null, ruleId, input.requiredServiceIds);
    return this.fetchRequirementRule(actor.businessId, ruleId);
  }

  async deleteRequirementRule(actor: AuthUser, ruleId: string): Promise<void> {
    this.assertOwner(actor);
    const { error } = await this.admin
      .schema('booking')
      .from('service_requirement_rules')
      .delete()
      .eq('id', ruleId)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`deleteRequirementRule failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete service requirement rule');
    }
  }

  async createUpgradeSuggestion(
    actor: AuthUser,
    input: UpsertServiceUpgradeSuggestionRequest,
  ): Promise<OwnerServiceUpgradeSuggestion> {
    this.assertOwner(actor);
    await this.validateUpgradeInput(actor.businessId, input);

    const { data, error } = await this.admin
      .schema('booking')
      .from('service_upgrade_suggestions')
      .insert(toUpgradePayload(actor.businessId, input))
      .select(UPGRADE_COLUMNS)
      .single<UpgradeSuggestionRow>();

    if (error || !data) {
      this.logger.error(`createUpgradeSuggestion failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create upgrade suggestion');
    }

    return toUpgradeSuggestion(data);
  }

  async updateUpgradeSuggestion(
    actor: AuthUser,
    suggestionId: string,
    input: UpsertServiceUpgradeSuggestionRequest,
  ): Promise<OwnerServiceUpgradeSuggestion> {
    this.assertOwner(actor);
    await this.fetchUpgradeSuggestion(actor.businessId, suggestionId);
    await this.validateUpgradeInput(actor.businessId, input);

    const { data, error } = await this.admin
      .schema('booking')
      .from('service_upgrade_suggestions')
      .update(toUpgradePayload(actor.businessId, input))
      .eq('id', suggestionId)
      .eq('business_id', actor.businessId)
      .select(UPGRADE_COLUMNS)
      .single<UpgradeSuggestionRow>();

    if (error || !data) {
      this.logger.error(`updateUpgradeSuggestion failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to update upgrade suggestion');
    }

    return toUpgradeSuggestion(data);
  }

  async deleteUpgradeSuggestion(actor: AuthUser, suggestionId: string): Promise<void> {
    this.assertOwner(actor);
    const { error } = await this.admin
      .schema('booking')
      .from('service_upgrade_suggestions')
      .delete()
      .eq('id', suggestionId)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`deleteUpgradeSuggestion failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete upgrade suggestion');
    }
  }

  private async fetchLocations(businessId: string): Promise<BusinessLocationSummary[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,code,slug,is_active,location_settings(currency_code)')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .returns<LocationRow[]>();

    if (error) {
      this.logger.error(`fetchLocations failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load locations');
    }
    return (data ?? []).filter((row) => row.is_active).map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code ?? undefined,
      slug: row.slug ?? undefined,
    }));
  }

  private async fetchServices(businessId: string, locationId?: string): Promise<ServiceRow[]> {
    let query = this.admin
      .schema('booking')
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (locationId) query = query.or(`location_id.is.null,location_id.eq.${locationId}`);

    const { data, error } = await query.returns<ServiceRow[]>();
    if (error) {
      this.logger.error(`fetchServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load services');
    }
    return data ?? [];
  }

  private async fetchBusinessCurrency(businessId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('default_currency_code')
      .eq('id', businessId)
      .maybeSingle<BusinessCurrencyRow>();
    if (error) {
      this.logger.error(`fetchBusinessCurrency failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load business currency');
    }
    return data?.default_currency_code ?? 'GBP';
  }

  private async fetchRequirementRules(
    businessId: string,
    locationId?: string,
  ): Promise<OwnerServiceRequirementRule[]> {
    let query = this.admin
      .schema('booking')
      .from('service_requirement_rules')
      .select(REQUIREMENT_COLUMNS)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });
    if (locationId) query = query.or(`location_id.is.null,location_id.eq.${locationId}`);

    const { data, error } = await query.returns<RequirementRuleRow[]>();
    if (error) {
      this.logger.error(`fetchRequirementRules failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load service requirement rules');
    }
    return (data ?? []).map(toRequirementRule);
  }

  private async fetchRequirementRule(
    businessId: string,
    ruleId: string,
  ): Promise<OwnerServiceRequirementRule> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_requirement_rules')
      .select(REQUIREMENT_COLUMNS)
      .eq('id', ruleId)
      .eq('business_id', businessId)
      .maybeSingle<RequirementRuleRow>();

    if (error) {
      this.logger.error(`fetchRequirementRule failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load service requirement rule');
    }
    if (!data) throw new NotFoundException('Service requirement rule not found');
    return toRequirementRule(data);
  }

  private async fetchUpgradeSuggestions(
    businessId: string,
    locationId?: string,
  ): Promise<OwnerServiceUpgradeSuggestion[]> {
    let query = this.admin
      .schema('booking')
      .from('service_upgrade_suggestions')
      .select(UPGRADE_COLUMNS)
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (locationId) query = query.or(`location_id.is.null,location_id.eq.${locationId}`);

    const { data, error } = await query.returns<UpgradeSuggestionRow[]>();
    if (error) {
      this.logger.error(`fetchUpgradeSuggestions failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load upgrade suggestions');
    }
    return (data ?? []).map(toUpgradeSuggestion);
  }

  private async fetchUpgradeSuggestion(
    businessId: string,
    suggestionId: string,
  ): Promise<OwnerServiceUpgradeSuggestion> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_upgrade_suggestions')
      .select(UPGRADE_COLUMNS)
      .eq('id', suggestionId)
      .eq('business_id', businessId)
      .maybeSingle<UpgradeSuggestionRow>();

    if (error) {
      this.logger.error(`fetchUpgradeSuggestion failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load upgrade suggestion');
    }
    if (!data) throw new NotFoundException('Upgrade suggestion not found');
    return toUpgradeSuggestion(data);
  }

  private async validateRequirementInput(
    businessId: string,
    input: UpsertServiceRequirementRuleRequest,
  ): Promise<void> {
    if (input.locationId) await this.assertLocationBelongsToBusiness(businessId, input.locationId);
    await this.assertServicesBelongToBusiness(businessId, [
      input.triggerServiceId,
      ...input.requiredServiceIds,
    ]);
    if (input.requiredServiceIds.includes(input.triggerServiceId)) {
      throw new BadRequestException('A required finishing option cannot be the trigger service');
    }
  }

  private async validateUpgradeInput(
    businessId: string,
    input: UpsertServiceUpgradeSuggestionRequest,
  ): Promise<void> {
    if (input.locationId) await this.assertLocationBelongsToBusiness(businessId, input.locationId);
    if (input.triggerServiceId === input.suggestedServiceId) {
      throw new BadRequestException('Upgrade suggestion must point to a different service');
    }
    await this.assertServicesBelongToBusiness(businessId, [
      input.triggerServiceId,
      input.suggestedServiceId,
    ]);
  }

  private async replaceRequirementOptions(
    businessId: string,
    locationId: string | null,
    ruleId: string,
    serviceIds: string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(serviceIds)];
    const { error: deleteError } = await this.admin
      .schema('booking')
      .from('service_requirement_options')
      .delete()
      .eq('rule_id', ruleId)
      .eq('business_id', businessId);

    if (deleteError) {
      this.logger.error(`replaceRequirementOptions delete failed: ${deleteError.message}`);
      throw new InternalServerErrorException('Unable to update requirement options');
    }

    const { error: insertError } = await this.admin
      .schema('booking')
      .from('service_requirement_options')
      .insert(
        uniqueIds.map((serviceId, index) => ({
          business_id: businessId,
          location_id: locationId,
          rule_id: ruleId,
          service_id: serviceId,
          sort_order: index,
        })),
      );

    if (insertError) {
      this.logger.error(`replaceRequirementOptions insert failed: ${insertError.message}`);
      throw new InternalServerErrorException('Unable to update requirement options');
    }
  }

  private async assertLocationBelongsToBusiness(businessId: string, locationId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();
    if (error) throw new InternalServerErrorException('Unable to verify location');
    if (!data) throw new BadRequestException('Location does not belong to this business');
  }

  private async assertServicesBelongToBusiness(businessId: string, serviceIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(serviceIds)];
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .select('id')
      .eq('business_id', businessId)
      .in('id', uniqueIds)
      .returns<Array<{ id: string }>>();
    if (error) throw new InternalServerErrorException('Unable to verify services');
    if ((data ?? []).length !== uniqueIds.length) {
      throw new BadRequestException('One or more services do not belong to this business');
    }
  }

  private assertOwner(actor: AuthUser): void {
    if (actor.role !== 'owner') {
      throw new ForbiddenException('Only owners can manage booking settings');
    }
  }
}

function toOwnerService(row: ServiceRow, currencyCode: string): OwnerBookingService {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    startingPriceAmount: Number(row.base_price),
    depositRequiredAmount: calculateServiceDeposit(row),
    currencyCode,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

function toRequirementRule(row: RequirementRuleRow): OwnerServiceRequirementRule {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? undefined,
    triggerServiceId: row.trigger_service_id,
    title: row.title,
    description: row.description ?? undefined,
    isActive: row.is_active,
    requiredServiceIds: arrayOf(row.service_requirement_options)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((option) => option.service_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUpgradeSuggestion(row: UpgradeSuggestionRow): OwnerServiceUpgradeSuggestion {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? undefined,
    triggerServiceId: row.trigger_service_id,
    suggestedServiceId: row.suggested_service_id,
    title: row.title,
    description: row.description,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUpgradePayload(businessId: string, input: UpsertServiceUpgradeSuggestionRequest) {
  return {
    business_id: businessId,
    location_id: input.locationId ?? null,
    trigger_service_id: input.triggerServiceId,
    suggested_service_id: input.suggestedServiceId,
    title: cleanRequired(input.title, 'title'),
    description: cleanRequired(input.description, 'description'),
    is_active: input.isActive ?? true,
    sort_order: input.sortOrder ?? 0,
  };
}

function calculateServiceDeposit(row: ServiceRow): number {
  const price = Number(row.base_price);
  const value = Number(row.deposit_value);
  if (row.deposit_type === 'fixed_amount') return Math.max(0, value);
  if (row.deposit_type === 'percentage') return Math.max(0, Math.round((price * value) / 100));
  return 0;
}

function cleanRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException(`${field} is required`);
  return trimmed;
}

function cleanOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function arrayOf<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
