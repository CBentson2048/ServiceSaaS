import type React from 'react';
import { Image } from 'react-native';
import type { ImageStyle, StyleProp } from 'react-native';

import qlabWordmark from '../../assets/brand/qlab-wordmark.png';

/** Width / height of the trimmed wordmark artwork. */
const WORDMARK_ASPECT = 994 / 459;

interface BrandWordmarkProps {
  /** Rendered height in points; width follows the artwork's aspect ratio. */
  height?: number;
  style?: StyleProp<ImageStyle>;
}

/**
 * Shared QLAB wordmark, pre-brightened for the dark canvas. Replaces the
 * "QLOOQO LAB" text wordmark that sat next to `BrandMark` in brand headers.
 */
export function BrandWordmark({ height = 20, style }: BrandWordmarkProps): React.JSX.Element {
  return (
    <Image
      source={qlabWordmark}
      accessibilityRole="image"
      accessibilityLabel="QLOOQO Lab"
      resizeMode="contain"
      style={[{ height, width: Math.round(height * WORDMARK_ASPECT) }, style]}
    />
  );
}
