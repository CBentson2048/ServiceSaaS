import { useState, type ReactElement, type ReactNode, type SVGProps } from 'react';
import { NavLink } from 'react-router-dom';
import type { UserRole } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { useAuth } from '../auth/AuthProvider';
import { ALL_LOCATIONS, useLocationScope } from './LocationScopeContext';
import { AppText } from '../design';

type IconComponent = (props: SVGProps<SVGSVGElement>) => ReactElement;

interface NavEntry {
  to: string;
  label: string;
  icon: IconComponent;
  end?: boolean;
  allowedRoles?: UserRole[];
}

const NAV: NavEntry[] = [
  { to: '/dashboard', label: 'Dashboard', icon: DashboardIcon, end: true },
  { to: '/bookings', label: 'Appointment Book', icon: CalendarIcon, end: true },
  { to: '/bookings/new', label: 'New booking', icon: PlusIcon, allowedRoles: ['owner', 'manager'] },
  { to: '/services', label: 'Service management', icon: ScissorsIcon, allowedRoles: ['owner', 'manager'] },
  { to: '/crm', label: 'Client Hub', icon: CrmIcon },
  { to: '/rota', label: 'Rota', icon: ClockIcon },
  { to: '/inventory', label: 'Product management', icon: BoxIcon, allowedRoles: ['owner', 'manager'] },
  { to: '/sheer-lab', label: 'Sheer Lab', icon: BeakerIcon },
  { to: '/performance', label: 'Performance', icon: ChartIcon, allowedRoles: ['owner', 'manager'] },
  { to: '/commission', label: 'Commission', icon: PercentIcon },
  { to: '/team', label: 'Team', icon: TeamIcon, allowedRoles: ['owner'] },
  { to: '/locations', label: 'Locations', icon: PinIcon, allowedRoles: ['owner', 'manager'] },
  { to: '/settings/booking', label: 'Booking settings', icon: GearIcon, allowedRoles: ['owner'] },
];

const STORAGE_KEY = 'sheer.web.sidebarCollapsed';

export function Sidebar() {
  const { user } = useAuth();
  const role = user?.role;
  const visible = NAV.filter(
    (entry) => !entry.allowedRoles || (role && entry.allowedRoles.includes(role)),
  );

  // Collapsed state is a per-user preference, persisted across sessions.
  // Defaults to collapsed; only an explicit '0' (user expanded it) keeps it open.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  });
  const toggleCollapsed = () =>
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Best-effort — ignore storage failures (private mode, quota, etc.).
      }
      return next;
    });

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col bg-surface-ink-deep text-text-on-primary transition-[width] duration-200 md:flex',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* Brand + collapse toggle. */}
      <div
        className={cn(
          'flex py-5',
          collapsed ? 'flex-col items-center gap-3 px-2' : 'items-center justify-between px-5',
        )}
      >
        {collapsed ? (
          <AppText
            as="div"
            variant="subtitle"
            weight="medium"
            tone="onPrimary"
            className="!text-white"
          >
            S<span className="text-primary">H</span>
          </AppText>
        ) : (
          <div>
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
        )}

        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {collapsed ? <ChevronRightIcon className="h-4 w-4" /> : <ChevronLeftIcon className="h-4 w-4" />}
        </button>
      </div>

      <nav className={cn('flex-1 py-2', collapsed ? 'px-2' : 'px-3')}>
        <ul className="space-y-1">
          {visible.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  title={collapsed ? item.label : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center rounded-input-lg py-2 text-[14px] font-medium transition-colors',
                      collapsed ? 'justify-center px-0' : 'gap-3 px-3',
                      isActive
                        ? 'bg-white/10 text-text-on-primary'
                        : 'text-white/60 hover:bg-white/5 hover:text-text-on-primary',
                    )
                  }
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  {collapsed ? null : <span className="truncate">{item.label}</span>}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Location picker, pinned to the bottom of the sidebar. */}
      <LocationPicker collapsed={collapsed} onExpand={() => setCollapsed(false)} />

      {collapsed ? null : (
        <div className="border-t border-white/10 px-4 py-3">
          <AppText variant="micro" uppercase className="!text-white/50">
            v0.1.0
          </AppText>
        </div>
      )}
    </aside>
  );
}

