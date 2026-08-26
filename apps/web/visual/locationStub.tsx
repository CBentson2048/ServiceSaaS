/** Visual-harness stub for useLocationScope. Not shipped. */
export function useLocationScope() {
  return {
    selectedLocationId: 'loc-1',
    isAllLocations: false,
    setSelectedLocationId: () => undefined,
    firstLocationId: 'loc-1',
    resolvedLocationId: 'loc-1',
    locations: [
      { id: 'loc-1', name: 'Pinner' },
      { id: 'loc-2', name: 'Kensington' },
    ],
  };
}
export const ALL_LOCATIONS = 'all';
