import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CommunicationSettingsService } from './communication-settings.service';
import {
  INACTIVE_APPOINTMENT_STATUSES,
  loadAppointmentContext,
  type AppointmentNotificationContext,
} from './appointment-context';
import { resolveChannelPlan, type ContactEligibility, type DeliveryChannel } from './channel-policy';
import { MessagingService } from './messaging.service';
import { OptOutService } from './opt-out.service';
import { isValidEmail, normalizeE164 } from './phone';
import { NotificationEventKey } from './notification.types';
import { computeDesiredEvents, enabledEventKeys, type DesiredEvent } from './reminder-schedule';

interface ExistingEventRow {
  id: string;
  event_key: string;
  channel: string;
  status: string;
  scheduled_for: string | null;
  payload_json: Record<string, unknown> | null;
}

/**
 * Reminder/confirmation scheduling engine.
 *
 * `syncBookingNotifications` is the single idempotent entry point: given an
 * appointment id it (re)computes which WhatsApp events should exist based on the
 * location's reminder rules and the appointment's current state, then reconciles
 * the `comms.notification_events` queue to match. It is safe to call repeatedly
 * (on booking creation, edit, reschedule, or retry) — duplicates are prevented by
 * the partial unique index and by checking existing rows before inserting.
 *
 * Reminder timings are computed as absolute offsets from `scheduled_start_at`
 * (a timestamptz), so they are correct regardless of server timezone; the location
 * timezone is only used when rendering the message body.
 */