function LocationPicker({ collapsed, onExpand }: { collapsed: boolean; onExpand: () => void }) {
  const { locations, selectedLocationId, setSelectedLocationId, isAllLocations } = useLocationScope();
  if (locations.length === 0) return null;

  // With a single salon "All" is just that salon, so show its name rather than
  // the abstract label; otherwise reflect the live selection.
  const activeName = isAllLocations
    ? locations.length === 1
      ? locations[0].name
      : 'All locations'
    : locations.find((location) => location.id === selectedLocationId)?.name ?? locations[0]?.name ?? '';

  if (collapsed) {
    return (
      <div className="flex justify-center border-t border-white/10 px-2 py-3">
        <button
          type="button"
          onClick={onExpand}
          title={`Location: ${activeName}`}
          aria-label={`Location: ${activeName}. Expand the sidebar to change it.`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-input-lg border border-white/15 text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <PinIcon className="h-5 w-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-white/10 px-4 py-3">
      <label className="block">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-white/45">Location</span>
        {locations.length > 1 ? (
          <select
            value={selectedLocationId}
            onChange={(event) => setSelectedLocationId(event.target.value)}
            aria-label="Location"
            className="mt-1.5 h-9 w-full rounded-input-lg border border-white/15 bg-white/5 px-2.5 text-[13px] font-medium text-white outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          >
            <option value={ALL_LOCATIONS} className="text-text-primary">
              All locations
            </option>
            {locations.map((location) => (
              <option key={location.id} value={location.id} className="text-text-primary">
                {location.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="mt-1 truncate text-[13px] font-medium text-white">{activeName || '—'}</p>
        )}
      </label>
    </div>
  );
}

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

function ChevronLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 5 7 10l5 5" />
    </Svg>
  );
}

function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m8 5 5 5-5 5" />
    </Svg>
  );
}

function DashboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </Svg>
  );
}

function CalendarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 2v4M13 2v4" />
    </Svg>
  );
}

function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 2v4M13 2v4M10 11v4M8 13h4" />
    </Svg>
  );
}

function CrmIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="8" cy="9" r="1.8" />
      <path d="M5.5 14a2.7 2.7 0 0 1 5 0" />
      <path d="M12.5 8h2.5M12.5 11h2.5" />
    </Svg>
  );
}

function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 1.5" />
    </Svg>
  );
}

function BoxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5v-7Z" />
      <path d="M3.5 6.5 10 10l6.5-3.5M10 10v7" />
    </Svg>
  );
}

function ScissorsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="14" r="2" />
      <path d="M7.8 7.4 16 14M7.8 12.6 16 6" />
    </Svg>
  );
}

function BeakerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M8 3h4" />
      <path d="M9 3v4.8L5.6 14a1.6 1.6 0 0 0 1.4 2.5h6a1.6 1.6 0 0 0 1.4-2.5L11 7.8V3" />
      <path d="M7.2 12.5h5.6" />
    </Svg>
  );
}

function ChartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3 16.5h14" />
      <path d="M5 16V9M10 16V4M15 16v-5" />
    </Svg>
  );
}

function PercentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 14 14 6" />
      <circle cx="7" cy="7" r="1.4" />
      <circle cx="13" cy="13" r="1.4" />
    </Svg>
  );
}

function TeamIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="7.5" cy="8" r="2.4" />
      <path d="M3.5 15.5a4 4 0 0 1 8 0" />
      <path d="M13 6.2a2.4 2.4 0 0 1 0 4.4M14.5 15.5a4 4 0 0 0-2.2-3.6" />
    </Svg>
  );
}

function PinIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M10 17.5s5.5-4.8 5.5-9a5.5 5.5 0 1 0-11 0c0 4.2 5.5 9 5.5 9Z" />
      <circle cx="10" cy="8.5" r="2" />
    </Svg>
  );
}

function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" />
    </Svg>
  );
}
