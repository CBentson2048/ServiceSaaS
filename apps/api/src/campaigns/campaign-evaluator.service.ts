import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CampaignAudiencePreview,
  CampaignAudienceSample,
  CampaignChannel,
  CampaignType,
} from '@sheer/domain';
import {
  CAMPAIGN_PREVIEW_SAMPLE_LIMIT,
  CAMPAIGN_PREVIEW_VALUES,
  campaignEventKey,
  campaignPreviewLine,
  narrowCampaignChannel,
  renderCampaignTemplate,
  shouldEvaluateToday,
  type CampaignTemplateValues,
} from '@sheer/domain';
import { MessagingService } from '../communications/messaging.service';
import { CampaignAudienceService, type CampaignCandidate } from './campaign-audience.service';
import { CAMPAIGN_COLUMNS, type CampaignRow } from './campaign-row';

/**
 * The campaign evaluator: candidates -> eligibility -> durable message event.
 *
 * ARCHITECTURE (Wrike sections 24, 35, 36, 38)
 *
 *   Campaign config
 *        -> CampaignAudienceService  (who, and their send identity)
 *        -> comms.claim_campaign_recipient  (atomic, once per identity, ever)
 *        -> MessagingService.send    (consent, opt-out, channel plan, dedupe)
 *        -> comms.notification_events (the DURABLE event — this is the handover)
 *        -> the EXISTING dispatcher   (WhatsApp -> SMS -> Email, retry, logging)
 *
 * The evaluator NEVER calls a provider, never opens a provider connection, and
 * never holds an API request open while messages are delivered. It writes queue
 * rows and stops. Everything after that already existed.
 *
 * FAILURE ISOLATION IS STRUCTURAL, NOT ASPIRATIONAL
 *   - This service is only ever entered from its own timer, or from an
 *     owner-initiated preview/run endpoint. No booking, checkout, till, CRM or
 *     QLAB code path calls into it, and this module is imported by nobody.
 *   - `tick()` cannot throw: the timer callback, the per-campaign loop and the
 *     per-recipient loop each have their own boundary. One poisoned campaign
 *     fails its own run and the next campaign still evaluates.
 *   - Nothing here runs inside another feature's transaction, so there is no
 *     transaction for a campaign failure to roll back.
 *
 * CONCURRENCY
 *   Two guards, both in the database, neither a check-then-act:
 *     1. `unique (campaign_id, run_local_date)` — only one
 *        worker owns a campaign's day.
 *     2. `comms.claim_campaign_recipient` — even if two runs somehow overlapped,
 *        only one can claim a given send identity.
 *   Plus the pre-existing `notification_events_dedupe_unique_idx` as the final
 *   backstop inside the messaging layer.
 */
