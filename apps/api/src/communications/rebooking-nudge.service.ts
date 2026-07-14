import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CommunicationSettingsService } from './communication-settings.service';
import { loadAppointmentContext } from './appointment-context';
import { resolveChannelPlan, type ContactEligibility } from './channel-policy';
import { isValidEmail, normalizeE164 } from './phone';
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
 * Delivery reuses the existing WhatsApp → Email → SMS dispatcher. The dispatcher
 * suppresses the nudge at send time if the client has meanwhile rebooked, so the
 * "no nudge if already rebooked" rule holds even weeks after scheduling.
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
    private readonly settingsService: CommunicationSettingsService,
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
    if (!context || !context.appointment.client_profile_id) return;

    const intervalDays = await this.resolveIntervalDays(appointmentId);
    if (intervalDays === null) return; // no service opts into the nudge

    // Respect the location's messaging switch and the client's channel/contact
    // eligibility — same policy the booking notifications use.
    const settings = await this.settingsService.getForLocation(
      context.appointment.business_id,
      context.appointment.location_id,
    );
    const plan = resolveChannelPlan(settings, context.communicationPreference, this.contactFor(context));
    if (!plan.deliverable) return;

    const anchor = completedAtIso ? new Date(completedAtIso) : new Date();
    if (Number.isNaN(anchor.getTime())) return;
    const scheduledFor = new Date(anchor.getTime() + intervalDays * 24 * 60 * 60 * 1000);

    const { appointment } = context;
    const { error } = await this.admin
      .schema('comms')
      .from('notification_events')
      .insert({
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        client_profile_id: appointment.client_profile_id,
        appointment_id: appointment.id,
        channel: plan.primary,
        event_key: NotificationEventKey.RebookingNudge,
        status: 'queued',
        scheduled_for: scheduledFor.toISOString(),
        payload_json: {
          event_key: NotificationEventKey.RebookingNudge,
          channel: plan.primary,
          // Snapshot the completed appointment's start so CRM history is legible;
          // the dispatcher never treats the nudge as a (stale) reminder.
          appointment_start: appointment.scheduled_start_at,
          interval_days: intervalDays,
          generated_at: new Date().toISOString(),
        },
      });

    if (error) {
      // Idempotent: the partial unique index rejects a concurrent/duplicate nudge.
      if (isUniqueViolation(error)) return;
      throw new Error(`insert rebooking_nudge event failed: ${error.message}`);
    }
    this.logger.log(
      `rebooking nudge queued for appointment ${appointmentId} on ${plan.primary} at ${scheduledFor.toISOString()} (+${intervalDays}d)`,
    );
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

  private contactFor(context: {
    clientPhone?: string | null;
    clientEmail?: string | null;
  }): ContactEligibility {
    return {
      phoneValid: Boolean(normalizeE164(context.clientPhone)),
      emailValid: isValidEmail(context.clientEmail),
    };
  }
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key value/i.test(error.message ?? '');
}