@Injectable()
export class BookingNotificationService {
  private readonly logger = new Logger(BookingNotificationService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly settingsService: CommunicationSettingsService,
    private readonly messaging: MessagingService,
    private readonly optOuts: OptOutService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Best-effort scheduling hook for the booking flow. Never throws — a failure to
   * schedule notifications must not roll back a confirmed booking. Use this from
   * booking creation / reschedule success paths.
   */
  async syncBookingNotificationsSafe(appointmentId: string): Promise<void> {
    try {
      await this.syncBookingNotifications(appointmentId);
    } catch (err) {
      this.logger.error(
        `syncBookingNotifications failed for appointment ${appointmentId}: ${(err as Error).message}`,
      );
    }
  }

  /** Reconcile the notification queue for one appointment against its current rules/state. */
  async syncBookingNotifications(appointmentId: string, now: Date = new Date()): Promise<void> {
    const context = await loadAppointmentContext(this.admin, appointmentId);
    if (!context) return;

    const existing = await this.fetchExistingEvents(appointmentId);

    // Appointment no longer active → cancel anything still pending.
    if (INACTIVE_APPOINTMENT_STATUSES.has(context.appointment.status)) {
      await this.cancelPending(existing);
      return;
    }

    const settings = await this.settingsService.getForLocation(
      context.appointment.business_id,
      context.appointment.location_id,
    );

    // Resolve the channel chain for this client (WhatsApp → SMS → Email, narrowed by preference,
    // eligibility and recorded opt-outs). When no channel is deliverable (master switch off, no
    // enabled channel, opted out, or no valid contact) we cancel any pending events so nothing stale
    // goes out.
    const optOuts = await this.optOuts.channelsFor(
      context.appointment.business_id,
      context.appointment.client_profile_id,
    );
    const plan = resolveChannelPlan(settings, context.communicationPreference, {
      ...this.contactFor(context),
      optedOutChannels: optOuts.channels,
    });
    if (!plan.deliverable) {
      await this.cancelPending(existing);
      return;
    }

    const start = new Date(context.appointment.scheduled_start_at);
    const enabledKeys = enabledEventKeys(settings);
    const desired = computeDesiredEvents(settings, start, now);

    // Events are scheduled on the PRIMARY channel only. Fallback events (SMS, then email) are created
    // lazily by NotificationEscalationService when the channel before them is clearly ineligible or
    // has a real failure — never up-front, so a pending delivery does not trigger a fallback.
    await this.reconcile(context, existing, desired, enabledKeys, plan.primary, now);
  }

  /** Cancel all still-pending events for an appointment (e.g. on cancellation/reschedule). */
  async cancelBookingNotifications(appointmentId: string): Promise<void> {
    const existing = await this.fetchExistingEvents(appointmentId);
    await this.cancelPending(existing);
  }

  private contactFor(context: AppointmentNotificationContext): ContactEligibility {
    return {
      phoneValid: Boolean(normalizeE164(context.clientPhone)),
      emailValid: isValidEmail(context.clientEmail),
    };
  }

  private async reconcile(
    context: AppointmentNotificationContext,
    existing: ExistingEventRow[],
    desired: DesiredEvent[],
    enabledKeys: Set<NotificationEventKey>,
    primaryChannel: DeliveryChannel,
    now: Date,
  ): Promise<void> {
    const desiredByKey = new Map(desired.map((d) => [d.eventKey, d]));

    // 1. Insert missing / update rescheduled events on the primary channel.
    for (const item of desired) {
      const match = existing.find(
        (e) => e.event_key === item.eventKey && e.channel === primaryChannel && e.status !== 'cancelled',
      );

      if (!match) {
        // CHANNEL-INDEPENDENT GUARD (Wrike 4507284256, section 4).
        //
        // `match` is deliberately still channel-scoped: the partial unique index
        // guarantees at most one non-cancelled row per (appointment, event_key,
        // channel), which is what makes that find deterministic even though a
        // fallback chain legitimately has two live rows for one event_key.
        //
        // But "no row on the primary channel" is NOT the same as "this message
        // has never been produced". If the client's channel plan moves after a
        // confirmation was already sent — a preference edit, an opt-out, or the
        // owner disabling a channel — the sent WhatsApp row is invisible to a
        // find scoped to email, so this used to insert a second event, the index
        // permitted it because the channel differed, and the client received a
        // GENUINE SECOND confirmation. Both attempts compute the same
        // `ap:<appointment>:<event_key>` usage key, so the second was billed as
        // zero, and neither recovery nor reconciliation could see it.
        //
        // So: ask the channel-independent question before inserting.
        if (this.alreadyLeftTheQueue(existing, item.eventKey)) continue;
        await this.insertEvent(context, item, primaryChannel, now);
        continue;
      }

      // A reminder whose attempt handed over to a fallback is history, not a live occupant of this
      // channel slot — but the partial unique index still counts it, so it has to be retired before
      // a reminder for the NEW appointment time can be queued. Only when the time actually moved:
      // an unchanged appointment's fallback is legitimately still in flight and must not be
      // duplicated. Confirmations are one-shot and are never re-queued, whatever state they are in.
      if (
        match.status === 'fallback_pending' &&
        item.eventKey !== NotificationEventKey.BookingConfirmation &&
        match.scheduled_for !== item.scheduledFor.toISOString()
      ) {
        await this.retireHandedOverEvent(match.id);
        await this.insertEvent(context, item, primaryChannel, now);
        continue;
      }

      // Only queued events are still mutable. Confirmations are one-shot (never rescheduled);
      // reminders follow the appointment time if it moved.
      if (match.status === 'queued' && item.eventKey !== NotificationEventKey.BookingConfirmation) {
        const desiredIso = item.scheduledFor.toISOString();
        if (match.scheduled_for !== desiredIso) {
          await this.updateEventSchedule(match.id, item, context, primaryChannel);
        }
      }
    }

    // 2. Cancel stale queued events. Fallback events (created by the escalation service) are
    //    left untouched. Non-fallback events on a channel other than the current primary are stale
    //    from a previous preference/channel (e.g. the client switched whatsapp → email) and are
    //    cancelled. Primary-channel events whose rule is disabled or window disappeared are cancelled.
    for (const row of existing) {
      if (row.status !== 'queued') continue;
      if (row.payload_json?.['fallback'] === true) continue;

      if (row.channel !== primaryChannel) {
        await this.cancelEvent(row.id);
        continue;
      }

      const key = row.event_key as NotificationEventKey;
      const ruleEnabled = enabledKeys.has(key);
      const stillDesired = desiredByKey.has(key) || key === NotificationEventKey.BookingConfirmation;
      if (!ruleEnabled || !stillDesired) {
        await this.cancelEvent(row.id);
      }
    }
  }

  /**
   * Queue one reminder/confirmation. The channel is already decided here (the plan is resolved once
   * for the whole reminder set), so this uses the single send API's channel-explicit writer rather
   * than re-resolving policy per event. Duplicate keys are handled inside as the idempotent outcome.
   */
  private async insertEvent(
    context: AppointmentNotificationContext,
    item: DesiredEvent,
    channel: DeliveryChannel,
    now: Date,
  ): Promise<void> {
    const { appointment } = context;
    await this.messaging.enqueueOnChannel({
      businessId: appointment.business_id,
      locationId: appointment.location_id,
      clientProfileId: appointment.client_profile_id,
      appointmentId: appointment.id,
      channel,
      eventKey: item.eventKey,
      scheduledFor: item.scheduledFor,
      payload: this.buildPayload(context, item.eventKey, channel, now),
    });
  }

  private async updateEventSchedule(
    eventId: string,
    item: DesiredEvent,
    context: AppointmentNotificationContext,
    channel: DeliveryChannel,
  ): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .update({
        scheduled_for: item.scheduledFor.toISOString(),
        payload_json: this.buildPayload(context, item.eventKey, channel, new Date()),
        locked_until: null,
      })
      .eq('id', eventId)
      .eq('status', 'queued');
    if (error) throw new Error(`reschedule notification_event failed: ${error.message}`);
  }

