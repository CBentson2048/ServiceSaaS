import { useWindowDimensions } from 'react-native';

import { resolveLayout, type LabLayout } from './theme';

/**
 * Responsive layout for the current viewport.
 *
 * `useWindowDimensions` re-renders on rotation, so the returned mode follows
 * the iPad's orientation without any listener wiring in the screen.
 */
export function useLabLayout(): LabLayout {
  const { width } = useWindowDimensions();
  return resolveLayout(width);
}
