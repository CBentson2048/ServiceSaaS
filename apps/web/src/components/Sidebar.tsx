import { NavLink } from 'react-router-dom';
import { cn } from '@sheer/utils';
import { AppText } from '../design';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/bookings', label: 'Bookings' },
  { to: '/crm', label: 'CRM' },
  { to: '/rota', label: 'Rota' },
  { to: '/sheer-lab', label: 'Sheer Lab' },
  { to: '/commission', label: 'Commission' },
];

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-surface-ink-deep text-text-on-primary md:flex">
      <div className="px-6 py-5">
        <AppText
          as="div"
          variant="subtitle"
          weight="medium"
          className="tracking-[0.2em] text-text-on-primary"
        >
          SH<span className="text-primary">EE</span>R
        </AppText>
        <AppText as="div" variant="micro" uppercase className="mt-1 text-white/40">
          Operations
        </AppText>
      </div>

      <nav className="flex-1 px-3 py-2">
        <ul className="space-y-1">
          {NAV.map((item) => (
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
        <AppText variant="micro" uppercase className="text-white/40">
          v0.1.0
        </AppText>
      </div>
    </aside>
  );
}
