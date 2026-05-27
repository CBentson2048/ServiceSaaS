import { useEffect, useState } from 'react';
import type {
  DashboardInventoryAlertsResponse,
  DashboardKpisResponse,
  DashboardStylistPerformanceResponse,
  DashboardTopServicesResponse,
} from '@sheer/domain';
import type { DashboardRange } from '../components/dashboard/RangeTabs';
import { useAuth } from '../auth/AuthProvider';
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
  locationId: string;
  setLocationId: (locationId: string) => void;
}

export function useDashboardSnapshot(range: DashboardRange): UseDashboardSnapshotResult {
  const { session, user } = useAuth();
  const [data, setData] = useState<DashboardSnapshot>(() => emptyDashboardSnapshot());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [locationId, setLocationId] = useState('all');

  useEffect(() => {
    if (user?.role !== 'owner') setLocationId('all');
  }, [user?.role]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!session?.accessToken || !user || (user.role !== 'owner' && user.role !== 'manager')) {
        setData(emptyDashboardSnapshot());
        return;
      }

      const dateRange = rangeToDates(range);
      const selectedLocationId = user.role === 'owner' && locationId !== 'all' ? locationId : undefined;
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
  }, [locationId, range, session?.accessToken, user]);

  return { data, isLoading, error, locationId, setLocationId };
}

function rangeToDates(range: DashboardRange): { from: string; to: string } {
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
