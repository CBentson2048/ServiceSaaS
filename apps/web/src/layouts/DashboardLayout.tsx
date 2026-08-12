import { Outlet } from 'react-router-dom';
import { QuickActionBar } from '../components/QuickActionBar';
import { Sidebar } from '../components/Sidebar';
import { TopBar } from '../components/TopBar';
import { LocationScopeProvider } from '../components/LocationScopeContext';

export function DashboardLayout() {
  return (
    <LocationScopeProvider>
      <div className="flex h-full min-h-screen bg-bg text-text-primary">
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TopBar />
          {/* Week 5: persistent front-desk quick actions — pinned between the
              top bar and the page so they survive every navigation/scroll. */}
          <QuickActionBar />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </LocationScopeProvider>
  );
}
