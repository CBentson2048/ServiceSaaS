import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthLocation } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';

interface LocationScopeValue {
  locations: AuthLocation[];
  selectedLocationId: string;
  setSelectedLocationId: (id: string) => void;
}

const LocationScopeContext = createContext<LocationScopeValue | null>(null);

/**
 * Shares the active salon location across the dashboard chrome. The picker
 * lives at the bottom of the nav sidebar while location-aware pages (e.g. the
 * Appointment Book) read the selection from here, so both stay in sync without
 * the page owning the selector itself.
 */
export function LocationScopeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const locations = useMemo(() => user?.locations ?? [], [user?.locations]);
  const [selectedLocationId, setSelectedLocationId] = useState(() => locations[0]?.id ?? '');

  // Default to the first location once they load, and keep the selection valid
  // if the available locations change (e.g. on a user / business switch).
  useEffect(() => {
    if (locations.length === 0) return;
    setSelectedLocationId((current) =>
      current && locations.some((location) => location.id === current) ? current : locations[0].id,
    );
  }, [locations]);

  const value = useMemo(
    () => ({ locations, selectedLocationId, setSelectedLocationId }),
    [locations, selectedLocationId],
  );

  return <LocationScopeContext.Provider value={value}>{children}</LocationScopeContext.Provider>;
}

export function useLocationScope(): LocationScopeValue {
  const value = useContext(LocationScopeContext);
  if (!value) throw new Error('useLocationScope must be used within a LocationScopeProvider');
  return value;
}
