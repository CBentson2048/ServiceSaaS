import type { SheerLabAnalyticsRange } from '@sheer/domain';

import { sheerApiClient } from '../../lib/api/client';
import type { LabPeriodWindow } from '../analytics/period';

export async function listTodaysLabAppointments(locationId?: string) {
  return sheerApiClient.labAppointments.today(locationId);
}

export async function listTodaysLabAppointmentsForSession(sessionId: string) {
  return sheerApiClient.labAppointments.todayForSession(sessionId);
}

/**
 * Formula-history feed for the active Lab session, scoped to its own chair, over
 * a preset range (today / week / month) or an explicit custom from/to window.
 */
export async function listLabAppointmentsForSession(
  sessionId: string,
  range: SheerLabAnalyticsRange = 'today',
  customWindow?: LabPeriodWindow,
) {
  return sheerApiClient.labAppointments.appointmentsForSession(sessionId, {
    range,
    from: customWindow?.from,
    to: customWindow?.to,
  });
}

export async function getLabAppointmentForSession(sessionId: string, appointmentId: string) {
  return sheerApiClient.labAppointments.detailForSession(sessionId, appointmentId);
}