@Injectable()
export class CampaignEvaluatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignEvaluatorService.name);
  private readonly admin: SupabaseClient;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly bookingBaseUrl: string;
  /**
   * Recipients queued per campaign run. A large campaign is spread across
   * consecutive ticks rather than enqueued in one unbounded burst: the ledger
   * makes each pass resume exactly where the last stopped, because already-
   * claimed identities are simply not re-offered (Wrike section 38).
   */
  private readonly maxRecipientsPerRun: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly audience: CampaignAudienceService,
    private readonly messaging: MessagingService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    this.enabled = (config.get<string>('CAMPAIGNS_EVALUATION_ENABLED') ?? 'true').toLowerCase() !== 'false';
    // Every 15 minutes by default. A campaign's granularity is a salon-local
    // HOUR, so polling faster buys nothing; polling much slower would push a
    // 10:00 campaign well past 10:00.
    this.intervalMs = clampInt(config.get('CAMPAIGNS_EVALUATION_INTERVAL_MS'), 900_000, 60_000, 3_600_000);
    this.maxRecipientsPerRun = clampInt(config.get('CAMPAIGNS_MAX_RECIPIENTS_PER_RUN'), 500, 1, 5_000);

    const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const explicit = config.get<string>('CAMPAIGN_BOOKING_BASE_URL');
    this.bookingBaseUrl = (explicit ?? corsOrigins[0] ?? 'http://localhost:5173').replace(/\/$/, '');
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Campaign evaluation is disabled (CAMPAIGNS_EVALUATION_ENABLED=false).');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(`Campaign evaluator started (every ${this.intervalMs}ms).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Evaluate every active campaign that is due in its own timezone.
   *
   * NEVER THROWS. An unhandled rejection inside a setInterval callback would
   * take the whole API process down, and a marketing feature must not be able to
   * do that (Wrike section 35).
   */
  async tick(): Promise<void> {
    if (this.running) return; // no overlapping ticks
    this.running = true;
    try {
      const campaigns = await this.fetchActiveCampaigns();
      for (const campaign of campaigns) {
        try {
          await this.evaluateIfDue(campaign);
        } catch (err) {
          // One campaign's failure is contained here. The loop continues.
          this.logger.error(`campaign ${campaign.id} evaluation failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`campaign tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Run one campaign now if its local send hour has arrived and today is unrun. */
  private async evaluateIfDue(campaign: CampaignRow): Promise<void> {
    const { localDate, localHour } = salonNow(campaign.timezone);
    const lastRun = await this.fetchLastRunDate(campaign.id);

    if (
      !shouldEvaluateToday({
        status: campaign.status as 'draft' | 'active' | 'paused' | 'archived',
        todayLocalDate: localDate,
        localHour,
        sendAtLocalHour: campaign.send_at_local_hour,
        lastRunLocalDate: lastRun,
      })
    ) {
      return;
    }

    await this.runCampaign(campaign, localDate);
  }

  // -------------------------------------------------------------------------
  // The run
  // -------------------------------------------------------------------------

  /**
   * Evaluate one campaign for one salon-local date and queue its messages.
   *
   * Claiming the run row FIRST is what makes this safe across API instances: the
   * unique index on (campaign_id, run_local_date) means a second worker's insert
   * raises 23505 and it returns without touching a single recipient.
   *
   * Returns null when another worker already owns the day.
   */
  async runCampaign(campaign: CampaignRow, localDate: string): Promise<CampaignRunOutcome | null> {
    const runId = await this.claimRun(campaign, localDate);
    if (!runId) {
      this.logger.debug(`campaign ${campaign.id} run for ${localDate} is already owned elsewhere`);
      return null;
    }

    const outcome: CampaignRunOutcome = {
      runId,
      candidateCount: 0,
      eligibleCount: 0,
      queuedCount: 0,
      suppressedCount: 0,
      failedCount: 0,
      suppressionBreakdown: {},
    };

    try {
      const { candidates } = await this.audience.resolveCandidates(campaign, localDate);
      outcome.candidateCount = candidates.length;

      const values = await this.templateValuesFor(campaign);
      let worked = 0;

      for (const candidate of candidates) {
        if (worked >= this.maxRecipientsPerRun) {
          this.logger.log(
            `campaign ${campaign.id} reached the ${this.maxRecipientsPerRun}-recipient batch bound; ` +
              'the remainder resumes on the next run',
          );
          break;
        }
        try {
          // The bound counts WORK DONE, not candidates scanned. A candidate whose
          // identity was already settled costs nothing and must not consume
          // budget — otherwise a campaign whose first N recipients are already
          // messaged would re-scan them every run and never reach anybody new.
          if (await this.processCandidate(campaign, runId, candidate, values, outcome)) worked += 1;
        } catch (err) {
          // A single recipient's failure never aborts the run. The claim row is
          // settled as failed, so the identity stays re-offerable next time.
          outcome.failedCount += 1;
          worked += 1;
          this.logger.error(
            `campaign ${campaign.id} recipient ${candidate.clientId} failed: ${(err as Error).message}`,
          );
        }
      }

      await this.completeRun(campaign, outcome, null);
      this.logger.log(
        `campaign ${campaign.id} (${campaign.campaign_type}) ${localDate}: ` +
          `${outcome.candidateCount} candidates, ${outcome.queuedCount} queued, ` +
          `${outcome.suppressedCount} suppressed, ${outcome.failedCount} failed`,
      );
      return outcome;
    } catch (err) {
      await this.completeRun(campaign, outcome, (err as Error).message);
      throw err;
    }
  }

  /**
   * One candidate: claim the identity, then hand the message to the messaging
   * layer.
   *
   * ORDER MATTERS. The claim comes first so two workers cannot both reach
   * `send`. The claim row is created in a NOT-yet-sent state and only promoted to
   * `queued` once the messaging layer has accepted the message, so a crash in
   * between leaves a re-offerable row rather than a phantom send.
   *
   * Returns true when this candidate consumed real work (a claim, a send, or a
   * newly recorded suppression) and false when it was already settled — which is
   * what the run's batch bound counts.
   */
  private async processCandidate(
    campaign: CampaignRow,
    runId: string,
    candidate: CampaignCandidate,
    values: Omit<CampaignTemplateValues, 'first_name' | 'last_name'>,
    outcome: CampaignRunOutcome,
  ): Promise<boolean> {
    // Cheap set-based consent pre-filter. NOT the authoritative check — the
    // messaging layer re-checks marketing_opt_in at enqueue and again at send.
    // This only avoids paying for a claim and a queue write we know will be
    // rejected, and gives the operator a countable reason.
    if (!candidate.marketingOptIn) {
      outcome.suppressedCount += 1;
      bump(outcome.suppressionBreakdown, 'client has not opted in to marketing');
      // Only a NEWLY written suppression is work. Re-observing a client already
      // recorded as unconsented costs nothing and must not eat budget.
      return this.recordSuppressionWithoutClaim(
        campaign,
        runId,
        candidate,
        'client has not opted in to marketing',
      );
    }

    const claim = await this.claimRecipient(campaign, runId, candidate);
    if (!claim) {
      // Already messaged for this identity — by an earlier run, another worker,
      // or an earlier batch. Not an error, and deliberately not counted as
      // suppressed: nothing was withheld, it was simply already done.
      return false;
    }

    outcome.eligibleCount += 1;

    const locationId = candidate.primaryLocationId ?? campaign.location_id;
    if (!locationId) {
      // Every notification event needs a location. A business-wide campaign
      // reaching a client with no primary location has nowhere to send from.
      outcome.suppressedCount += 1;
      bump(outcome.suppressionBreakdown, 'client has no primary location');
      await this.settleRecipient(claim, 'suppressed', 'client has no primary location');
      return true;
    }

    const body = renderCampaignTemplate(campaign.message_template, {
      ...values,
      first_name: candidate.firstName || 'there',
      last_name: candidate.lastName,
    });

    const result = await this.messaging.send({
      businessId: campaign.business_id,
      locationId,
      clientProfileId: candidate.clientId,
      eventKey: campaignEventKey(campaign.campaign_type as CampaignType),
      // Marketing, always. A campaign can never be classed transactional and so
      // can never bypass the protections marketing messages carry (Wrike §16).
      messageClass: 'marketing',
      dedupeKey: candidate.dedupeKey,
      // The campaign's own channel choice, passed as a NARROWING hint. It is
      // combined with the client's stored preference inside the messaging layer
      // (ClientSubject.preference), which takes whichever sits further down the
      // WhatsApp → SMS → Email chain — so this can only ever remove channels.
      // 'auto' contributes nothing and leaves the canonical chain untouched.
      channelPreference: campaignChannelHint(campaign.channel as CampaignChannel),
      content: {
        body,
        preview: campaignPreviewLine(body),
        subject: campaign.message_subject ?? undefined,
      },
      metadata: {
        campaign_id: campaign.id,
        campaign_type: campaign.campaign_type,
        campaign_run_id: runId,
        campaign_match_reason: candidate.matchReason,
      },
    });

    if (result.status === 'queued') {
      outcome.queuedCount += 1;
      await this.settleRecipient(claim, 'queued', null, result.eventId, result.channel);
      return true;
    }
    if (result.status === 'duplicate') {
      // The messaging layer's own dedupe index caught it. Treat as done, not as
      // a new send: settle the claim so it is never re-offered.
      await this.settleRecipient(claim, 'queued', null, null, result.channel);
      return true;
    }

    outcome.suppressedCount += 1;
    bump(outcome.suppressionBreakdown, result.reason);
    await this.settleRecipient(claim, 'suppressed', result.reason);
    return true;
  }

  // -------------------------------------------------------------------------
  // Audience preview — the SAME resolver, with nothing written and nothing sent
  // -------------------------------------------------------------------------

  /**
   * What this campaign would do if it ran today (Wrike section 33).
   *
   * Uses `CampaignAudienceService.resolveCandidates` — literally the same call
   * the real run makes — so the preview cannot disagree with production. It then
   * applies the same consent pre-filter and the same already-sent ledger check,
   * READ-ONLY: no claim, no queue write, no message, no run row.
   */
  async preview(campaign: CampaignRow): Promise<CampaignAudiencePreview> {
    const { localDate, localHour } = salonNow(campaign.timezone);

    const wouldNotRunReason = this.explainWhyItWouldNotRunToday(campaign, localHour);
    // The SALON's own values are real — they are the owner's, and seeing the
    // actual salon name and booking link is the point of a preview. Only the
    // CLIENT fields are representative, so the preview can never become a way to
    // read one client's details out of another client's message (Wrike §20).
    const values = await this.templateValuesFor(campaign);
    const renderedPreview = renderCampaignTemplate(campaign.message_template, {
      ...CAMPAIGN_PREVIEW_VALUES,
      ...values,
    });

    const { candidates } = await this.audience.resolveCandidates(campaign, localDate);
    const alreadySent = await this.fetchQueuedDedupeKeys(
      campaign.id,
      candidates.map((c) => c.dedupeKey),
    );

    const suppressionBreakdown: Record<string, number> = {};
    const sample: CampaignAudienceSample[] = [];
    let eligibleCount = 0;
    let suppressedCount = 0;

    for (const candidate of candidates) {
      let suppression: string | null = null;
      if (alreadySent.has(candidate.dedupeKey)) {
        suppression = 'already messaged for this campaign';
      } else if (!candidate.marketingOptIn) {
        suppression = 'client has not opted in to marketing';
      } else if (!candidate.primaryLocationId && !campaign.location_id) {
        suppression = 'client has no primary location';
      } else if (!candidate.phone && !candidate.email) {
        suppression = 'client has no valid phone or email address';
      }

      if (suppression) {
        suppressedCount += 1;
        bump(suppressionBreakdown, suppression);
      } else {
        eligibleCount += 1;
      }

      if (sample.length < CAMPAIGN_PREVIEW_SAMPLE_LIMIT) {
        sample.push({
          clientId: candidate.clientId,
          displayName: `${candidate.firstName} ${candidate.lastName}`.trim(),
          // Masked, not omitted: enough to recognise the person, not enough to
          // turn the preview into a contact export (Wrike section 34).
          maskedContact: maskContact(candidate.phone, candidate.email),
          reason: candidate.matchReason,
          eligible: suppression === null,
          suppressionReason: suppression,
        });
      }
    }

    return {
      campaignId: campaign.id,
      campaignType: campaign.campaign_type as CampaignType,
      evaluatedOn: localDate,
      timezone: campaign.timezone,
      candidateCount: candidates.length,
      eligibleCount,
      suppressedCount,
      suppressionBreakdown,
      sample,
      sampleTruncated: candidates.length > sample.length,
      wouldNotRunToday: wouldNotRunReason !== null,
      wouldNotRunReason,
      renderedPreview,
    };
  }

  private explainWhyItWouldNotRunToday(campaign: CampaignRow, localHour: number): string | null {
    if (campaign.status === 'draft') return 'This campaign is still a draft, so it does not send.';
    if (campaign.status === 'paused') return 'This campaign is paused.';
    if (campaign.status === 'archived') return 'This campaign is archived.';
    if (localHour < campaign.send_at_local_hour) {
      return `Scheduled for ${String(campaign.send_at_local_hour).padStart(2, '0')}:00 ${campaign.timezone}; it is ${String(localHour).padStart(2, '0')}:00 there now.`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Run + recipient persistence
  // -------------------------------------------------------------------------

  /** Insert the run row. A unique violation means another worker owns the day. */
  private async claimRun(campaign: CampaignRow, localDate: string): Promise<string | null> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('campaign_runs')
      .insert({
        campaign_id: campaign.id,
        business_id: campaign.business_id,
        run_local_date: localDate,
        status: 'running',
      })
      .select('id')
      .maybeSingle<{ id: string }>();

    if (error) {
      if (isUniqueViolation(error)) return null;
      throw new Error(`claim campaign run failed: ${error.message}`);
    }
    return data?.id ?? null;
  }

  private async completeRun(
    campaign: CampaignRow,
    outcome: CampaignRunOutcome,
    errorMessage: string | null,
  ): Promise<void> {
    const status = errorMessage ? 'failed' : outcome.failedCount > 0 ? 'partial' : 'completed';
    const { error } = await this.admin
      .schema('comms')
      .from('campaign_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
        candidate_count: outcome.candidateCount,
        eligible_count: outcome.eligibleCount,
        queued_count: outcome.queuedCount,
        suppressed_count: outcome.suppressedCount,
        failed_count: outcome.failedCount,
        suppression_breakdown: outcome.suppressionBreakdown,
        error_message: errorMessage?.slice(0, 500) ?? null,
      })
      .eq('id', outcome.runId);
    if (error) this.logger.error(`complete campaign run ${outcome.runId} failed: ${error.message}`);

    const { error: stampError } = await this.admin
      .schema('comms')
      .from('campaigns')
      .update({ last_evaluated_at: new Date().toISOString() })
      .eq('id', campaign.id);
    if (stampError) this.logger.error(`stamp campaign ${campaign.id} failed: ${stampError.message}`);
  }

  /** Atomic claim. Null means this identity has already had its message. */
  private async claimRecipient(
    campaign: CampaignRow,
    runId: string,
    candidate: CampaignCandidate,
  ): Promise<string | null> {
    const { data, error } = await this.admin.schema('comms').rpc('claim_campaign_recipient', {
      p_campaign_id: campaign.id,
      p_business_id: campaign.business_id,
      p_run_id: runId,
      p_client_profile_id: candidate.clientId,
      p_dedupe_key: candidate.dedupeKey,
      p_match_reason: candidate.matchReason,
    });
    if (error) throw new Error(`claim_campaign_recipient failed: ${error.message}`);

    const rows = (data ?? []) as Array<{ recipient_id: string; claimed: boolean }>;
    return rows.length > 0 && rows[0].claimed ? rows[0].recipient_id : null;
  }

  private async settleRecipient(
    recipientId: string,
    status: 'queued' | 'suppressed' | 'failed',
    suppressionReason: string | null,
    notificationEventId?: string | null,
    channel?: string | null,
  ): Promise<void> {
    const { error } = await this.admin.schema('comms').rpc('settle_campaign_recipient', {
      p_recipient_id: recipientId,
      p_status: status,
      p_suppression_reason: suppressionReason,
      p_notification_event_id: notificationEventId ?? null,
      p_channel: channel ?? null,
    });
    if (error) this.logger.error(`settle_campaign_recipient failed: ${error.message}`);
  }

  /**
   * Record a consent suppression WITHOUT claiming the identity.
   *
   * A client who has not consented must not have their send identity consumed —
   * if they opt in tomorrow the campaign should reach them. So this writes a row
   * only when none exists, and never overwrites a claimed or queued one.
   */
  private async recordSuppressionWithoutClaim(
    campaign: CampaignRow,
    runId: string,
    candidate: CampaignCandidate,
    reason: string,
  ): Promise<boolean> {
    const { error } = await this.admin
      .schema('comms')
      .from('campaign_recipients')
      .insert({
        campaign_id: campaign.id,
        business_id: campaign.business_id,
        run_id: runId,
        client_profile_id: candidate.clientId,
        dedupe_key: candidate.dedupeKey,
        status: 'suppressed',
        suppression_reason: reason,
        match_reason: candidate.matchReason,
      });
    // A unique violation here just means the row already exists (they were
    // suppressed before, or have already been messaged). Either way there is
    // nothing to change — recording the reason is best-effort evidence, never a
    // control-flow signal.
    if (!error) return true;
    if (isUniqueViolation(error)) return false;
    this.logger.error(`record campaign suppression failed: ${error.message}`);
    return false;
  }

  /** Identities on this campaign that have already produced a message. */
  private async fetchQueuedDedupeKeys(campaignId: string, keys: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (keys.length === 0) return found;

    const BATCH = 200;
    for (let from = 0; from < keys.length; from += BATCH) {
      const { data, error } = await this.admin
        .schema('comms')
        .from('campaign_recipients')
        .select('dedupe_key')
        .eq('campaign_id', campaignId)
        .eq('status', 'queued')
        .in('dedupe_key', keys.slice(from, from + BATCH))
        .returns<Array<{ dedupe_key: string }>>();
      if (error) throw new Error(`load campaign recipients failed: ${error.message}`);
      for (const row of data ?? []) found.add(row.dedupe_key);
    }
    return found;
  }

  private async fetchLastRunDate(campaignId: string): Promise<string | null> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('campaign_runs')
      .select('run_local_date')
      .eq('campaign_id', campaignId)
      .order('run_local_date', { ascending: false })
      .limit(1)
      .maybeSingle<{ run_local_date: string }>();
    if (error) throw new Error(`load last campaign run failed: ${error.message}`);
    return data?.run_local_date ?? null;
  }

  /**
   * Every active campaign, with its governing timezone resolved.
   *
   * The timezone is the campaign LOCATION's when the campaign is scoped to one,
   * otherwise the business's — resolved here, once, so no downstream code can
   * quietly fall back to server UTC.
   */
  private async fetchActiveCampaigns(): Promise<CampaignRow[]> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('campaigns')
      .select(CAMPAIGN_COLUMNS)
      .eq('status', 'active')
      .returns<Omit<CampaignRow, 'timezone'>[]>();
    if (error) throw new Error(`load active campaigns failed: ${error.message}`);

    const rows = data ?? [];
    if (rows.length === 0) return [];

    const timezones = await this.resolveTimezones(rows);
    return rows.map((row) => ({
      ...row,
      timezone: timezones.get(timezoneKey(row)) ?? 'Europe/London',
    }));
  }

  /** Location timezone for location-scoped campaigns; business timezone otherwise. */
  async resolveTimezones(
    rows: Array<{ business_id: string; location_id: string | null }>,
  ): Promise<Map<string, string>> {
    const byKey = new Map<string, string>();
    const businessIds = [...new Set(rows.map((r) => r.business_id))];
    const locationIds = [...new Set(rows.map((r) => r.location_id).filter((id): id is string => Boolean(id)))];

    const [businesses, locations] = await Promise.all([
      businessIds.length
        ? this.admin
            .schema('core')
            .from('businesses')
            .select('id,timezone')
            .in('id', businessIds)
            .returns<Array<{ id: string; timezone: string | null }>>()
        : Promise.resolve({ data: [], error: null }),
      locationIds.length
        ? this.admin
            .schema('core')
            .from('locations')
            .select('id,timezone')
            .in('id', locationIds)
            .returns<Array<{ id: string; timezone: string | null }>>()
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (businesses.error) throw new Error(`load business timezones failed: ${businesses.error.message}`);
    if (locations.error) throw new Error(`load location timezones failed: ${locations.error.message}`);

    const businessTz = new Map((businesses.data ?? []).map((b) => [b.id, b.timezone ?? 'Europe/London']));
    const locationTz = new Map((locations.data ?? []).map((l) => [l.id, l.timezone ?? 'Europe/London']));

    for (const row of rows) {
      byKey.set(
        timezoneKey(row),
        (row.location_id ? locationTz.get(row.location_id) : undefined) ??
          businessTz.get(row.business_id) ??
          'Europe/London',
      );
    }
    return byKey;
  }

  /**
   * The salon-wide template values. Resolved once per run, not once per client,
   * and only from values that always exist.
   */
  private async templateValuesFor(
    campaign: CampaignRow,
  ): Promise<Omit<CampaignTemplateValues, 'first_name' | 'last_name'>> {
    const [business, location] = await Promise.all([
      this.admin
        .schema('core')
        .from('businesses')
        .select('name,slug')
        .eq('id', campaign.business_id)
        .maybeSingle<{ name: string; slug: string }>(),
      campaign.location_id
        ? this.admin
            .schema('core')
            .from('locations')
            .select('name')
            .eq('id', campaign.location_id)
            .maybeSingle<{ name: string }>()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (business.error) throw new Error(`load business failed: ${business.error.message}`);
    if (location.error) throw new Error(`load location failed: ${location.error.message}`);

    const salonName = business.data?.name ?? 'our salon';
    return {
      salon_name: salonName,
      location_name: location.data?.name ?? salonName,
      booking_link: `${this.bookingBaseUrl}/book/location`,
    };
  }
}

export interface CampaignRunOutcome {
  runId: string;
  candidateCount: number;
  eligibleCount: number;
  queuedCount: number;
  suppressedCount: number;
  failedCount: number;
  suppressionBreakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timezoneKey(row: { business_id: string; location_id: string | null }): string {
  return `${row.business_id}:${row.location_id ?? ''}`;
}

/**
 * The campaign's channel choice as a narrowing hint for the messaging layer, or
 * undefined for `auto`. Uses the canonical helper (with no client preference to
 * combine yet) so the vocabulary stays in one place.
 */
function campaignChannelHint(channel: CampaignChannel): 'whatsapp' | 'sms' | 'email' | undefined {
  return narrowCampaignChannel(channel, null) ?? undefined;
}

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The salon-local calendar date and hour right now.
 *
 * DST-safe: the conversion is done by ICU, not by subtracting a fixed offset,
 * so a campaign does not fire twice or skip a day across a BST/GMT switch. Same
 * technique as `localDateIn` in client-intelligence.service.ts; the PARTS are
 * read rather than the formatted string because field order and separators vary
 * between ICU builds.
 */
export function salonNow(timeZone: string, at: Date = new Date()): { localDate: string; localHour: number } {
  let formatter = dateTimeFormatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      // An unknown IANA zone must not crash the evaluator. Fall back to the
      // platform default rather than to the server's own zone, which would vary
      // by deployment.
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      });
    }
    dateTimeFormatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  return {
    localDate: `${get('year')}-${get('month')}-${get('day')}`,
    // ICU renders midnight as "24" in some builds under h23's cousin h24.
    localHour: Number.isFinite(hour) ? hour % 24 : 0,
  };
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/** `j***@example.com` / `+44 ***** **1234`. Recognisable, not exportable. */
function maskContact(phone: string | null, email: string | null): string | null {
  if (phone) {
    const digits = phone.replace(/\s+/g, '');
    return digits.length <= 4 ? '****' : `${'*'.repeat(Math.max(3, digits.length - 4))}${digits.slice(-4)}`;
  }
  if (email) {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return null;
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key value/i.test(error.message ?? '');
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
