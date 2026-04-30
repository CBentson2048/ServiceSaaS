import { formatDate } from '@sheer/utils';
import { AppText } from '../design';

export function TopBar() {
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
        <AppText as="div" variant="caption" className="!text-white/55 md:hidden">
          {formatDate(new Date(), { dateStyle: 'medium' })}
        </AppText>

        <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary bg-primary-deepest">
          <AppText variant="micro" weight="medium" className="!text-primary">
            LO
          </AppText>
        </div>
      </div>
    </header>
  );
}
