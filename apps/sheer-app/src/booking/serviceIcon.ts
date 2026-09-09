import type { Ionicons } from '@expo/vector-icons';
import type { PublicBookingServiceSummary } from '@sheer/domain';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * Service -> icon, by keyword match on name + category.
 *
 * THE ONE PLACE this mapping is defined. `booking/services.tsx` and
 * `booking/review.tsx` each declared their own copy of this table as
 * `SERVICE_EMOJI`, rendering 🎨 ✂️ 💨 ✨ 🧴 🌀 💇 🪒 💅 as plain `<Text>` —
 * literal emoji in the client-facing booking flow, and two places that could
 * (and did, trivially) drift on which keyword mapped to which glyph.
 *
 * Ionicons instead of emoji: a vector icon renders identically across iOS,
 * Android and every OS font-substitution table, sits on the brand palette
 * instead of its own fixed colour, and matches every other icon in the app.
 */
const SERVICE_ICONS: { keywords: string[]; icon: IoniconName }[] = [
  { keywords: ['colour', 'color', 'tint', 'highlight', 'balayage', 'toner'], icon: 'color-palette-outline' },
  { keywords: ['cut', 'style', 'trim', 'fringe'], icon: 'cut-outline' },
  { keywords: ['blow', 'dry', 'wave', 'curl'], icon: 'sync-outline' },
  { keywords: ['treatment', 'condition', 'mask', 'keratin', 'olaplex'], icon: 'sparkles-outline' },
  { keywords: ['wash', 'shampoo'], icon: 'water-outline' },
  { keywords: ['perm', 'relax', 'smooth'], icon: 'sync-outline' },
  { keywords: ['braid', 'updo', 'extension'], icon: 'woman-outline' },
  { keywords: ['beard', 'shave', 'barber'], icon: 'man-outline' },
  { keywords: ['nail', 'manicure', 'pedicure'], icon: 'hand-left-outline' },
];

/** Fallback for a service that matches no keyword above. */
const DEFAULT_SERVICE_ICON: IoniconName = 'cut-outline';

export function serviceIcon(service: PublicBookingServiceSummary): IoniconName {
  const haystack = `${service.name} ${service.category ?? ''}`.toLowerCase();
  for (const entry of SERVICE_ICONS) {
    if (entry.keywords.some((keyword) => haystack.includes(keyword))) return entry.icon;
  }
  return DEFAULT_SERVICE_ICON;
}
