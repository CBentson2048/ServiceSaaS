import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DeliveryChannel } from './channel-policy';
import type { OptOutSource } from './opt-out';

interface OptOutRow {
  channel: string;
}

/** Opt-outs for one client. `degraded` means the read failed, so the list is not to be trusted. */
export interface OptOutSnapshot {
  channels: DeliveryChannel[];
  degraded: boolean;
}

/**
 * Per-client, per-channel messaging opt-outs (`comms.channel_opt_outs`, migration 0098).
 *
 * Opt-out is recorded per channel on purpose: a client who replies STOP to a WhatsApp marketing
 * message has opted out of WhatsApp, not of the transactional email confirming tomorrow's
 * appointment. {@link resolveChannelPlan} removes an opted-out channel from the chain entirely, so
 * the next channel takes over exactly as it would after a delivery failure.
 *
 * Reads are fail-open (an unreachable table must not silence every notification); writes are
 * fail-soft (a failed record is logged, never thrown, so it cannot break a webhook response).
 */
@Injectable()
export class OptOutService {
  private readonly logger = new Logger(OptOutService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Channels this client has opted out of, and whether the answer is trustworthy.
   *
   * A read failure returns `degraded: true` with an empty list rather than throwing. The caller
   * decides what that means: a transactional reminder still goes out (silently suppressing an
   * appointment reminder because a table was briefly unreachable would be worse, and the provider
   * itself still blocks a real STOP), while a marketing message is withheld — consent is not
   * something to assume when we could not check.
   */
  async channelsFor(businessId: string, clientProfileId: string | null): Promise<OptOutSnapshot> {
    if (!clientProfileId) return { channels: [], degraded: false };
    const { data, error } = await this.admin
      .schema('comms')
      .from('channel_opt_outs')
      .select('channel')
      .eq('business_id', businessId)
      .eq('client_profile_id', clientProfileId)
      .returns<OptOutRow[]>();
    if (error) {
      this.logger.error(`load opt-outs for client ${clientProfileId} failed: ${error.message}`);
      return { channels: [], degraded: true };
    }
    const channels = (data ?? [])
      .map((row) => row.channel)
      .filter((c): c is DeliveryChannel => c === 'whatsapp' || c === 'sms' || c === 'email');
    return { channels, degraded: false };
  }

  /** Record an opt-out. Idempotent — re-opting-out keeps the original timestamp and source. */
  async recordOptOut(
    businessId: string,
    clientProfileId: string,
    channel: DeliveryChannel,
    source: OptOutSource,
    reason?: string,
  ): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('channel_opt_outs')
      .insert({
        business_id: businessId,
        client_profile_id: clientProfileId,
        channel,
        source,
        reason: reason?.slice(0, 500) ?? null,
      });
    if (error) {
      if (isUniqueViolation(error)) return; // already opted out — nothing to change.
      this.logger.error(`record ${channel} opt-out for client ${clientProfileId} failed: ${error.message}`);
      return;
    }
    this.logger.log(`client ${clientProfileId} opted out of ${channel} (${source})`);
  }

  /** Remove an opt-out (an inbound START/UNSTOP, or a staff correction). */
  async clearOptOut(businessId: string, clientProfileId: string, channel: DeliveryChannel): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('channel_opt_outs')
      .delete()
      .eq('business_id', businessId)
      .eq('client_profile_id', clientProfileId)
      .eq('channel', channel);
    if (error) {
      this.logger.error(`clear ${channel} opt-out for client ${clientProfileId} failed: ${error.message}`);
      return;
    }
    this.logger.log(`client ${clientProfileId} opted back in to ${channel}`);
  }
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key value/i.test(error.message ?? '');
}
