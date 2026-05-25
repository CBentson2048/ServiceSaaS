import { sheerApiClient } from '../../lib/api/client';

export async function listTodaysLabAppointments(locationId?: string) {
  return sheerApiClient.labAppointments.today(locationId);
}

export async function listTodaysLabAppointmentsForSession(sessionId: string) {
  return sheerApiClient.labAppointments.todayForSession(sessionId);
}

export async function getLabAppointmentForSession(sessionId: string, appointmentId: string) {
  return sheerApiClient.labAppointments.detailForSession(sessionId, appointmentId);
}
