import type { ReactElement, SVGProps } from 'react';
import { NavLink } from 'react-router-dom';
import type { Permission } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { useAuth } from '../auth/AuthProvider';
import { openGlobalClientSearch } from './GlobalSearch';

/**
 * Week 5 quick-action toolbar: one-tap access to the five actions front-desk
 * staff use all day — Till, Client Search, New Appointment, End of Day and
 * Stock. Mounted in the dashboard layout between the top bar and the page, so
 * it is reachable from every main staff screen and never scrolls away. Each
 * action is hidden when the signed-in user lacks its permission; on small
 * screens (where the sidebar is hidden entirely) the bar doubles as the app's
 * only navigation, with labels collapsing to icons.
 */
export function QuickActionBar() {
  const { user } = useAuth();
  if (!user) return null;

  const can = (permission: Permission) => userHasPermission(user, permission);
  const actions: Array<{
    key: string;
    label: string;
    icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
    permission: Permission;
    to?: string;
    onClick?: () => void;
  }> = [
    // Checkout lives inside the Appointment Book (per-appointment "Check out"),
    // so Till lands there — the product decision recorded in the Week 5 plan.
    { key: 'till', label: 'Till', icon: BanknoteIcon, permission: 'bookings.manage', to: '/bookings' },
    {
      key: 'client-search',
      label: 'Client Search',
      icon: SearchIcon,
      permission: 'crm.view',
      onClick: openGlobalClientSearch,
    },
    {
      key: 'new-appointment',
      label: 'New Appointment',
      icon: CalendarPlusIcon,
      permission: 'bookings.manage',
      to: '/bookings/new',
    },
    { key: 'end-of-day', label: 'End of Day', icon: CashDrawerIcon, permission: 'eod.manage', to: '/end-of-day' },
    { key: 'stock', label: 'Stock', icon: BoxIcon, permission: 'inventory.manage', to: '/inventory' },
  ];

  const visible = actions.filter((action) => can(action.permission));
  if (visible.length === 0) return null;

  const baseClass =
    'flex shrink-0 items-center gap-2 rounded-pill px-3.5 py-1.5 text-[13px] font-medium transition-colors';

  return (
    <nav
      aria-label="Quick actions"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface-alt/50 px-3 py-2"
    >
      {visible.map((action) => {
        const Icon = action.icon;
        const content = (
          <>
            <Icon className="h-[16px] w-[16px] shrink-0" aria-hidden />
            <span className="hidden whitespace-nowrap sm:block">{action.label}</span>
          </>
        );
        if (action.to) {
          return (
            <NavLink
              key={action.key}
              to={action.to}
              end
              title={action.label}
              className={({ isActive }) =>
                cn(
                  baseClass,
                  isActive
                    ? 'bg-primary text-text-on-primary'
                    : 'text-text-secondary hover:bg-surface hover:text-text-primary',
                )
              }
            >
              {content}
            </NavLink>
          );
        }
        return (
          <button
            key={action.key}
            type="button"
            onClick={action.onClick}
            title={action.label}
            className={cn(baseClass, 'text-text-secondary hover:bg-surface hover:text-text-primary')}
          >
            {content}
          </button>
        );
      })}
    </nav>
  );
}

// Icons follow the house style (20-viewBox stroked outlines, 1.6 weight).
function Svg({ children, ...props }: SVGProps<SVGSVGElement>) {
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

function BanknoteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="5.5" width="15" height="9" rx="1.5" />
      <circle cx="10" cy="10" r="2.2" />
      <path d="M5 8v4M15 8v4" />
    </Svg>
  );
}

function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.5 13.5 3.5 3.5" />
    </Svg>
  );
}

function CalendarPlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 2v4M13 2v4M10 10.5v4M8 12.5h4" />
    </Svg>
  );
}

function CashDrawerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3" y="8.5" width="14" height="8" rx="1.5" />
      <path d="M3 12h5.5m3 0H17M8.5 12a1.5 1.5 0 0 0 3 0" />
      <path d="M5.5 8.5v-3A1.5 1.5 0 0 1 7 4h6a1.5 1.5 0 0 1 1.5 1.5v3" />
    </Svg>
  );
}

function BoxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m10 2.8 6.5 3.2v8L10 17.2 3.5 14v-8L10 2.8Z" />
      <path d="M3.5 6 10 9.2 16.5 6M10 9.2v8" />
    </Svg>
  );
}
