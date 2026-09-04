import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadAppointmentContext } from './appointment-context';
import { MessagingService } from './messaging.service';
import { NotificationEventKey } from './notification.types';

interface AppointmentServiceRow {
  service_id: string | null;
}

interface ServiceNudgeRow {
  id: string;
  rebooking_nudge_enabled: boolean;
  rebooking_nudge_interval_days: number;
}

/**
 * Schedules the per-service rebooking nudge (Wrike #4507281502).
 *
 * When a qualifying appointment completes, this looks at the services on that
 * appointment. If any of them have the rebooking nudge enabled, it queues a
 * single `rebooking_nudge` event into `comms.notification_events` at
 * `completed_at + interval`, where `interval` is the shortest enabled interval
 * among the appointment's services (nudge when the soonest-due service is due).
 *
 * Delivery reuses the existing WhatsApp → SMS → Email dispatcher. The nudge is
 * suppressed at send time if the client has meanwhile rebooked, so the "no nudge
 * if already rebooked" rule holds even weeks after scheduling — and now also when
 * a fallback channel is attempted.
 *
 * Idempotent: the partial unique index (appointment_id, event_key, channel)
 * guarantees at most one nudge per appointment per channel, so re-running the
 * completion flow never double-schedules.
 */
@Injectable()
export class RebookingNudgeService {
  private readonly logger = new Logger(RebookingNudgeService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly messaging: MessagingService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Best-effort scheduling hook for the completion flow. Never throws — a failure
   * to schedule the nudge must not roll back a completed appointment/checkout.
   */
  async scheduleForCompletedAppointmentSafe(appointmentId: string, completedAtIso?: string): Promise<void> {
    try {
      await this.scheduleForCompletedAppointment(appointmentId, completedAtIso);
    } catch (err) {
      this.logger.error(
        `scheduleForCompletedAppointment failed for appointment ${appointmentId}: ${(err as Error).message}`,
      );
    }
  }

  async scheduleForCompletedAppointment(appointmentId: string, completedAtIso?: string): Promise<void> {
    const context = await loadAppointmentContext(this.admin, appointmentId);
    const clientProfileId = context?.appointment.client_profile_id;
    if (!context || !clientProfileId) return;

    const intervalDays = await this.resolveIntervalDays(appointmentId);
    if (intervalDays === null) return; // no service opts into the nudge

    const anchor = completedAtIso ? new Date(completedAtIso) : new Date();
    if (Number.isNaN(anchor.getTime())) return;
    const scheduledFor = new Date(anchor.getTime() + intervalDays * 24 * 60 * 60 * 1000);

    const { appointment } = context;
    // Queued through the single send API, so the nudge gets exactly the same channel policy,
    // opt-out handling and fallback chain as every other message. Content is not snapshotted: the
    // nudge is appointment-anchored, so it renders from the approved rebooking template.
    const result = await this.messaging.send({
      businessId: appointment.business_id,
      locationId: appointment.location_id,
      clientProfileId,
      appointmentId: appointment.id,
      eventKey: NotificationEventKey.RebookingNudge,
      scheduledFor,
      metadata: { interval_days: intervalDays },
    });

    if (result.status === 'queued') {
      this.logger.log(
        `rebooking nudge queued for appointment ${appointmentId} on ${result.channel} at ${scheduledFor.toISOString()} (+${intervalDays}d)`,
      );
    } else if (result.status === 'skipped') {
      this.logger.log(`rebooking nudge not scheduled for appointment ${appointmentId}: ${result.reason}`);
    }
  }

  /**
   * The shortest enabled nudge interval (days) among the appointment's services,
   * or null when no service on the appointment has the nudge enabled.
   */
  private async resolveIntervalDays(appointmentId: string): Promise<number | null> {
    const { data: apptServices, error: apptErr } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('service_id')
      .eq('appointment_id', appointmentId)
      // 0110: the nudge interval follows what was PERFORMED, not what was booked.
      .neq('status', 'cancelled')
      .returns<AppointmentServiceRow[]>();
    if (apptErr) throw new Error(`load appointment services failed: ${apptErr.message}`);

    const serviceIds = Array.from(
      new Set((apptServices ?? []).map((r) => r.service_id).filter((id): id is string => Boolean(id))),
    );
    if (serviceIds.length === 0) return null;

    const { data: services, error: svcErr } = await this.admin
      .schema('booking')
      .from('services')
      .select('id,rebooking_nudge_enabled,rebooking_nudge_interval_days')
      .in('id', serviceIds)
      .eq('rebooking_nudge_enabled', true)
      .returns<ServiceNudgeRow[]>();
    if (svcErr) throw new Error(`load service nudge config failed: ${svcErr.message}`);

    const intervals = (services ?? [])
      .map((s) => s.rebooking_nudge_interval_days)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (intervals.length === 0) return null;
    return Math.min(...intervals);
  }

}
