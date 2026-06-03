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
  /** Effective channel preference: appointment override → client profile preference. */
  communicationPreference?: CommunicationPreference | null;
  serviceNames: string[];
  stylistName?: string | null;
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

  const [location, client] = await Promise.all([
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
          .select('first_name,phone,communication_preference')
          .eq('id', appointment.client_profile_id)
          .maybeSingle<{ first_name: string; phone: string | null; communication_preference: string | null }>()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (location.error) throw new Error(`load location failed: ${location.error.message}`);
  if (client.error) throw new Error(`load client failed: ${client.error.message}`);

  const metadata = appointment.metadata ?? {};
  const serviceNames = Array.isArray(metadata['service_names'])
    ? (metadata['service_names'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

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
    communicationPreference: preference,
    serviceNames,
    stylistName: typeof metadata['stylist_name'] === 'string' ? (metadata['stylist_name'] as string) : null,
  };
}
