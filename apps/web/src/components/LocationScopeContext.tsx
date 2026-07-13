import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
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

/**
 * Two-way binds a `/locations/:id`-style page to the sidebar location picker so
 * the two never drift apart. When the URL changes (e.g. following a link), the
 * picker is updated to match; when the picker changes, the page navigates to the
 * same route for the newly selected location — letting a multi-location manager
 * flip between their salons' settings straight from the sidebar.
 *
 * `pathSuffix` is appended after the location id (e.g. `'/record-settings'`).
 * Only concrete, in-scope locations are honoured — the "All" sentinel and ids
 * the user can't access are ignored so we never navigate somewhere forbidden.
 */
export function useLocationRouteSync(routeLocationId: string | undefined, pathSuffix = ''): void {
  const { selectedLocationId, setSelectedLocationId, locations } = useLocationScope();
  const navigate = useNavigate();
  // Seed with sentinels so the very first run reflects the landing URL into the
  // picker (both refs start "changed").
  const prevRoute = useRef<string | undefined>(undefined);
  const prevSelected = useRef<string | undefined>(undefined);

  useEffect(() => {
    const routeChanged = routeLocationId !== prevRoute.current;
    const selectedChanged = selectedLocationId !== prevSelected.current;
    prevRoute.current = routeLocationId;
    prevSelected.current = selectedLocationId;

    const known = (id: string) => locations.some((location) => location.id === id);

    // The URL is the source of truth when it moves — mirror it into the picker.
    if (routeChanged && routeLocationId && known(routeLocationId)) {
      if (selectedLocationId !== routeLocationId) setSelectedLocationId(routeLocationId);
      return;
    }
    // Otherwise the picker leads — follow it in the URL.
    if (
      selectedChanged &&
      selectedLocationId !== ALL_LOCATIONS &&
      known(selectedLocationId) &&
      routeLocationId !== selectedLocationId
    ) {
      navigate(`/locations/${selectedLocationId}${pathSuffix}`, { replace: true });
    }
  }, [routeLocationId, selectedLocationId, locations, pathSuffix, navigate, setSelectedLocationId]);
}
