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
  ListUpsellRulesResponse,
  UpsellRuleDetail,
  UpsellRuleResponse,
  UpsellRuleTriggerType,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import type { CreateUpsellRuleDto, ListUpsellRulesQueryDto, UpdateUpsellRuleDto } from './dto';

/**
 * Owner configuration for upsell rules — "when X is booked, suggest Y".
 *
 * OWNER ONLY. Rules are business configuration that shapes what every member of
 * staff is prompted to sell, so editing them sits with the owner, exactly as
 * booking settings, service requirements and upgrade prompts already do. Staff
 * consume suggestions (UpsellSuggestionService) but cannot change what is
 * suggested. Managers are deliberately NOT given edit rights here: no existing
 * permission grants them salon-wide commercial configuration, and this ticket
 * is not the place to widen that.
 *
 * Every mutation is written to the existing audit trail — these are settings
 * changes, and "who turned this rule off?" must be answerable.
 */

interface RuleRow {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  enabled: boolean;
  trigger_type: UpsellRuleTriggerType;
  trigger_service_id: string | null;
  trigger_service_category_id: string | null;
  suggested_service_id: string;
  priority: number | string;
  created_by_user_profile_id: string | null;
  created_at: string;
  updated_at: string;
  trigger_service: { name: string } | { name: string }[] | null;
  suggested_service: { name: string } | { name: string }[] | null;
  service_categories: { name: string } | { name: string }[] | null;
  locations: { name: string } | { name: string }[] | null;
}

const RULE_COLUMNS = [
  'id',
  'business_id',
  'location_id',
  'name',
  'enabled',
  'trigger_type',
  'trigger_service_id',
  'trigger_service_category_id',
  'suggested_service_id',
  'priority',
  'created_by_user_profile_id',
  'created_at',
  'updated_at',
  'trigger_service:services!upsell_rules_trigger_service_id_fkey(name)',
  'suggested_service:services!upsell_rules_suggested_service_id_fkey(name)',
  'service_categories(name)',
  'locations(name)',
].join(',');

