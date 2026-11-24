import { NavLink } from 'react-router-dom';
import type { Permission } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { useAuth } from '../../auth/AuthProvider';

const TABS: Array<{
  key: string;
  label: string;
  suffix: string;
  /** Tab hidden without this permission (the route guard stays authoritative). */
  permission: Permission | null;
}> = [
  { key: 'overview', label: 'Overview & billing', suffix: '', permission: null },
  {
    key: 'record',
    label: 'Record & reporting',
    suffix: '/record-settings',
    permission: 'settings.location.manage',
  },
  { key: 'booking', label: 'Booking', suffix: '/booking-settings', permission: 'settings.booking.manage' },
];

/**
 * One navigation for everything a location's settings are spread across.
 * Rendered under the header of each location settings surface, so the three
 * pages read as tabs of a single hub (Overview & billing · Record & reporting
 * · Booking) instead of separately-discovered screens.
 */
export function LocationSettingsTabs({ locationId }: { locationId: string }) {
  const { user } = useAuth();
  const visible = TABS.filter(
    (tab) => !tab.permission || (user && userHasPermission(user, tab.permission)),
  );
  if (visible.length < 2) return null;

  return (
    <nav
      aria-label="Location settings sections"
      className="mb-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-pill border border-border bg-surface-alt/60 p-1"
    >
      {visible.map((tab) => (
        <NavLink
          key={tab.key}
          to={`/locations/${locationId}${tab.suffix}`}
          end
          className={({ isActive }) =>
            `whitespace-nowrap rounded-pill px-4 py-1.5 text-[13px] font-medium transition ${
              isActive
                ? 'bg-surface text-text-primary shadow-card'
                : 'text-text-secondary hover:text-text-primary'
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
