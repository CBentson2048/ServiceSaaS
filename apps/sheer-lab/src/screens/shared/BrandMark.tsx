import type React from 'react';
import { Image } from 'react-native';
import type { ImageStyle, StyleProp } from 'react-native';

import { labTheme } from '../../theme/labTheme';
import qlooqoLabMark from '../../assets/brand/qlooqo-lab-mark.png';

interface BrandMarkProps {
  /** Rendered width/height in points. */
  size?: number;
  /** Corner radius; defaults to ~22% of size. Pass `size / 2` for a full circle. */
  radius?: number;
  style?: StyleProp<ImageStyle>;
}

/**
 * Shared QLOOQO Lab brand mark — the app icon rendered as a rounded image.
 * Replaces the hand-drawn placeholder marks that were previously duplicated per screen.
 */
export function BrandMark({ size = 30, radius, style }: BrandMarkProps): React.JSX.Element {
  return (
    <Image
      source={qlooqoLabMark}
      accessibilityRole="image"
      accessibilityLabel="QLOOQO Lab"
      resizeMode="cover"
      style={[
        {
          width: size,
          height: size,
          borderRadius: radius ?? Math.round(size * 0.22),
          backgroundColor: labTheme.colors.surface,
        },
        style,
      ]}
    />
  );
}
