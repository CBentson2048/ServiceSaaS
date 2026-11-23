import { useEffect, useRef, useState, type ReactNode } from 'react';
import { userHasRole } from '@sheer/domain';
import { formatDate, cn } from '@sheer/utils';
import { useNavigate } from 'react-router-dom';
import { AppText } from '../design';
import { BrandLogo } from './BrandLogo';
import { GlobalSearch } from './GlobalSearch';
import { useAuth } from '../auth/AuthProvider';
import { resolveTimezone } from '../config/timezones';

export function TopBar() {
  const { signOut, user } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // All displayed times honour the user's profile timezone setting.
  const timezone = resolveTimezone(user?.timezone);

  const fullName = user?.profile.fullName ?? 'Service SaaS user';
  const avatarUrl = user?.profile.avatarUrl;
  const initials =
    fullName
      .split(' ')
      .map((part) => part[0])
      .filter(Boolean)
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'SH';
  const roleLabel = user && userHasRole(user, 'owner') ? 'Full business access' : 'Location scoped';

  // Close the dropdown on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="relative z-20 flex h-16 shrink-0 items-center justify-between border-b border-white/10 bg-surface-ink px-4 text-text-on-primary shadow-[0_6px_24px_rgba(32,19,29,0.12)] sm:px-6">
      <BrandLogo variant="white" className="h-5 md:hidden" />

      <NavClock timezone={timezone} variant="desktop" />

      <div className="flex items-center gap-4">
        <GlobalSearch />
        <NavClock timezone={timezone} variant="mobile" />

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Open account menu"
            className={cn(
              'flex items-center gap-2.5 rounded-pill border border-white/10 py-1 pl-1 pr-2.5 transition-colors',
              menuOpen ? 'bg-white/10' : 'hover:bg-white/[0.07]',
            )}
          >
            {/* Avatar: shows the user's image when available, otherwise initials. */}
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={fullName}
                className="h-8 w-8 rounded-full border-2 border-accent object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-accent bg-primary-deepest">
                <AppText variant="micro" weight="medium" className="!text-accent">
                  {initials}
                </AppText>
              </span>
            )}
            <span className="hidden text-left leading-tight md:block">
              <AppText as="span" variant="caption" weight="medium" className="block !text-white/90">
                {fullName}
              </AppText>
              <AppText as="span" variant="micro" uppercase className="block !text-white/45">
                {roleLabel}
              </AppText>
            </span>
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className={cn(
                'hidden h-3 w-3 text-white/50 transition-transform md:block',
                menuOpen && 'rotate-180',
              )}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m3 4.5 3 3 3-3" />
            </svg>
          </button>

          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-card-lg border border-border bg-surface shadow-modal"
            >
              <div className="border-b border-border-divider px-4 py-3">
                <AppText as="div" variant="caption" weight="medium" tone="primary" className="truncate">
                  {fullName}
                </AppText>
                <AppText as="div" variant="micro" tone="secondary" className="truncate">
                  {user?.profile.email}
                </AppText>
              </div>
              <div className="p-1.5">
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    navigate('/profile');
                  }}
                  icon={
                    <path d="M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0 1.5c-3.04 0-5.5 1.79-5.5 4v.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-.5c0-2.21-2.46-4-5.5-4Z" />
                  }
                >
                  Profile
                </MenuItem>
                <MenuItem
                  tone="danger"
                  onClick={() => {
                    setMenuOpen(false);
                    void signOut();
                  }}
                  icon={
                    <path d="M7.5 4.5v-.75A1.25 1.25 0 0 1 8.75 2.5h5A1.25 1.25 0 0 1 15 3.75v12.5a1.25 1.25 0 0 1-1.25 1.25h-5a1.25 1.25 0 0 1-1.25-1.25V15.5M3 10h8.5m0 0L9 7.5m2.5 2.5L9 12.5" />
                  }
                >
                  Logout
                </MenuItem>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * Live clock for the top bar. Shows the current time (HH:MM) alongside the
 * date, rendered in the user's profile timezone and refreshed every second.
 * `desktop` sits in the left corner; `mobile` is a compact variant shown
 * beside the account menu on small screens.
 */
function NavClock({ timezone, variant }: { timezone: string; variant: 'desktop' | 'mobile' }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(now);

  if (variant === 'mobile') {
    return (
      <div className="flex items-baseline gap-1.5 md:hidden">
        <AppText as="span" variant="caption" weight="medium" className="!text-white tabular-nums">
          {time}
        </AppText>
        <AppText as="span" variant="micro" className="!text-white/45">
          {formatDate(now, { dateStyle: 'medium', timeZone: timezone })}
        </AppText>
      </div>
    );
  }

  return (
    <div className="hidden items-baseline gap-2 md:flex">
      <AppText as="span" variant="caption" weight="medium" className="!text-white tabular-nums">
        {time}
      </AppText>
      <AppText as="span" variant="caption" className="!text-white/55">
        {formatDate(now, { dateStyle: 'full', timeZone: timezone })}
      </AppText>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  icon,
  tone = 'default',
}: {
  children: ReactNode;
  onClick: () => void;
  icon: ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-input px-3 py-2 text-left text-[14px] font-medium transition-colors',
        tone === 'danger'
          ? 'text-danger hover:bg-danger-soft'
          : 'text-text-primary hover:bg-surface-alt',
      )}
    >
      <svg
        viewBox="0 0 20 20"
        aria-hidden="true"
        className="h-[18px] w-[18px] shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon}
      </svg>
      {children}
    </button>
  );
}
