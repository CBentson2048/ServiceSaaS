import type { SheerLabAnalyticsRange, SheerLabAnalyticsResponse } from '@sheer/domain';

import { appConfig } from '../../config/appConfig';

/**
 * Colour-bar analytics for the current Lab station, scoped to the session's
 * location. The backend gates this to owner/manager sessions and answers 403
 * for stylists — we surface that as `null` so the dashboard can simply hide the
 * Manager Insights panel rather than treating it as an error.
 */
export async function getLabAnalyticsSummaryForSession(
  sessionId: string,
  range: SheerLabAnalyticsRange = 'today',
): Promise<SheerLabAnalyticsResponse | null> {
  const response = await fetch(
    `${appConfig.apiBaseUrl}/lab/analytics/session/${encodeURIComponent(sessionId)}/summary?range=${encodeURIComponent(range)}`,
  );

  if (response.status === 403) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Could not load lab analytics (${response.status})`);
  }

  return (await response.json()) as SheerLabAnalyticsResponse;
}
