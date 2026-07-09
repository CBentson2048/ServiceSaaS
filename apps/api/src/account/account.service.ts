import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AccountTierState, AuthUser, BusinessTier } from '@sheer/domain';
import {
  BUSINESS_TIER_LABELS,
  getBusinessTierLimits,
  suggestTierUpgrade,
  userHasRole,
} from '@sheer/domain';

const VALID_TIERS: readonly BusinessTier[] = ['solo', 'studio', 'salon', 'group'];

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Current tier, its limits and live usage. Available to owners and managers
   * so the dashboard can render plan usage; only owners can change the tier.
   */
  async getState(actor: AuthUser): Promise<AccountTierState> {
    const tier = await this.fetchTier(actor.businessId);
    return this.buildState(actor.businessId, tier);
  }

  /**
   * Change the account tier. Upgrades are always allowed. Downgrades are
   * blocked when current usage exceeds the target tier's limits, so a tier
   * change can never strand a business over its own cap.
   */
  async updateTier(actor: AuthUser, nextTier: BusinessTier): Promise<AccountTierState> {
    this.assertOwner(actor);

    if (!VALID_TIERS.includes(nextTier)) {
      throw new ConflictException('Unknown account tier');
    }

    const usage = await this.fetchUsage(actor.businessId);
    const limits = getBusinessTierLimits(nextTier);

    if (limits.maxLocations !== null && usage.locationCount > limits.maxLocations) {
      throw new ConflictException(
        `Cannot switch to ${BUSINESS_TIER_LABELS[nextTier]}: it allows ${limits.maxLocations} location(s) but you have ${usage.locationCount}. Remove locations first.`,
      );
    }
    if (limits.maxTeamMembers !== null && usage.teamMemberCount > limits.maxTeamMembers) {
      throw new ConflictException(
        `Cannot switch to ${BUSINESS_TIER_LABELS[nextTier]}: it allows ${limits.maxTeamMembers} team member(s) but you have ${usage.teamMemberCount}. Remove team members first.`,
      );
    }

    const { error } = await this.admin
      .schema('core')
      .from('businesses')
      .update({ tier: nextTier, updated_at: new Date().toISOString() })
      .eq('id', actor.businessId);

    if (error) {
      this.logger.error(`updateTier failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update account tier');
    }

    return this.buildState(actor.businessId, nextTier, usage);
  }

  // ---------------------------------------------------------------------------

  private async buildState(
    businessId: string,
    tier: BusinessTier,
    usageInput?: { locationCount: number; teamMemberCount: number },
  ): Promise<AccountTierState> {
    const usage = usageInput ?? (await this.fetchUsage(businessId));
    const limits = getBusinessTierLimits(tier);

    let upgradeSuggestion: AccountTierState['upgradeSuggestion'] = null;
    if (limits.maxTeamMembers !== null && usage.teamMemberCount >= limits.maxTeamMembers) {
      const toTier = suggestTierUpgrade(tier, 'team');
      if (toTier) upgradeSuggestion = { toTier, reason: 'team' };
    }
    if (
      !upgradeSuggestion &&
      limits.maxLocations !== null &&
      usage.locationCount >= limits.maxLocations
    ) {
      const toTier = suggestTierUpgrade(tier, 'locations');
      if (toTier) upgradeSuggestion = { toTier, reason: 'locations' };
    }

    return { tier, limits, usage, upgradeSuggestion };
  }

  private async fetchTier(businessId: string): Promise<BusinessTier> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('tier')
      .eq('id', businessId)
      .single<{ tier: BusinessTier | null }>();

    if (error || !data) {
      this.logger.error(`fetchTier failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to load account tier');
    }
    return data.tier ?? 'solo';
  }

  private async fetchUsage(
    businessId: string,
  ): Promise<{ locationCount: number; teamMemberCount: number }> {
    const [locations, memberships, invitations] = await Promise.all([
      this.admin
        .schema('core')
        .from('locations')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('is_active', true),
      this.admin
        .schema('core')
        .from('user_memberships')
        .select('user_profile_id')
        .eq('business_id', businessId)
        .eq('status', 'active')
        .in('role', ['owner', 'manager', 'stylist'])
        .returns<{ user_profile_id: string }[]>(),
      this.admin
        .schema('core')
        .from('staff_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('status', 'pending'),
    ]);

    if (locations.error || memberships.error || invitations.error) {
      this.logger.error(
        `fetchUsage failed: ${
          locations.error?.message ?? memberships.error?.message ?? invitations.error?.message
        }`,
      );
      throw new InternalServerErrorException('Unable to load account usage');
    }

    const distinctMembers = new Set((memberships.data ?? []).map((m) => m.user_profile_id)).size;
    return {
      locationCount: locations.count ?? 0,
      teamMemberCount: distinctMembers + (invitations.count ?? 0),
    };
  }

  private assertOwner(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only owners can change the account tier');
    }
  }
}
