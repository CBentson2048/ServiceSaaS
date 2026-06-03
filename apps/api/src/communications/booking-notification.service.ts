import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CommunicationSettingsService } from './communication-settings.service';
import {
  INACTIVE_APPOINTMENT_STATUSES,
  loadAppointmentContext,
  type AppointmentNotificationContext,
} from './appointment-context';
import { NotificationEventKey, WHATSAPP_CHANNEL } from './notification.types';
import { computeDesiredEvents, enabledEventKeys, type DesiredEvent } from './reminder-schedule';

interface ExistingEventRow {
  id: string;
  event_key: string;
  channel: string;
  status: string;
  scheduled_for: string | null;
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

    // Master switch off, channel not permitted, client doesn't prefer WhatsApp, or no phone →
    // we cannot/should not deliver; cancel any pending events so nothing stale goes out.
    if (!this.canDeliverWhatsApp(settings.enabled, settings.enabledChannels, context)) {
      await this.cancelPending(existing);
      return;
    }

    const start = new Date(context.appointment.scheduled_start_at);
    const enabledKeys = enabledEventKeys(settings);
    const desired = computeDesiredEvents(settings, start, now);

    await this.reconcile(context, existing, desired, enabledKeys, now);
  }

  /** Cancel all still-pending events for an appointment (e.g. on cancellation/reschedule). */
  async cancelBookingNotifications(appointmentId: string): Promise<void> {
    const existing = await this.fetchExistingEvents(appointmentId);
    await this.cancelPending(existing);
  }

  private canDeliverWhatsApp(
    enabled: boolean,
    enabledChannels: string[],
    context: AppointmentNotificationContext,
  ): boolean {
    return (
      enabled &&
      enabledChannels.includes(WHATSAPP_CHANNEL) &&
      context.communicationPreference === WHATSAPP_CHANNEL &&
      Boolean(context.clientPhone?.trim())
    );
  }

  private async reconcile(
    context: AppointmentNotificationContext,
    existing: ExistingEventRow[],
    desired: DesiredEvent[],
    enabledKeys: Set<NotificationEventKey>,
    now: Date,
  ): Promise<void> {
    const desiredByKey = new Map(desired.map((d) => [d.eventKey, d]));

    // 1. Insert missing / update rescheduled events.
    for (const item of desired) {
      const match = existing.find(
        (e) => e.event_key === item.eventKey && e.channel === WHATSAPP_CHANNEL && e.status !== 'cancelled',
      );

      if (!match) {
        await this.insertEvent(context, item, now);
        continue;
      }

      // Only queued events are still mutable. Confirmations are one-shot (never rescheduled);
      // reminders follow the appointment time if it moved.
      if (match.status === 'queued' && item.eventKey !== NotificationEventKey.BookingConfirmation) {
        const desiredIso = item.scheduledFor.toISOString();
        if (match.scheduled_for !== desiredIso) {
          await this.updateEventSchedule(match.id, item, context);
        }
      }
    }

    // 2. Cancel queued events whose rule is no longer enabled (toggled off), or whose
    //    desired window disappeared (e.g. reminder now in the past and not re-created).
    for (const row of existing) {
      if (row.status !== 'queued' || row.channel !== WHATSAPP_CHANNEL) continue;
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
        channel: WHATSAPP_CHANNEL,
        event_key: item.eventKey,
        status: 'queued',
        scheduled_for: item.scheduledFor.toISOString(),
        payload_json: this.buildPayload(context, item, now),
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
  ): Promise<void> {
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .update({
        scheduled_for: item.scheduledFor.toISOString(),
        payload_json: this.buildPayload(context, item, new Date()),
        locked_until: null,
      })
      .eq('id', eventId)
      .eq('status', 'queued');
    if (error) throw new Error(`reschedule notification_event failed: ${error.message}`);
  }

  private buildPayload(
    context: AppointmentNotificationContext,
    item: DesiredEvent,
    now: Date,
  ): Record<string, unknown> {
    return {
      event_key: item.eventKey,
      channel: WHATSAPP_CHANNEL,
      // Snapshot of the appointment time the event was scheduled against — the dispatcher
      // compares this with the live appointment to detect stale (rescheduled) reminders.
      appointment_start: context.appointment.scheduled_start_at,
      scheduled_for: item.scheduledFor.toISOString(),
      generated_at: now.toISOString(),
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
      .select('id,event_key,channel,status,scheduled_for')
      .eq('appointment_id', appointmentId)
      .returns<ExistingEventRow[]>();
    if (error) throw new Error(`fetch notification_events failed: ${error.message}`);
    return data ?? [];
  }
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key value/i.test(error.message ?? '');
}
