import { ForbiddenException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  BusinessTier,
  MessageCapDecision,
  MessageUsagePeriodWindow,
  MessageUsageResponse,
  MessageEnforcementMode,
  MessageUsageSummary,
  TierMessageEntitlement,
  TierMessagePolicy,
} from '@sheer/domain';
import {
  BUSINESS_TIER_LIMITS,
  DEFAULT_TIER_MESSAGE_POLICY,
  decideMessageCap,
  isCountableMessage,
  logicalMessageKey,
  monthlyPeriodFor,
  resolveEntitlement,
  summariseUsage,
  userHasRole,
} from '@sheer/domain';

/**
 * Tier-based monthly message usage accounting (Wrike 4507284256).
 *
 * THE PLATFORM-WIDE LAYER. Every outbound client message already travels
 * MessagingService -> comms.notification_events -> NotificationDispatchService,
 * so hooking this service into that pipeline's single "provider accepted"
 * transition makes campaigns, booking confirmations, reminders and rebooking
 * nudges all consume one allowance with NO caller-side code. Nothing in a
 * feature service knows this exists — which is the whole point, and why 0104
 * deliberately did not build a campaign counter.
 *
 * TWO SEPARATE CONCERNS, deliberately not merged (Wrike section 24):
 *
 *   ENFORCEMENT — a pre-send policy question. May be approximate at the
 *                 boundary; two workers can both see "1 remaining".
 *   ACCOUNTING  — a post-send fact. Exact under any concurrency, because the
 *                 ledger's UNIQUE (business_id, logical_message_key) makes it
 *                 exact rather than any application check.
 *
 * The overage counter is what absorbs the difference between the two, which is
 * why an approximate gate and exact accounting compose correctly.
 */
@Injectable()
export class MessageUsageService {
  private readonly logger = new Logger(MessageUsageService.name);
  private readonly admin: SupabaseClient;

  /**
   * The per-tier POLICY table has one row per tier and changes essentially never,
   * but it is read on the outbound send path. A short TTL cache keeps that path
   * cheap without risking a stale mode for long. The allowance NUMBERS are a
   * compiled-in domain constant and need no lookup at all.
   */
  private policyCache: { at: number; byTier: Map<string, TierMessagePolicy> } | null = null;
  private static readonly POLICY_TTL_MS = 60_000;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // =========================================================================
  // The send path
  // =========================================================================

  /**
   * May this message be handed to a provider?
   *
   * Called by the dispatcher BEFORE the provider call. Never throws: a usage
   * lookup failure must not stop a salon's messaging, so a degraded read allows
   * the send and the message is still accounted for afterwards.
   */
  async checkCap(businessId: string, channel: string): Promise<MessageCapDecision> {
    if (!isCountableMessage(channel)) return { allow: true, warn: false };
    try {
      return decideMessageCap(await this.currentSummary(businessId));
    } catch (err) {
      this.logger.error(`message cap check failed for ${businessId}: ${(err as Error).message}`);
      return { allow: true, warn: false };
    }
  }

  /**
   * Record ONE logical outbound message against the business's monthly allowance.
   *
   * Called immediately after the provider accepts. Idempotent by construction:
   * the ledger absorbs a retry of the same event, the second half of a
   * WhatsApp -> SMS fallback pair, and two workers racing the same message.
   *
   * NEVER THROWS INTO THE SEND PATH — but never silently swallows either. A
   * failure here is logged at error level WITH the logical key, and
   * {@link backfillUnrecordedSends} recovers it from `sent_at` on the event,
   * which is durable. That is the honest boundary: a provider call cannot be
   * transactional with a database write, so this is effectively-once accounting
   * with a deterministic repair, not exactly-once delivery.
   */
  async recordSend(input: {
    eventId: string;
    businessId: string;
    dedupeKey?: string | null;
    appointmentId?: string | null;
    eventKey: string;
    channel: string;
    messageClass?: string | null;
  }): Promise<{ counted: boolean } | null> {
    if (!isCountableMessage(input.channel)) return { counted: false };

    const key = logicalMessageKey({
      eventId: input.eventId,
      businessId: input.businessId,
      dedupeKey: input.dedupeKey,
      appointmentId: input.appointmentId,
      eventKey: input.eventKey,
    });

    try {
      const { period, entitlement, tier } = await this.resolveContext(input.businessId);
      const { data, error } = await this.admin.schema('comms').rpc('record_message_usage', {
        p_business_id: input.businessId,
        p_logical_message_key: key,
        p_period_start: period.periodStart,
        p_period_end: period.periodEnd,
        p_timezone: period.timezone,
        p_tier_key: tier,
        p_allowance: entitlement.monthlyAllowance,
        p_is_unlimited: entitlement.isUnlimited,
        p_location_count: entitlement.locationCount,
        p_notification_event_id: input.eventId,
        p_message_class: input.messageClass ?? 'transactional',
        p_final_channel: input.channel,
        p_event_key: input.eventKey,
      });
      if (error) throw new Error(error.message);

      const row = (data ?? [])[0] as { counted?: boolean } | undefined;
      return { counted: row?.counted === true };
    } catch (err) {
      // Loud, and recoverable: the key is in the log and `sent_at` is on the row.
      this.logger.error(
        `message usage NOT recorded for business ${input.businessId}, logical key ${key}: ` +
          `${(err as Error).message} — recoverable via backfillUnrecordedSends`,
      );
      return null;
    }
  }

