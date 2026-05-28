import { NavLink } from 'react-router-dom';
import type { UserRole } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { useAuth } from '../auth/AuthProvider';
import { AppText } from '../design';

interface NavEntry {
  to: string;
  label: string;
  end?: boolean;
  allowedRoles?: UserRole[];
}

const NAV: NavEntry[] = [
  { to: '/dashboard', label: 'Dashboard', end: true },
  { to: '/bookings', label: 'Bookings' },
  { to: '/crm', label: 'CRM' },
  { to: '/rota', label: 'Rota' },
  { to: '/inventory', label: 'Inventory', allowedRoles: ['owner', 'manager'] },
  { to: '/sheer-lab', label: 'Sheer Lab' },
  { to: '/commission', label: 'Commission' },
  { to: '/profile', label: 'Profile' },
  { to: '/team', label: 'Team', allowedRoles: ['owner'] },
  { to: '/locations', label: 'Locations', allowedRoles: ['owner', 'manager'] },
  { to: '/settings/booking', label: 'Booking settings', allowedRoles: ['owner'] },
];

export function Sidebar() {
  const { user } = useAuth();
  const role = user?.role;
  const visible = NAV.filter(
    (entry) => !entry.allowedRoles || (role && entry.allowedRoles.includes(role)),
  );
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-surface-ink-deep text-text-on-primary md:flex">
      <div className="px-6 py-5">
        <AppText
          as="div"
          variant="subtitle"
          weight="medium"
          tone="onPrimary"
          className="tracking-[0.2em] !text-white"
        >
          SH<span className="text-primary">EE</span>R
        </AppText>
        <AppText as="div" variant="micro" uppercase className="mt-1 !text-white/50">
          Operations
        </AppText>
      </div>

      <nav className="flex-1 px-3 py-2">
        <ul className="space-y-1">
          {visible.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'block rounded-input-lg px-3 py-2 text-[14px] font-medium transition-colors',
                    isActive
                      ? 'bg-white/10 text-text-on-primary'
                      : 'text-white/60 hover:bg-white/5 hover:text-text-on-primary',
                  )
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-white/10 px-4 py-3">
        <AppText variant="micro" uppercase className="!text-white/50">
          v0.1.0
        </AppText>
      </div>
    </aside>
  );
}
