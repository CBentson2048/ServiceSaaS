import type { DashboardRange } from '../components/dashboard/RangeTabs';
import { dashboardSnapshotMock, type DashboardSnapshot } from '../data/dashboardSnapshot';

export interface UseDashboardSnapshotResult {
  data: DashboardSnapshot;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Returns the owner-dashboard snapshot for a given date range.
 *
 * Currently backed by an in-memory mock. When the analytics API ships, swap
 * the body for a real fetch (e.g. `useQuery`) - the `DashboardSnapshot`
 * shape is the contract, so callers will not need to change.
 */
export function useDashboardSnapshot(_range: DashboardRange): UseDashboardSnapshotResult {
  return {
    data: dashboardSnapshotMock,
    isLoading: false,
    error: null,
  };
}
