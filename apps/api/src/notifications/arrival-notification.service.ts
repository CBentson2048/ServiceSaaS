import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NotificationPriority, NotificationType } from '@sheer/domain';
import { NotificationsService } from './notifications.service';

/** The appointment fields a check-in notification needs — nothing more is read. */
export interface NotifiableAppointment {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string | null;
  assigned_staff_profile_id: string | null;
  /** The check-in this notification is about. Part of the dedupe key. */
  check_in_at?: string | null;
}

/**
 * Arrival alerts — the first producer on the notification foundation.
 *
 * Reception checks a client in at the desk; the assigned stylist gets an in-app
 * notification carrying the appointment's routing context. This class contains
 * ONLY the arrival-specific parts (who to tell, what to say, what to link to).
 * Storage, recipient state, read/unread, tenancy and device targeting all belong to
 * {@link NotificationsService} — a producer must never grow its own copy of them,
 * which is the reason this ticket exists.
 *
 * FAILURE ISOLATION. The single public method never throws. It is called AFTER the
 * check-in status write has committed, so a broken notification path degrades to
 * "the stylist's phone stayed quiet" and never to "the client could not be checked
 * in". Everything it can fail on — the staff lookup, the client lookup, the insert —
 * is inside the try.
 *
 * IDEMPOTENCY. The dedupe key is `client_arrived:<appointmentId>:<check_in_at>`, so a
 * double-tapped front-desk button, a retried request or a replayed job all resolve
 * to the one notification. This is belt-and-braces: the caller already emits only on
 * the branch that won the conditional status update.
 *
 * WHY THE KEY CARRIES THE CHECK-IN TIME. A dedupe key is consumed for all time
 * (idx_notifications_dedupe_unique). A mistaken check-in can now be undone, so one
 * appointment can genuinely arrive twice; keyed on the appointment alone, the REAL
 * arrival after an undo would be silently swallowed as a duplicate of the mistake.
 * Each check-in stamps a fresh `check_in_at`, so each one is its own event.
 */
