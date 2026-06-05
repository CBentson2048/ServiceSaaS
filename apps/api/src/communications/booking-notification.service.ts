import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CommunicationSettingsService } from './communication-settings.service';
import {
  INACTIVE_APPOINTMENT_STATUSES,
  loadAppointmentContext,
  type AppointmentNotificationContext,
} from './appointment-context';
import {
  resolveChannelPlan,
  nextChannelAfter,
  type ContactEligibility,
  type DeliveryChannel,
} from './channel-policy';
import { isValidEmail, normalizeE164 } from './phone';
import { NotificationEventKey, REMINDER_EVENT_KEYS } from './notification.types';
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

    // Resolve the channel chain for this client (WhatsApp → Email → SMS, narrowed by preference and
    // eligibility). When no channel is deliverable (master switch off, no enabled channel, opted out,
    // or no valid contact) we cancel any pending events so nothing stale goes out.
    const plan = resolveChannelPlan(settings, context.communicationPreference, this.contactFor(context));
    if (!plan.deliverable) {
      await this.cancelPending(existing);
      return;
    }

    const start = new Date(context.appointment.scheduled_start_at);
    const enabledKeys = enabledEventKeys(settings);
    const desired = computeDesiredEvents(settings, start, now);

    // Events are scheduled on the PRIMARY channel only. Fallback events (email, then SMS) are created
    // lazily by the dispatcher/callbacks when the channel before them is clearly ineligible or has a
    // real failure — never up-front, so a pending WhatsApp/email delivery does not trigger a fallback.
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

    // 2. Cancel stale queued events. Fallback events (SMS created by the dispatcher/callbacks) are
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

  private async insertEvent(
    context: AppointmentNotificationContext,
    item: DesiredEvent,
    channel: DeliveryChannel,
    now: Date,
  ): Promise<void> {
    const { appointment } = context;
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .insert({
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        client_profile_id: appointment.client_profile_id,
        appointment_id: appointment.id,
        channel,
        event_key: item.eventKey,
        status: 'queued',
        scheduled_for: item.scheduledFor.toISOString(),
        payload_json: this.buildPayload(context, item.eventKey, channel, now),
      });

    if (error) {
      // The partial unique index (appointment_id, event_key, channel) may reject a
      // concurrent duplicate — that's the desired idempotent outcome, so swallow it.
      if (isUniqueViolation(error)) return;
      throw new Error(`insert notification_event failed: ${error.message}`);
    }
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

  /**
   * Escalate a notification to the NEXT channel in its WhatsApp → Email → SMS chain after
   * `failedChannel` was ineligible or had a real failure. Never throws (used from delivery/callback
   * paths). This is the ONLY place a fallback event is created, and only ever for the single next
   * channel — so a pending/accepted message never triggers a fallback, and a real failure produces
   * at most one new channel attempt.
   */
  async escalateToNextChannelSafe(
    appointmentId: string,
    eventKey: string,
    failedChannel: DeliveryChannel,
    reason: string,
  ): Promise<void> {
    try {
      await this.escalateToNextChannel(appointmentId, eventKey, failedChannel, reason);
    } catch (err) {
      this.logger.error(
        `escalateToNextChannel failed for appointment ${appointmentId} / ${eventKey}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Enqueue the next fallback channel after `failedChannel`. Returns the channel that was enqueued
   * (or already existed — idempotent), or `null` when there is no further channel to try, the
   * appointment is inactive, or the reminder is no longer time-valid. Idempotent: the partial unique
   * index on (appointment_id, event_key, channel) prevents a duplicate fallback for the same event.
   */
  async escalateToNextChannel(
    appointmentId: string,
    eventKey: string,
    failedChannel: DeliveryChannel,
    reason: string,
    now: Date = new Date(),
  ): Promise<DeliveryChannel | null> {
    const context = await loadAppointmentContext(this.admin, appointmentId);
    if (!context) return null;
    if (INACTIVE_APPOINTMENT_STATUSES.has(context.appointment.status)) return null;

    // Stale (rescheduled) or already-passed reminders are no longer time-valid to send.
    if (REMINDER_EVENT_KEYS.has(eventKey)) {
      if (new Date(context.appointment.scheduled_start_at).getTime() <= now.getTime()) return null;
    }

    const settings = await this.settingsService.getForLocation(
      context.appointment.business_id,
      context.appointment.location_id,
    );
    const plan = resolveChannelPlan(settings, context.communicationPreference, this.contactFor(context));
    const next = nextChannelAfter(plan, failedChannel);
    if (!next) return null;

    const { appointment } = context;
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .insert({
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        client_profile_id: appointment.client_profile_id,
        appointment_id: appointment.id,
        channel: next,
        event_key: eventKey,
        status: 'queued',
        scheduled_for: now.toISOString(),
        payload_json: this.buildPayload(context, eventKey as NotificationEventKey, next, now, {
          fallback: true,
          primary_channel: failedChannel,
          fallback_reason: reason,
        }),
      });

    if (error) {
      if (isUniqueViolation(error)) return next; // fallback already exists — idempotent, no duplicate.
      throw new Error(`insert ${next} fallback event failed: ${error.message}`);
    }
    this.logger.log(
      `${next} fallback queued for appointment ${appointmentId} / ${eventKey} (after ${failedChannel} ${reason})`,
    );
    return next;
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

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key value/i.test(error.message ?? '');
}
