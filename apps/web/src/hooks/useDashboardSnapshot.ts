import { useEffect, useState } from 'react';
import { userHasRole, userHasAnyRole } from '@sheer/domain';
import type {
  DashboardInventoryAlertsResponse,
  DashboardKpisResponse,
  DashboardStylistPerformanceResponse,
  DashboardTopServicesResponse,
} from '@sheer/domain';
import { resolveCustomWindow, type CustomRange, type DashboardRange } from '../components/dashboard/RangeTabs';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import {
  getDashboardInventoryAlerts,
  getDashboardKpis,
  getDashboardStylistPerformance,
  getDashboardTopServices,
} from '../auth/api';
import { emptyDashboardSnapshot, type DashboardSnapshot } from '../data/dashboardSnapshot';

export interface UseDashboardSnapshotResult {
  data: DashboardSnapshot;
  isLoading: boolean;
  error: Error | null;
}

export function useDashboardSnapshot(
  range: DashboardRange,
  custom?: CustomRange,
): UseDashboardSnapshotResult {
  const { session, user } = useAuth();
  // Location now comes from the shared sidebar scope so the whole dashboard
  // tracks one selector instead of owning its own.
  const { selectedLocationId: locationId } = useLocationScope();
  const [data, setData] = useState<DashboardSnapshot>(() => emptyDashboardSnapshot());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const customFrom = custom?.from;
  const customTo = custom?.to;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!session?.accessToken || !user || !userHasAnyRole(user, ['owner', 'manager'])) {
        setData(emptyDashboardSnapshot());
        return;
      }

      const dateRange =
        range === 'custom' ? resolveCustomWindow({ from: customFrom ?? '', to: customTo ?? '' }) : rangeToDates(range);
      if (!dateRange) {
        // Custom range not fully selected yet — show nothing until both dates are set.
        setData(emptyDashboardSnapshot());
        setIsLoading(false);
        setError(null);
        return;
      }
      const selectedLocationId = userHasRole(user, 'owner') && locationId !== 'all' ? locationId : undefined;
      setIsLoading(true);
      setError(null);

      try {
        const [kpis, topServices, stylistPerformance, inventoryAlerts] = await Promise.all([
          getDashboardKpis(session.accessToken, { ...dateRange, locationId: selectedLocationId }),
          getDashboardTopServices(session.accessToken, { ...dateRange, locationId: selectedLocationId }),
          getDashboardStylistPerformance(session.accessToken, { ...dateRange, locationId: selectedLocationId }),
          getDashboardInventoryAlerts(session.accessToken, { locationId: selectedLocationId }),
        ]);
        if (!cancelled) {
          setData(toDashboardSnapshot(kpis, topServices, stylistPerformance, inventoryAlerts));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Unable to load dashboard KPIs'));
          setData(emptyDashboardSnapshot());
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [locationId, range, customFrom, customTo, session?.accessToken, user]);

  return { data, isLoading, error };
}

function rangeToDates(range: Exclude<DashboardRange, 'custom'>): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  if (range === 'week') {
    const day = from.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    from.setDate(from.getDate() + mondayOffset);
  } else if (range === 'month') {
    from.setDate(1);
  }

  const to = new Date(from);
  if (range === 'today') to.setDate(to.getDate() + 1);
  else if (range === 'week') to.setDate(to.getDate() + 7);
  else to.setMonth(to.getMonth() + 1);

  return { from: from.toISOString(), to: to.toISOString() };
}

function toDashboardSnapshot(
  kpis: DashboardKpisResponse,
  topServices: DashboardTopServicesResponse,
  stylistPerformance: DashboardStylistPerformanceResponse,
  inventoryAlerts: DashboardInventoryAlertsResponse,
): DashboardSnapshot {
  return {
    greeting: {
      ownerName: '',
      locationCount: kpis.locations.length,
      stylistsOnToday: stylistPerformance.stylists.length,
      lastUpdatedLabel: 'just now',
    },
    kpis,
    topServices,
    inventoryAlerts,
    salons: kpis.byLocation,
    stylists: stylistPerformance.stylists,
    diagnostics: [],
  };
}
