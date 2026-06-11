import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '@sheer/utils';

interface ServiceTab {
  to: string;
  label: string;
  // `end` keeps the Services tab active only on the exact path, so the
  // nested /services/categories route does not also highlight it.
  end?: boolean;
}

const TABS: ServiceTab[] = [
  { to: '/services', label: 'Services', end: true },
  { to: '/services/categories', label: 'Service categories' },
];

export function ServiceManagementPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Service management</h1>
      </header>

      <nav className="mb-6 flex gap-6 border-b border-border" aria-label="Service management sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                '-mb-px rounded-sm border-b-2 pb-2.5 pt-1 text-[14px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                isActive
                  ? 'border-primary-deep text-primary-deep'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
