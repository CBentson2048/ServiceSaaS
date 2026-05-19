import { sheerApiClient } from '../../lib/api/client';

export async function listTodaysLabAppointments(locationId?: string) {
  return sheerApiClient.labAppointments.today(locationId);
}
