import { Outlet } from 'react-router-dom';
import { QuickActionBar } from '../components/QuickActionBar';
import { Sidebar } from '../components/Sidebar';
import { TopBar } from '../components/TopBar';
import { LocationScopeProvider } from '../components/LocationScopeContext';
import { ZacChatWidget } from '../components/zac/ZacChatWidget';

export function DashboardLayout() {
  return (
    <LocationScopeProvider>
      <div className="flex h-full min-h-screen bg-[radial-gradient(circle_at_80%_-10%,rgba(217,120,99,0.08),transparent_34%),#F5F0EA] text-text-primary">
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TopBar />
          {/* Week 5: persistent front-desk quick actions — pinned between the
              top bar and the page so they survive every navigation/scroll. */}
          <QuickActionBar />
          {/* `relative` makes <main> the containing block for any absolutely
              positioned descendant that has no positioned parent of its own
              (e.g. an `sr-only` radio). Without it such an element is placed
              against the document, escapes this scroller, and stretches the
              page — a second scrollbar that drags the whole shell up. */}
          <main className="relative min-h-0 flex-1 overflow-y-auto scroll-smooth">
            <Outlet />
          </main>
        </div>
        {/* Floating assistant on every dashboard page; self-gated on zac.access
            and hidden on /zac where the full console lives. */}
        <ZacChatWidget />
      </div>
    </LocationScopeProvider>
  );
}
