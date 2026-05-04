import { formatDate } from '@sheer/utils';
import { AppText } from '../design';
import { useAuth } from '../auth/AuthProvider';

export function TopBar() {
  const { signOut, user } = useAuth();
  const initials =
    user?.profile.fullName
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'SH';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between bg-surface-ink px-6 text-text-on-primary">
      <AppText
        as="div"
        variant="body"
        weight="medium"
        tone="onPrimary"
        className="tracking-[0.25em] !text-white md:hidden"
      >
        SH<span className="text-primary">EE</span>R
      </AppText>

      <AppText as="div" variant="caption" className="hidden !text-white/55 md:block">
        {formatDate(new Date(), { dateStyle: 'full' })}
      </AppText>

      <div className="flex items-center gap-4">
        <div className="hidden text-right md:block">
          <AppText as="div" variant="micro" uppercase className="!text-white/45">
            {user?.role === 'owner' ? 'Full business access' : 'Location scoped'}
          </AppText>
          <AppText as="div" variant="caption" className="!text-white/80">
            {user?.profile.fullName}
          </AppText>
        </div>
        <AppText as="div" variant="caption" className="!text-white/55 md:hidden">
          {formatDate(new Date(), { dateStyle: 'medium' })}
        </AppText>

        <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary bg-primary-deepest">
          <AppText variant="micro" weight="medium" className="!text-primary">
            {initials}
          </AppText>
        </div>
        <button
          className="rounded-input border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/75 transition hover:bg-white/10 hover:text-white"
          type="button"
          onClick={() => void signOut()}
        >
          Logout
        </button>
      </div>
    </header>
  );
}
