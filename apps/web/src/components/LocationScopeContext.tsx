import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthLocation } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';

/**
 * Sentinel for "show every accessible location". Kept as the literal `'all'`
 * because location-aware pages already speak this dialect to the API
 * (`locationId !== 'all' ? locationId : undefined`), so feeding the scope value
 * straight through Just Works.
 */
export const ALL_LOCATIONS = 'all';

interface LocationScopeValue {
  locations: AuthLocation[];
  /** Either {@link ALL_LOCATIONS} or a concrete location id. */
  selectedLocationId: string;
  setSelectedLocationId: (id: string) => void;
  /** True when the "All" option is active. */
  isAllLocations: boolean;
  /** First accessible location id (the fallback target for single-location views). */
  firstLocationId: string;
  /**
   * Concrete location for views that cannot render "All" (the per-day calendar
   * board, the weekly rota): the selection, or the first location when "All".
   */
  resolvedLocationId: string;
}

const LocationScopeContext = createContext<LocationScopeValue | null>(null);

/**
 * Shares the active salon location across the dashboard chrome. The picker
 * lives at the bottom of the nav sidebar while location-aware pages (the
 * dashboard, performance, commission, the Appointment Book, …) read the
 * selection from here, so every page's main content stays in sync without
 * owning a selector of its own. The selection defaults to {@link ALL_LOCATIONS}.
 */
export function LocationScopeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const locations = useMemo(() => user?.locations ?? [], [user?.locations]);
  const [selectedLocationId, setSelectedLocationId] = useState<string>(ALL_LOCATIONS);

  // Keep the selection valid if the available locations change (e.g. on a user
  // / business switch). "All" is always a legal selection; an unknown concrete
  // id falls back to "All" rather than silently sticking.
  useEffect(() => {
    if (locations.length === 0) return;
    setSelectedLocationId((current) =>
      current === ALL_LOCATIONS || locations.some((location) => location.id === current)
        ? current
        : ALL_LOCATIONS,
    );
  }, [locations]);

  const value = useMemo<LocationScopeValue>(() => {
    const firstLocationId = locations[0]?.id ?? '';
    const isAllLocations = selectedLocationId === ALL_LOCATIONS;
    return {
      locations,
      selectedLocationId,
      setSelectedLocationId,
      isAllLocations,
      firstLocationId,
      resolvedLocationId: isAllLocations ? firstLocationId : selectedLocationId,
    };
  }, [locations, selectedLocationId]);

  return <LocationScopeContext.Provider value={value}>{children}</LocationScopeContext.Provider>;
}

export function useLocationScope(): LocationScopeValue {
  const value = useContext(LocationScopeContext);
  if (!value) throw new Error('useLocationScope must be used within a LocationScopeProvider');
  return value;
}