  private buildPayload(
    context: AppointmentNotificationContext,
    eventKey: NotificationEventKey,
    channel: DeliveryChannel,
    now: Date,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      event_key: eventKey,
      channel,
      // Snapshot of the appointment time the event was scheduled against — the dispatcher
      // compares this with the live appointment to detect stale (rescheduled) reminders.
      appointment_start: context.appointment.scheduled_start_at,
      generated_at: now.toISOString(),
      ...extra,
    };
  }

  private async cancelPending(existing: ExistingEventRow[]): Promise<void> {
    const ids = existing.filter((e) => e.status === 'queued').map((e) => e.id);
    if (ids.length === 0) return;
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'cancelled', locked_until: null })
      .in('id', ids)
      .eq('status', 'queued');
    if (error) throw new Error(`cancel notification_events failed: ${error.message}`);
  }

  /**
   * Has this logical message already left the queue on ANY channel?
   *
   * `queued` and `cancelled` are the two states that mean it has not:
   *   queued    — an unsent routing decision. Nothing has reached a provider, so
   *               it is free to be re-routed: the step-2 sweep cancels the
   *               off-primary row and the fresh insert takes over. This is how a
   *               preference change legitimately moves an unsent reminder, and
   *               excluding it here is what keeps that behaviour intact.
   *   cancelled — retired without being delivered.
   *
   * Every other state (`sent`, `delivered`, `read`, `undelivered`, `failed`,
   * `skipped`, `fallback_pending`) means a provider already took the message or
   * the next channel in the chain is already carrying it. Re-queueing then is
   * not rescheduling, it is a duplicate — one the ledger counts as zero, because
   * the whole point of the appointment-anchored key is that a fallback of the
   * SAME message costs one unit.
   *
   * Note the division of labour this preserves: retrying and falling back belong
   * to NotificationEscalationService, which owns the chain. This service decides
   * what SHOULD exist, and it must not re-open a message that has already been
   * handed over.
   */
  private alreadyLeftTheQueue(existing: ExistingEventRow[], eventKey: string): boolean {
    return existing.some(
      (row) => row.event_key === eventKey && row.status !== 'queued' && row.status !== 'cancelled',
    );
  }

  /**
   * Retire an event that already handed over to a fallback, so the channel slot (and the partial
   * unique index that guards it) is free for a reminder at the rescheduled time. Guarded on the
   * status so it can never touch a queued or delivered event. The successor it spawned carries the
   * old `appointment_start` and is cancelled as stale when it comes due, so nothing is double-sent.
   */
  private async retireHandedOverEvent(eventId: string): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'cancelled', locked_until: null })
      .eq('id', eventId)
      .eq('status', 'fallback_pending');
    if (error) throw new Error(`retire handed-over notification_event failed: ${error.message}`);
  }

  private async cancelEvent(eventId: string): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .update({ status: 'cancelled', locked_until: null })
      .eq('id', eventId)
      .eq('status', 'queued');
    if (error) throw new Error(`cancel notification_event failed: ${error.message}`);
  }

  private async fetchExistingEvents(appointmentId: string): Promise<ExistingEventRow[]> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .select('id,event_key,channel,status,scheduled_for,payload_json')
      .eq('appointment_id', appointmentId)
      .returns<ExistingEventRow[]>();
    if (error) throw new Error(`fetch notification_events failed: ${error.message}`);
    return data ?? [];
  }
}
