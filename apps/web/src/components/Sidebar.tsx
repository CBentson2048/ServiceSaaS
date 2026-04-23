import { NavLink } from 'react-router-dom';
import { cn } from '@sheer/utils';

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
    <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
      <div className="px-6 py-5">
        <div className="text-lg font-semibold tracking-tight text-slate-900">Sheer</div>
        <div className="text-xs text-slate-500">Operations</div>
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
                    'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-slate-200 p-4 text-xs text-slate-400">v0.1.0</div>
    </aside>
  );
}
