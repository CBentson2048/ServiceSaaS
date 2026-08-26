import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  EffectiveRetailPricingResponse,
  ListRetailPricingRulesResponse,
  RetailPricingRuleResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { EffectivePricingQueryDto, ListPricingRulesQueryDto, UpsertPricingRuleDto } from './dto';
import { RetailPricingService } from './retail-pricing.service';

/**
 * Retail pricing configuration (approved CR). Money-sensitive: the whole
 * surface sits behind settings.billing.manage — owners and managers per the
 * existing permission contracts; stylists and front-desk never gain pricing
 * configuration by accident. The service re-checks, plus location scope on
 * every location-bound rule.
 */
@Controller('retail-pricing')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('settings.billing.manage')
export class RetailPricingController {
  constructor(private readonly pricing: RetailPricingService) {}

  @Get('rules')
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListPricingRulesQueryDto,
  ): Promise<ListRetailPricingRulesResponse> {
    return this.pricing.listRules(actor, query);
  }

  /** Create or replace the rule at one level. Clearing = DELETE, never a 0. */
  @Put('rules')
  upsert(@CurrentUser() actor: AuthUser, @Body() dto: UpsertPricingRuleDto): Promise<RetailPricingRuleResponse> {
    return this.pricing.upsertRule(actor, dto);
  }

  @Delete('rules/:id')
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<RetailPricingRuleResponse> {
    return this.pricing.deleteRule(actor, id);
  }

  /** Canonical effective price + provenance for one product at one location. */
  @Get('effective')
  effective(
    @CurrentUser() actor: AuthUser,
    @Query() query: EffectivePricingQueryDto,
  ): Promise<EffectiveRetailPricingResponse> {
    return this.pricing.getEffective(actor, query.productId, query.locationId);
  }
}