  // =========================================================================
  // Reading
  // =========================================================================

  /** The current period's summary for a business. Cheap: no COUNT(*) anywhere. */
  async currentSummary(businessId: string): Promise<MessageUsageSummary> {
    const { period, entitlement, tier } = await this.resolveContext(businessId);
    const used = await this.readUsedCount(businessId, period.periodStart);
    return summariseUsage({ tier, period, used, entitlement });
  }

  /** The admin surface: current period plus history, newest first. */
  async usageForActor(actor: AuthUser): Promise<MessageUsageResponse> {
    this.assertUsageAccess(actor);
    const current = await this.currentSummary(actor.businessId);

    const { data, error } = await this.admin
      .schema('comms')
      .from('message_usage_periods')
      .select('period_start,period_end,tier_key,allowance,is_unlimited,used_count,overage_count')
      .eq('business_id', actor.businessId)
      .order('period_start', { ascending: false })
      .limit(24)
      .returns<PeriodRow[]>();

    if (error) {
      this.logger.error(`load usage history failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load message usage');
    }

    return {
      current,
      // Previous periods only — the current one is already reported in full.
      history: (data ?? [])
        .filter((row) => row.period_start !== current.periodStart)
        .map((row) => ({
          periodStart: row.period_start,
          periodEnd: row.period_end,
          tier: row.tier_key,
          allowance: row.allowance === null ? null : Number(row.allowance),
          isUnlimited: row.is_unlimited,
          used: Number(row.used_count),
          overage: Number(row.overage_count),
        })),
    };
  }

  // =========================================================================
  // Reconciliation — evidence and recovery
  // =========================================================================

  /**
   * Compare a period's counters against the immutable ledger.
   *
   * The counters are maintained transactionally, so this is evidence rather than
   * a repair job production depends on. `apply` is deliberately opt-in.
   */
  async reconcile(
    actor: AuthUser,
    periodStart?: string,
    apply = false,
  ): Promise<{ counterUsed: number; ledgerUsed: number; counterOverage: number; ledgerOverage: number; applied: boolean } | null> {
    this.assertUsageAccess(actor);
    const { period } = await this.resolveContext(actor.businessId);
    const target = periodStart ?? period.periodStart;

    const { data, error } = await this.admin.schema('comms').rpc('reconcile_message_usage', {
      p_business_id: actor.businessId,
      p_period_start: target,
      p_apply: apply,
    });
    if (error) {
      this.logger.error(`reconcile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reconcile message usage');
    }

    const row = (data ?? [])[0] as ReconcileRow | undefined;
    if (!row) return null;
    return {
      counterUsed: Number(row.counter_used),
      ledgerUsed: Number(row.ledger_used),
      counterOverage: Number(row.counter_overage),
      ledgerOverage: Number(row.ledger_overage),
      applied: row.applied === true,
    };
  }

  /**
   * Recover usage for messages the provider accepted but whose accounting write
   * failed (a crash between the provider call and the RPC, or a transient DB
   * error).
   *
   * `comms.notification_events.sent_at` is the durable evidence that a provider
   * accepted the message — it is stamped in the same update that sets
   * `status='sent'`. Any such event with no ledger entry for its logical key is
   * unrecorded usage, and re-running the recorder is safe because the ledger key
   * makes it idempotent.
   *
   * Bounded and explicit: an operator or a test runs it, nothing schedules it.
   */
  async backfillUnrecordedSends(businessId: string, limit = 500): Promise<{ examined: number; recorded: number }> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .select('id,business_id,dedupe_key,appointment_id,event_key,channel,payload_json,sent_at')
      .eq('business_id', businessId)
      .not('sent_at', 'is', null)
      .in('channel', ['whatsapp', 'sms', 'email'])
      .order('sent_at', { ascending: false })
      .limit(limit)
      .returns<SentEventRow[]>();

    if (error) throw new InternalServerErrorException(`Unable to load sent events: ${error.message}`);

    const rows = data ?? [];
    let recorded = 0;
    for (const row of rows) {
      const result = await this.recordSend({
        eventId: row.id,
        businessId: row.business_id,
        dedupeKey: row.dedupe_key,
        appointmentId: row.appointment_id,
        eventKey: row.event_key,
        channel: row.channel,
        messageClass: readMessageClass(row.payload_json),
      });
      // `counted: true` means this one was genuinely missing from the ledger.
      if (result?.counted) recorded += 1;
    }
    return { examined: rows.length, recorded };
  }

  // =========================================================================
  // Context resolution
  // =========================================================================