@Injectable()
export class ArrivalNotificationService {
  private readonly logger = new Logger(ArrivalNotificationService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Notify the assigned stylist that their client has arrived. Never throws.
   *
   * @param appointment the row the caller just transitioned to `checked_in`.
   * @param actingUserProfileId whoever performed the check-in, recorded as the
   *        notification's author (not as a recipient).
   */
  async notifyClientArrivedSafe(
    appointment: NotifiableAppointment,
    actingUserProfileId?: string | null,
  ): Promise<void> {
    try {
      const recipient = await this.resolveRecipient(appointment, 'arrival');
      if (!recipient) return;

      await this.notifications.createSafe({
        businessId: appointment.business_id,
        locationId: appointment.location_id,
        type: NotificationType.ClientArrived,
        // Arrival is time-critical for the person about to start the service, but it
        // is not an emergency; 'high' sorts it above routine notices without
        // claiming the top tier.
        priority: NotificationPriority.High,
        title: 'Client arrived',
        body: buildArrivalBody(recipient.clientFirstName),
        recipientUserProfileIds: [recipient.stylistUserProfileId],
        entityType: 'appointment',
        entityId: appointment.id,
        // /bookings is the diary; the query parameter lets it focus the appointment.
        // There is no per-appointment page in the web app, so linking to one would
        // produce a dead link.
        actionPath: `/bookings?appointmentId=${appointment.id}`,
        // Without a check-in time (a caller predating undo) the legacy key is kept,
        // so nothing already delivered can be re-sent under a new key.
        dedupeKey: appointment.check_in_at
          ? `client_arrived:${appointment.id}:${appointment.check_in_at}`
          : `client_arrived:${appointment.id}`,
        createdByUserProfileId: actingUserProfileId ?? null,
      });
    } catch (err) {
      // createSafe already swallows; this catches the lookups either side of it, so
      // a check-in can never be turned into a 500 by this method.
      //
      // Optional chaining on `appointment` is not paranoia: a catch block that can
      // itself throw silently voids the never-throws contract this whole class is
      // built on, and the one input guaranteed to reach here is the one that was
      // malformed enough to fail in the first place.
      this.logger.error(
        `arrival notification failed for appointment ${appointment?.id ?? 'unknown'}: ` +
          `${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Tell the assigned stylist that a check-in was a mistake and the client has NOT
   * arrived. Never throws.
   *
   * The arrival alert has already reached their phone and a push cannot be recalled,
   * so the honest correction is a second notice — otherwise the stylist walks out to
   * reception for a client who is not there. Same recipient, same routing, same
   * first-name-only content rule as the arrival it corrects.
   *
   * @param appointment the row as it was BEFORE the undo, so `check_in_at` names the
   *        check-in being undone. The key ties this notice to that one check-in.
   * @param actingUserProfileId whoever undid the check-in.
   */
  async notifyCheckInUndoneSafe(
    appointment: NotifiableAppointment,
    actingUserProfileId?: string | null,
  ): Promise<void> {
    try {
      const recipient = await this.resolveRecipient(appointment, 'check-in undone');
      if (!recipient) return;

      await this.notifications.createSafe({
        businessId: appointment.business_id,
        locationId: appointment.location_id,
        type: NotificationType.CheckInUndone,
        // Same tier as the arrival it corrects: it has to be seen before the stylist
        // acts on that one.
        priority: NotificationPriority.High,
        title: 'Check-in undone',
        body: buildCheckInUndoneBody(recipient.clientFirstName),
        recipientUserProfileIds: [recipient.stylistUserProfileId],
        entityType: 'appointment',
        entityId: appointment.id,
        actionPath: `/bookings?appointmentId=${appointment.id}`,
        // No check-in time means no stable identity for the event; `null` is "no
        // dedupe", which is safer than a key that would block every later notice.
        dedupeKey: appointment.check_in_at
          ? `check_in_undone:${appointment.id}:${appointment.check_in_at}`
          : null,
        createdByUserProfileId: actingUserProfileId ?? null,
      });
    } catch (err) {
      this.logger.error(
        `check-in undone notification failed for appointment ${appointment?.id ?? 'unknown'}: ` +
          `${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * The assigned stylist's user id and the client's first name, or null when there is
   * nobody to tell. Lookups may throw; both public callers catch.
   */
  private async resolveRecipient(
    appointment: NotifiableAppointment,
    kind: string,
  ): Promise<{ stylistUserProfileId: string; clientFirstName: string | null } | null> {
    // `assigned_staff_profile_id` is nullable (staff_request_mode can be
    // 'next_available', and the FK is ON DELETE SET NULL). With nobody assigned
    // there is no correct single recipient, and notifying the whole location would
    // be a different feature than the one that was approved.
    if (!appointment.assigned_staff_profile_id) {
      this.logger.log(`appointment ${appointment.id} has no assigned stylist — no ${kind} notification`);
      return null;
    }

    const stylistUserProfileId = await this.resolveStaffUserProfileId(
      appointment.business_id,
      appointment.assigned_staff_profile_id,
    );
    if (!stylistUserProfileId) {
      this.logger.warn(
        `no user profile for staff ${appointment.assigned_staff_profile_id} ` +
          `(appointment ${appointment.id}) — ${kind} notification skipped`,
      );
      return null;
    }

    const clientFirstName = appointment.client_profile_id
      ? await this.resolveClientFirstName(appointment.business_id, appointment.client_profile_id)
      : null;
    return { stylistUserProfileId, clientFirstName };
  }

  /**
   * booking.appointments.assigned_staff_profile_id -> core.staff_profiles.user_profile_id.
   *
   * The only route from an appointment to the stylist's USER id, and nothing else in
   * the appointment path resolves it today (every other staff lookup selects
   * display_name). One row per call here because arrival is a single appointment; a
   * future producer notifying a day's worth of appointments must batch with
   * `.in('id', ids)` rather than calling this in a loop.
   */
  private async resolveStaffUserProfileId(
    businessId: string,
    staffProfileId: string,
  ): Promise<string | null> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('user_profile_id')
      .eq('id', staffProfileId)
      .eq('business_id', businessId)
      .maybeSingle<{ user_profile_id: string }>();

    if (error) {
      this.logger.error(`resolve staff ${staffProfileId} failed: ${error.message}`);
      return null;
    }
    return data?.user_profile_id ?? null;
  }

  private async resolveClientFirstName(
    businessId: string,
    clientProfileId: string,
  ): Promise<string | null> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('first_name')
      .eq('id', clientProfileId)
      .eq('business_id', businessId)
      .maybeSingle<{ first_name: string | null }>();

    if (error) {
      // A missing name is not worth losing the notification over — the generic body
      // still tells the stylist what they need to know.
      this.logger.warn(`resolve client ${clientProfileId} failed: ${error.message}`);
      return null;
    }
    return data?.first_name ?? null;
  }
}

/**
 * Arrival body text.
 *
 * FIRST NAME ONLY, and nothing else. This string is rendered on a phone the stylist
 * may hand to a client, on a shared salon device, and — once push lands — on a lock
 * screen. A first name identifies the client to the person expecting them while
 * revealing very little to anyone else; a surname, the service, the price, a client
 * note or an allergy flag would all be a privacy regression the moment the screen is
 * visible to someone else. Anything more detailed belongs behind `actionPath`, where
 * the target screen re-authorises the read.
 */
export function buildArrivalBody(clientFirstName: string | null | undefined): string {
  const name = clientFirstName?.trim();
  return name ? `${name} has arrived.` : 'Your next client has arrived.';
}

/**
 * Check-in undone body text. The same first-name-only rule as
 * {@link buildArrivalBody}, for the same reasons.
 */
export function buildCheckInUndoneBody(clientFirstName: string | null | undefined): string {
  const name = clientFirstName?.trim();
  return name
    ? `${name} has not arrived — their check-in was undone.`
    : 'A check-in was undone — your client has not arrived.';
}
