import type { SupabaseClient } from '@supabase/supabase-js';
import type { CommunicationPreference } from '@sheer/domain';

export interface AppointmentRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string | null;
  status: string;
  scheduled_start_at: string;
  communication_preference: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AppointmentNotificationContext {
  appointment: AppointmentRow;
  locationName: string;
  timezone: string;
  clientFirstName?: string | null;
  /** Recipient phone in raw form (normalised at send time). */
  clientPhone?: string | null;
  /** Recipient email in raw form (used when the client's preference is email). */
  clientEmail?: string | null;
  /** Effective channel preference: appointment override → client profile preference. */
  communicationPreference?: CommunicationPreference | null;
  serviceNames: string[];
  stylistName?: string | null;
}

/** One `booking.appointment_services` row, as far as message rendering cares. */
interface AppointmentServiceLineRow {
  service_name_snapshot: string | null;
  sequence_no: number | null;
  /** 0110 provenance: `booked` | `post_checkin_add` | `post_checkin_replace`. */
  origin: string | null;
  /** 0110 line status: `cancelled` means taken off the visit after check-in. */
  status: string | null;
}

/**
 * THE SEMANTIC, stated once so every message agrees with it.
 *
 * A confirmation or a reminder tells the client WHAT THEY ARE BOOKED FOR. That
 * is the live booked line set:
 *
 *   origin = 'booked'        — what the booking says, at whatever generation the
 *                              booking editor has most recently left it. A
 *                              pre-check-in change (Service A swapped for
 *                              Service B) therefore corrects every message not
 *                              yet rendered, which is the defect this fixes.
 *   status <> 'cancelled'    — minus anything taken off the visit.
 *
 * Deliberately NOT the performed set. A toner added during the appointment is
 * `origin = 'post_checkin_add'` and must never appear in a "your appointment is
 * tomorrow for …" message: by then the client is in the chair, and rewriting a
 * booking reminder to describe work that happened during the visit would make
 * the message untrue about the thing it is actually describing.
 *
 * `appointments.metadata.service_names` is the creation-time copy. It is never
 * updated, so it is only a last-resort fallback for a row with no line records
 * at all — and it is still what an ALREADY-SENT message shows, because sent
 * copy lives in `comms.message_logs` and is never rewritten.
 */
function bookedServiceNames(
  lines: AppointmentServiceLineRow[],
  metadata: Record<string, unknown>,
): string[] {
  const booked = lines
    .filter((line) => (line.origin ?? 'booked') === 'booked' && line.status !== 'cancelled')
    .map((line) => line.service_name_snapshot)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  if (booked.length > 0) return booked;

  return Array.isArray(metadata['service_names'])
    ? (metadata['service_names'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
}

/** Appointment statuses for which reminders/confirmations must never go out. */
export const INACTIVE_APPOINTMENT_STATUSES = new Set(['cancelled', 'no_show']);

/**
 * Load everything needed to schedule or render a booking notification for one
 * appointment. Cross-schema embeds are avoided (PostgREST cannot embed `core.*`
 * from a `booking.*` query) — rows are fetched separately and stitched, matching
 * the rest of the codebase. Returns null when the appointment no longer exists.
 */
export async function loadAppointmentContext(
  admin: SupabaseClient,
  appointmentId: string,
): Promise<AppointmentNotificationContext | null> {
  const { data: appointment, error } = await admin
    .schema('booking')
    .from('appointments')
    .select(
      'id,business_id,location_id,client_profile_id,status,scheduled_start_at,communication_preference,metadata',
    )
    .eq('id', appointmentId)
    .maybeSingle<AppointmentRow>();

  if (error) throw new Error(`load appointment failed: ${error.message}`);
  if (!appointment) return null;

  const [location, client, lines] = await Promise.all([
    admin
      .schema('core')
      .from('locations')
      .select('name,timezone')
      .eq('id', appointment.location_id)
      .maybeSingle<{ name: string; timezone: string }>(),
    appointment.client_profile_id
      ? admin
          .schema('core')
          .from('client_profiles')
          .select('first_name,phone,email,communication_preference')
          .eq('id', appointment.client_profile_id)
          .maybeSingle<{
            first_name: string;
            phone: string | null;
            email: string | null;
            communication_preference: string | null;
          }>()
      : Promise.resolve({ data: null, error: null }),
    // THE SERVICES THE CLIENT IS CURRENTLY BOOKED FOR — see the note on
    // `serviceNames` for exactly what that means and why.
    admin
      .schema('booking')
      .from('appointment_services')
      .select('service_name_snapshot,sequence_no,origin,status')
      .eq('appointment_id', appointment.id)
      .order('sequence_no', { ascending: true })
      .returns<AppointmentServiceLineRow[]>(),
  ]);

  if (location.error) throw new Error(`load location failed: ${location.error.message}`);
  if (client.error) throw new Error(`load client failed: ${client.error.message}`);
  if (lines.error) throw new Error(`load appointment services failed: ${lines.error.message}`);

  const metadata = appointment.metadata ?? {};
  const serviceNames = bookedServiceNames(lines.data ?? [], metadata);

  const preference =
    (appointment.communication_preference as CommunicationPreference | null) ??
    (client.data?.communication_preference as CommunicationPreference | null) ??
    null;

  return {
    appointment,
    locationName: location.data?.name ?? 'our salon',
    timezone: location.data?.timezone ?? 'Europe/London',
    clientFirstName: client.data?.first_name ?? null,
    clientPhone: client.data?.phone ?? null,
    clientEmail: client.data?.email ?? null,
    communicationPreference: preference,
    serviceNames,
    stylistName: typeof metadata['stylist_name'] === 'string' ? (metadata['stylist_name'] as string) : null,
  };
}