@Injectable()
export class UpsellRulesService {
  private readonly logger = new Logger(UpsellRulesService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async list(actor: AuthUser, query: ListUpsellRulesQueryDto): Promise<ListUpsellRulesResponse> {
    this.assertOwner(actor);
    let request = this.admin
      .schema('booking')
      .from('upsell_rules')
      .select(RULE_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    // A location filter shows what actually applies THERE: that location's own
    // rules plus the business-wide defaults it inherits.
    if (query.locationId) {
      request = request.or(`location_id.is.null,location_id.eq.${query.locationId}`);
    }

    const { data, error } = await request.returns<RuleRow[]>();
    if (error) {
      this.logger.error(`list upsell rules failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load upsell rules');
    }
    return { rules: (data ?? []).map(toRuleDetail) };
  }

  async create(actor: AuthUser, dto: CreateUpsellRuleDto): Promise<UpsellRuleResponse> {
    this.assertOwner(actor);
    const trigger = await this.validateTrigger(actor.businessId, {
      triggerType: dto.triggerType,
      triggerServiceId: dto.triggerServiceId ?? null,
      triggerServiceCategoryId: dto.triggerServiceCategoryId ?? null,
      suggestedServiceId: dto.suggestedServiceId,
      locationId: dto.locationId ?? null,
    });

    const { data, error } = await this.admin
      .schema('booking')
      .from('upsell_rules')
      .insert({
        business_id: actor.businessId,
        location_id: dto.locationId ?? null,
        name: dto.name.trim(),
        enabled: dto.enabled ?? true,
        trigger_type: trigger.triggerType,
        trigger_service_id: trigger.triggerServiceId,
        trigger_service_category_id: trigger.triggerServiceCategoryId,
        suggested_service_id: dto.suggestedServiceId,
        priority: dto.priority ?? 0,
        created_by_user_profile_id: actor.id,
      })
      .select(RULE_COLUMNS)
      .single<RuleRow>();

    if (error || !data) {
      throw this.translateWriteError(error, 'create');
    }

    const rule = toRuleDetail(data);
    await this.audit.record(actor, {
      action: 'upsell.rule.created',
      entityType: 'upsell_rule',
      entityId: rule.id,
      locationId: rule.locationId ?? null,
      after: auditShape(rule),
    });
    return { rule };
  }

  async update(actor: AuthUser, ruleId: string, dto: UpdateUpsellRuleDto): Promise<UpsellRuleResponse> {
    this.assertOwner(actor);
    const existing = await this.fetch(actor.businessId, ruleId);

    // `!== undefined`, never `in`: a ValidationPipe DTO carries every declared
    // field as an own (undefined) property, so `in` is true for all of them and
    // a partial PATCH would null whatever the caller omitted.
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('name must not be empty');
      patch.name = name;
    }
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.locationId !== undefined) patch.location_id = dto.locationId ?? null;

    // The trigger is one indivisible choice (type + the matching id), so it is
    // revalidated as a whole against the merged result whenever any part moves.
    const triggerTouched =
      dto.triggerType !== undefined ||
      dto.triggerServiceId !== undefined ||
      dto.triggerServiceCategoryId !== undefined ||
      dto.suggestedServiceId !== undefined ||
      dto.locationId !== undefined;

    if (triggerTouched) {
      const trigger = await this.validateTrigger(actor.businessId, {
        triggerType: dto.triggerType ?? existing.triggerType,
        triggerServiceId:
          dto.triggerServiceId !== undefined ? dto.triggerServiceId : (existing.triggerServiceId ?? null),
        triggerServiceCategoryId:
          dto.triggerServiceCategoryId !== undefined
            ? dto.triggerServiceCategoryId
            : (existing.triggerServiceCategoryId ?? null),
        suggestedServiceId: dto.suggestedServiceId ?? existing.suggestedServiceId,
        locationId: dto.locationId !== undefined ? (dto.locationId ?? null) : (existing.locationId ?? null),
      });
      patch.trigger_type = trigger.triggerType;
      patch.trigger_service_id = trigger.triggerServiceId;
      patch.trigger_service_category_id = trigger.triggerServiceCategoryId;
      if (dto.suggestedServiceId !== undefined) patch.suggested_service_id = dto.suggestedServiceId;
    }

    if (Object.keys(patch).length === 0) throw new BadRequestException('No rule fields to update');

    const { data, error } = await this.admin
      .schema('booking')
      .from('upsell_rules')
      .update(patch)
      .eq('id', ruleId)
      .eq('business_id', actor.businessId)
      .select(RULE_COLUMNS)
      .maybeSingle<RuleRow>();

    if (error) throw this.translateWriteError(error, 'update');
    if (!data) throw new NotFoundException('Upsell rule not found');

    const rule = toRuleDetail(data);
    await this.audit.record(actor, {
      // A toggle is the change an owner most often needs to account for, so it
      // gets its own action rather than hiding inside a generic update.
      action:
        dto.enabled !== undefined && dto.enabled !== existing.enabled
          ? dto.enabled
            ? 'upsell.rule.enabled'
            : 'upsell.rule.disabled'
          : 'upsell.rule.updated',
      entityType: 'upsell_rule',
      entityId: rule.id,
      locationId: rule.locationId ?? null,
      before: auditShape(existing),
      after: auditShape(rule),
    });
    return { rule };
  }

  async remove(actor: AuthUser, ruleId: string): Promise<void> {
    this.assertOwner(actor);
    const existing = await this.fetch(actor.businessId, ruleId);

    const { error } = await this.admin
      .schema('booking')
      .from('upsell_rules')
      .delete()
      .eq('id', ruleId)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`delete upsell rule failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete upsell rule');
    }

    await this.audit.record(actor, {
      action: 'upsell.rule.deleted',
      entityType: 'upsell_rule',
      entityId: ruleId,
      locationId: existing.locationId ?? null,
      before: auditShape(existing),
    });
  }

  // --- Validation -----------------------------------------------------------

  /**
   * Normalises and validates a rule's trigger. Enforced here as well as by the
   * table's CHECK constraints so the caller gets a 400 explaining the problem
   * rather than a 500 from a constraint violation.
   */
  private async validateTrigger(
    businessId: string,
    input: {
      triggerType: UpsellRuleTriggerType;
      triggerServiceId: string | null;
      triggerServiceCategoryId: string | null;
      suggestedServiceId: string;
      locationId: string | null;
    },
  ): Promise<{
    triggerType: UpsellRuleTriggerType;
    triggerServiceId: string | null;
    triggerServiceCategoryId: string | null;
  }> {
    // Only the id belonging to the chosen trigger type survives, so switching
    // a rule from a category trigger to a service trigger cannot leave the old
    // category id behind to violate the table's trigger/type CHECK.
    const triggerServiceId = input.triggerType === 'service' ? input.triggerServiceId : null;
    const triggerServiceCategoryId =
      input.triggerType === 'service_category' ? input.triggerServiceCategoryId : null;

    if (input.triggerType === 'service' && !triggerServiceId) {
      throw new BadRequestException('triggerServiceId is required for a service trigger');
    }
    if (input.triggerType === 'service_category' && !triggerServiceCategoryId) {
      throw new BadRequestException(
        'triggerServiceCategoryId is required for a service category trigger',
      );
    }
    if (triggerServiceId && triggerServiceId === input.suggestedServiceId) {
      throw new BadRequestException('A service cannot suggest itself');
    }

    if (input.locationId) await this.assertLocationInBusiness(businessId, input.locationId);
    await this.assertServicesInBusiness(
      businessId,
      [triggerServiceId, input.suggestedServiceId].filter((id): id is string => !!id),
    );
    if (triggerServiceCategoryId) {
      await this.assertCategoryInBusiness(businessId, triggerServiceCategoryId);
    }

    return { triggerType: input.triggerType, triggerServiceId, triggerServiceCategoryId };
  }

  private async assertServicesInBusiness(businessId: string, serviceIds: string[]): Promise<void> {
    const ids = [...new Set(serviceIds)];
    if (ids.length === 0) return;
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .select('id')
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<{ id: string }[]>();

    if (error) {
      this.logger.error(`assertServicesInBusiness failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate services');
    }
    // A service from another business reads as "not found", never as a
    // confirmation that it exists elsewhere.
    if ((data ?? []).length !== ids.length) {
      throw new BadRequestException('Service not found for this business');
    }
  }

  private async assertCategoryInBusiness(businessId: string, categoryId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_categories')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', categoryId)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`assertCategoryInBusiness failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate service category');
    }
    if (!data) throw new BadRequestException('Service category not found for this business');
  }

  private async assertLocationInBusiness(businessId: string, locationId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', locationId)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`assertLocationInBusiness failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate location');
    }
    if (!data) throw new BadRequestException('Location not found for this business');
  }

  private async fetch(businessId: string, ruleId: string): Promise<UpsellRuleDetail> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('upsell_rules')
      .select(RULE_COLUMNS)
      .eq('id', ruleId)
      .eq('business_id', businessId)
      .maybeSingle<RuleRow>();

    if (error) {
      this.logger.error(`fetch upsell rule failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load upsell rule');
    }
    // Another business's rule is NOT FOUND, not FORBIDDEN — a 403 would confirm
    // the id exists somewhere.
    if (!data) throw new NotFoundException('Upsell rule not found');
    return toRuleDetail(data);
  }

  private translateWriteError(error: { code?: string; message?: string } | null, verb: string): Error {
    if (error?.code === '23505') {
      return new ConflictException('An identical rule already exists for this scope');
    }
    if (error?.code === '23514') {
      return new BadRequestException('Rule violates a service/trigger constraint');
    }
    this.logger.error(`${verb} upsell rule failed: ${error?.message ?? 'no row'}`);
    return new InternalServerErrorException(`Unable to ${verb} upsell rule`);
  }

  private assertOwner(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only an owner can manage upsell rules');
    }
  }
}

function toRuleDetail(row: RuleRow): UpsellRuleDetail {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    name: row.name,
    enabled: row.enabled,
    triggerType: row.trigger_type,
    triggerServiceId: row.trigger_service_id,
    triggerServiceCategoryId: row.trigger_service_category_id,
    suggestedServiceId: row.suggested_service_id,
    priority: Number(row.priority),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    triggerServiceName: first(row.trigger_service)?.name,
    triggerServiceCategoryName: first(row.service_categories)?.name,
    suggestedServiceName: first(row.suggested_service)?.name ?? '',
    locationName: first(row.locations)?.name,
  };
}

/** The fields worth diffing in the audit trail. */
function auditShape(rule: UpsellRuleDetail): Record<string, unknown> {
  return {
    name: rule.name,
    enabled: rule.enabled,
    locationId: rule.locationId ?? null,
    triggerType: rule.triggerType,
    triggerServiceId: rule.triggerServiceId ?? null,
    triggerServiceCategoryId: rule.triggerServiceCategoryId ?? null,
    suggestedServiceId: rule.suggestedServiceId,
    priority: rule.priority,
  };
}

function first<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}
