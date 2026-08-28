import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CommunicationPreference } from '@sheer/domain';
import {
  INACTIVE_APPOINTMENT_STATUSES,
  loadAppointmentContext,
  type AppointmentNotificationContext,
} from '../appointment-context';
import type { ContactEligibility, DeliveryChannel } from '../channel-policy';
import { NotificationEventKey, REMINDER_EVENT_KEYS } from '../notification.types';
import {
  buildContentVariables,
  renderEmail,
  renderNotification,
  type NotificationContext,
} from '../notification.templates';
import type {
  NotificationEventRow,
  NotificationSubject,
  MessageClass,
  NotificationSubjectResolver,
  RenderedChannelMessage,
  SubjectPrecheckFailure,
  SubjectPrecheckPhase,
} from '../notification-subject';
import { isValidEmail, normalizeE164 } from '../phone';
import { isReminderStale } from '../reminder-schedule';
import { WhatsAppTemplateConfig } from '../whatsapp-template.config';

/**
 * Booking confirmations, reminders and rebooking nudges — everything anchored to a row in
 * `booking.appointments`.
 *
 * This is the pre-existing dispatch behaviour moved behind {@link NotificationSubjectResolver}
 * unchanged: the same appointment context load, the same staleness and rebooked-suppression rules,
 * the same templates and the same approved Content SIDs. Nothing about how a booking notification is
 * decided or rendered changes here; it is only now stated as one implementation of a general
 * contract rather than as the dispatcher's only possible behaviour.
 */
@Injectable()
export class AppointmentSubjectResolver implements NotificationSubjectResolver {
  readonly kind = 'appointment' as const;
  private readonly logger = new Logger(AppointmentSubjectResolver.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly templates: WhatsAppTemplateConfig,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  supports(event: NotificationEventRow): boolean {
    return Boolean(event.appointment_id);
  }

  async resolve(event: NotificationEventRow): Promise<NotificationSubject | null> {
    if (!event.appointment_id) return null;
    const context = await loadAppointmentContext(this.admin, event.appointment_id);
    if (!context) return null;
    return new AppointmentSubject(this.admin, this.logger, this.templates, event, context);
  }
}

class AppointmentSubject implements NotificationSubject {
  readonly kind = 'appointment' as const;
  /**
   * Booking confirmations and reminders are service messages about an appointment the client made,
   * so they are transactional. The rebooking nudge is re-engagement and is registered with Twilio
   * under the MARKETING category, but gating it on `marketing_opt_in` would change behaviour that is
   * already signed off — that is a product decision, not one to slip in here.
   */
  readonly messageClass: MessageClass = 'transactional';

  constructor(
    private readonly admin: SupabaseClient,
    private readonly logger: Logger,
    private readonly templates: WhatsAppTemplateConfig,
    private readonly event: NotificationEventRow,
    private readonly context: AppointmentNotificationContext,
  ) {}

  get businessId(): string {
    return this.context.appointment.business_id;
  }

  get locationId(): string {
    return this.context.appointment.location_id;
  }

  get clientProfileId(): string | null {
    return this.context.appointment.client_profile_id;
  }

  get preference(): CommunicationPreference | null {
    return this.context.communicationPreference ?? null;
  }

  get phone(): string | null {
    return this.context.clientPhone ?? null;
  }

  get email(): string | null {
    return this.context.clientEmail ?? null;
  }

  contact(): ContactEligibility {
    return {
      phoneValid: Boolean(normalizeE164(this.context.clientPhone)),
      emailValid: isValidEmail(this.context.clientEmail),
    };
  }

  /**
   * Scheduling corrections that apply to every channel, then the nudge-specific suppression.
   *
   * The rebooked check is deliberately send-time only. A nudge is queued at checkout and fires weeks
   * later, so it is judged against the client's state when it fires — a client who books at the desk
   * and then cancels that booking still gets nudged, exactly as before. Because a fallback is also a
   * send-time decision, the check now runs there too: a client who rebooks between the WhatsApp
   * failure and the SMS attempt is no longer nudged, which is what the rule always claimed.
   */
  async precheck(now: Date, phase: SubjectPrecheckPhase): Promise<SubjectPrecheckFailure | null> {
    const { appointment } = this.context;
    if (INACTIVE_APPOINTMENT_STATUSES.has(appointment.status)) {
      return { cancel: true, reason: `appointment is ${appointment.status}` };
    }
    if (REMINDER_EVENT_KEYS.has(this.event.event_key)) {
      if (isReminderStale(this.event.payload_json?.['appointment_start'], appointment.scheduled_start_at)) {
        return { cancel: true, reason: 'appointment was rescheduled after this reminder was queued' };
      }
      if (new Date(appointment.scheduled_start_at).getTime() <= now.getTime()) {
        return { cancel: true, reason: 'appointment start time has passed' };
      }
    }
    if (
      phase === 'dispatch' &&
      this.event.event_key === NotificationEventKey.RebookingNudge &&
      (await this.clientAlreadyRebooked())
    ) {
      return { cancel: true, reason: 'client has already rebooked' };
    }
    return null;
  }

  render(channel: DeliveryChannel): RenderedChannelMessage {
    const eventKey = this.event.event_key as NotificationEventKey;
    const ctx = this.renderContext();
    const message = renderNotification(eventKey, ctx);
    const templateVariables = buildContentVariables(ctx);

    if (channel === 'email') {
      const email = renderEmail(eventKey, ctx);
      return {
        body: message.body,
        preview: message.preview,
        subject: email.subject,
        html: email.html,
        text: email.text,
        templateVariables,
      };
    }

    return {
      body: message.body,
      preview: message.preview,
      // Approved Content template for WhatsApp; SMS is always freeform.
      templateId: channel === 'whatsapp' ? this.templates.contentSidFor(eventKey) : undefined,
      templateVariables,
    };
  }

  /** The live appointment start — refreshed on every generated event so staleness stays comparable. */
  payloadSnapshot(): Record<string, unknown> {
    return { appointment_start: this.context.appointment.scheduled_start_at };
  }

  private renderContext(): NotificationContext {
    return {
      clientFirstName: this.context.clientFirstName,
      locationName: this.context.locationName,
      timezone: this.context.timezone,
      scheduledStartAt: this.context.appointment.scheduled_start_at,
      serviceNames: this.context.serviceNames,
      stylistName: this.context.stylistName,
    };
  }

  /**
   * True when the client already has a future active appointment — i.e. they have rebooked, so the
   * retention nudge is no longer warranted. Excludes the source appointment itself. Fails "not
   * suppressed" on query error so a transient DB blip doesn't silently swallow the nudge.
   */
  private async clientAlreadyRebooked(): Promise<boolean> {
    const { appointment } = this.context;
    if (!appointment.client_profile_id) return false;
    const nowIso = new Date().toISOString();
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id')
      .eq('business_id', appointment.business_id)
      .eq('client_profile_id', appointment.client_profile_id)
      .neq('id', appointment.id)
      .gt('scheduled_start_at', nowIso)
      .not('status', 'in', '("cancelled","no_show","rejected")')
      .limit(1)
      .returns<{ id: string }[]>();
    if (error) {
      this.logger.error(`clientAlreadyRebooked check failed for event ${this.event.id}: ${error.message}`);
      return false;
    }
    return (data?.length ?? 0) > 0;
  }
}