  /**
   * The business's tier, its entitlement and the current monthly period.
   *
   * The period is a calendar month in the BUSINESS timezone — one period per
   * account, never one per location, because the allowance is an account-level
   * entitlement and a multi-location salon must not receive a second one.
   */
  private async resolveContext(businessId: string): Promise<{
    tier: BusinessTier;
    entitlement: TierMessageEntitlement;
    period: MessageUsagePeriodWindow;
  }> {
    const business = await this.readBusiness(businessId);
    const entitlement = await this.entitlementFor(business.tier, businessId);
    const period = monthlyPeriodFor(localDate(business.timezone), business.timezone);
    return { tier: business.tier, entitlement, period };
  }

  private async readBusiness(businessId: string): Promise<{ tier: BusinessTier; timezone: string }> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('tier,timezone')
      .eq('id', businessId)
      .maybeSingle<{ tier: string | null; timezone: string | null }>();
    if (error) throw new Error(`load business failed: ${error.message}`);
    return {
      tier: (data?.tier as BusinessTier) ?? 'spark',
      timezone: data?.timezone ?? 'Europe/London',
    };
  }

  /**
   * The account's entitlement: the canonical per-tier cap from
   * BUSINESS_TIER_LIMITS, multiplied across the account's active locations, with
   * the stored operational policy applied.
   *
   * The NUMBER is never read from a table — it lives in the domain constant the
   * rest of the platform already enforces tier limits from and the plan card
   * already shows customers, so there is exactly one figure and it cannot drift.
   */
  private async entitlementFor(tier: BusinessTier, businessId: string): Promise<TierMessageEntitlement> {
    const [policy, locationCount] = await Promise.all([
      this.policyFor(tier),
      this.countActiveLocations(businessId),
    ]);
    return resolveEntitlement({
      tier,
      perLocationCap: BUSINESS_TIER_LIMITS[tier]?.messagingMonthlyCapPerLocation ?? null,
      locationCount,
      policy,
    });
  }

  private async policyFor(tier: BusinessTier): Promise<TierMessagePolicy> {
    const now = Date.now();
    if (!this.policyCache || now - this.policyCache.at > MessageUsageService.POLICY_TTL_MS) {
      const { data, error } = await this.admin
        .schema('core')
        .from('tier_message_policy')
        .select('tier,enforcement_mode,warn_at_percent')
        .returns<PolicyRow[]>();
      if (error) throw new Error(`load tier message policy failed: ${error.message}`);

      const byTier = new Map<string, TierMessagePolicy>();
      for (const row of data ?? []) {
        byTier.set(row.tier, {
          enforcementMode: row.enforcement_mode as MessageEnforcementMode,
          warnAtPercent: Number(row.warn_at_percent),
        });
      }
      this.policyCache = { at: now, byTier };
    }
    // A tier with no policy row falls back to the non-blocking default rather
    // than to anything that could silence a salon.
    return this.policyCache.byTier.get(tier) ?? { ...DEFAULT_TIER_MESSAGE_POLICY };
  }

  /**
   * Active locations for the account. The per-location cap is multiplied across
   * these into ONE shared pool — never into one allowance per location.
   */
  private async countActiveLocations(businessId: string): Promise<number> {
    const { count, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('is_active', true);
    if (error) throw new Error(`count locations failed: ${error.message}`);
    return Math.max(1, count ?? 1);
  }

  private async readUsedCount(businessId: string, periodStart: string): Promise<number> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('message_usage_periods')
      .select('used_count')
      .eq('business_id', businessId)
      .eq('period_start', periodStart)
      .maybeSingle<{ used_count: number | string }>();
    if (error) throw new Error(`load usage period failed: ${error.message}`);
    // No row yet simply means no message has been sent this period.
    return data ? Number(data.used_count) : 0;
  }

  /**
   * Usage is account-level commercial data. Owners see it; ordinary staff have
   * no need for the account's billing position, and the ticket does not ask to
   * widen that.
   */
  private assertUsageAccess(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Message usage requires owner access');
    }
  }
}

// ---------------------------------------------------------------------------
// Row shapes and helpers
// ---------------------------------------------------------------------------

interface PeriodRow {
  period_start: string;
  period_end: string;
  tier_key: string;
  allowance: number | string | null;
  is_unlimited: boolean;
  used_count: number | string;
  overage_count: number | string;
}

interface PolicyRow {
  tier: string;
  enforcement_mode: string;
  warn_at_percent: number | string;
}

interface ReconcileRow {
  counter_used: number | string;
  ledger_used: number | string;
  counter_overage: number | string;
  ledger_overage: number | string;
  applied: boolean;
}

interface SentEventRow {
  id: string;
  business_id: string;
  dedupe_key: string | null;
  appointment_id: string | null;
  event_key: string;
  channel: string;
  payload_json: Record<string, unknown> | null;
  sent_at: string | null;
}

function readMessageClass(payload: Record<string, unknown> | null): string {
  return payload?.['message_class'] === 'marketing' ? 'marketing' : 'transactional';
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Today's calendar date in the account timezone.
 *
 * Never `new Date().getMonth()`: that would put a business in the wrong month for
 * up to a day either side of the boundary depending on where the server runs.
 * ICU does the conversion and the PARTS are read rather than the formatted
 * string, because field order varies between ICU builds.
 */
export function localDate(timeZone: string, at: Date = new Date()): string {
  let formatter = dateFormatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    dateFormatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
