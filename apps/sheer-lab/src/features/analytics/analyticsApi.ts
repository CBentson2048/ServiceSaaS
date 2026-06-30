import type { SheerLabAnalyticsRange, SheerLabAnalyticsResponse } from '@sheer/domain';

import { appConfig } from '../../config/appConfig';
import type { LabPeriodWindow } from './period';

/**
 * Colour-bar analytics for the current Lab station, scoped to the session's
 * location. The backend gates this to owner/manager sessions and answers 403
 * for stylists — we surface that as `null` so the dashboard can simply hide the
 * Manager Insights panel rather than treating it as an error.
 *
 * `range` picks a preset window (today / week / month); pass `customWindow` to
 * request an explicit from/to span instead (the backend ignores `range` then).
 */
export async function getLabAnalyticsSummaryForSession(
  sessionId: string,
  range: SheerLabAnalyticsRange = 'today',
  customWindow?: LabPeriodWindow,
): Promise<SheerLabAnalyticsResponse | null> {
  const parts = [`range=${encodeURIComponent(range)}`];
  if (customWindow?.from) parts.push(`from=${encodeURIComponent(customWindow.from)}`);
  if (customWindow?.to) parts.push(`to=${encodeURIComponent(customWindow.to)}`);
  const response = await fetch(
    `${appConfig.apiBaseUrl}/lab/analytics/session/${encodeURIComponent(sessionId)}/summary?${parts.join('&')}`,
  );

  if (response.status === 403) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Could not load lab analytics (${response.status})`);
  }

  return (await response.json()) as SheerLabAnalyticsResponse;
}
