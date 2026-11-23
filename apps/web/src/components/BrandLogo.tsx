import { cn } from '@sheer/utils';

/**
 * Service SaaS brand mark, backed by the SVG assets in `public/`.
 *
 *  - `color` — full purple gradient wordmark, for light surfaces (auth cards).
 *  - `white` — reversed solid-white wordmark, for dark surfaces (sidebar, top bar).
 *  - `mark`  — square rounded tile with the infinity icon, for tight/collapsed spots.
 *
 * Size the logo with a height utility on `className` (e.g. `h-6`); the width
 * follows the artwork's aspect ratio automatically.
 */
type BrandLogoVariant = 'color' | 'white' | 'mark';

const LOGO_SRC: Record<BrandLogoVariant, string> = {
  color: '/service-saas-logo.svg',
  white: '/service-saas-logo-white.svg',
  mark: '/favicon.svg',
};

interface BrandLogoProps {
  variant?: BrandLogoVariant;
  className?: string;
}

export function BrandLogo({ variant = 'color', className }: BrandLogoProps) {
  return (
    <img
      src={LOGO_SRC[variant]}
      alt="Service SaaS"
      draggable={false}
      className={cn('block w-auto select-none', className)}
    />
  );
}
