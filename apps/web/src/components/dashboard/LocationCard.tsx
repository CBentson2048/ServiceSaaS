import { cn } from '@sheer/utils';
import { AppText, StatusBadge, type StatusTone } from '../../design';

export type LocationStatus = 'on-track-green' | 'on-track-amber' | 'needs-attention';

export interface LocationCardProps {
  name: string;
  street: string;
  stylists: number;
  status: LocationStatus;
  statusLabel: string;
  generated: string;
  target: string;
  generatedPct: number;
  projectedPct: number;
  bookedRemaining: string;
  projectedTotal: string;
  inToday: string;
  aboveThreeX: number;
  needsPush: number;
}

const BORDER: Record<LocationStatus, string> = {
  'on-track-green': 'border-success-fill/40',
  'on-track-amber': 'border-border',
  'needs-attention': 'border-danger-fill/40',
};

const STATUS_TONE: Record<LocationStatus, StatusTone> = {
  'on-track-green': 'success',
  'on-track-amber': 'warning',
  'needs-attention': 'danger',
};

const PROGRESS_FILL: Record<LocationStatus, string> = {
  'on-track-green': 'bg-success-fill',
  'on-track-amber': 'bg-warning-fill',
  'needs-attention': 'bg-danger-fill',
};

const PROJECTED_TONE: Record<LocationStatus, 'success' | 'warning' | 'danger'> = {
  'on-track-green': 'success',
  'on-track-amber': 'warning',
  'needs-attention': 'danger',
};

const BOOKED_TONE: Record<LocationStatus, 'brand' | 'danger'> = {
  'on-track-green': 'brand',
  'on-track-amber': 'brand',
  'needs-attention': 'danger',
};

const NEEDS_PUSH_CLASS: Record<LocationStatus, string> = {
  'on-track-green': 'text-danger-fill',
  'on-track-amber': 'text-warning-fill',
  'needs-attention': 'text-danger-fill',
};

export function LocationCard(props: LocationCardProps) {
  const {
    name,
    street,
    stylists,
    status,
    statusLabel,
    generated,
    target,
    generatedPct,
    projectedPct,
    bookedRemaining,
    projectedTotal,
    inToday,
    aboveThreeX,
    needsPush,
  } = props;

  return (
    <button
      type="button"
      className={cn(
        'group overflow-hidden rounded-card-lg border-[1.5px] bg-surface text-left transition-shadow hover:shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        BORDER[status],
      )}
    >
      <div className="flex items-start justify-between px-4 pb-2 pt-4">
        <div>
          <AppText as="div" variant="body" weight="medium">
            {name}
          </AppText>
          <AppText as="div" variant="micro" tone="muted" className="mt-0.5">
            {street} · {stylists} stylists
          </AppText>
        </div>
        <StatusBadge label={statusLabel} tone={STATUS_TONE[status]} />
      </div>

      <div className="px-4 pb-3">
        <div className="mb-2 flex items-end justify-between">
          <AppText
            as="div"
            weight="medium"
            className="text-[26px] leading-none text-text-primary"
          >
            {generated}
          </AppText>
          <div className="text-right">
            <AppText as="div" variant="caption" tone="muted">
              Target
            </AppText>
            <AppText as="div" variant="caption" weight="medium" className="text-[13px]">
              {target}
            </AppText>
          </div>
        </div>

        <div className="relative mb-2 h-2 overflow-hidden rounded-full bg-border-divider">
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-primary/20"
            style={{ width: `${Math.min(100, projectedPct)}%` }}
          />
          <div
            className={cn('absolute left-0 top-0 h-full rounded-full', PROGRESS_FILL[status])}
            style={{ width: `${Math.min(100, generatedPct)}%` }}
          />
        </div>

        <div className="flex gap-2.5">
          <div className="flex-1 rounded-input-lg bg-surface-alt px-3 py-2">
            <AppText as="div" variant="micro" tone="muted" className="mb-0.5">
              Booked remaining
            </AppText>
            <AppText
              as="div"
              variant="body"
              weight="medium"
              tone={BOOKED_TONE[status]}
            >
              {bookedRemaining}
            </AppText>
          </div>
          <div className="flex-1 rounded-input-lg bg-surface-alt px-3 py-2">
            <AppText as="div" variant="micro" tone="muted" className="mb-0.5">
              Projected total
            </AppText>
            <AppText
              as="div"
              variant="body"
              weight="medium"
              tone={PROJECTED_TONE[status]}
            >
              {projectedTotal}
            </AppText>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 border-t border-border-divider">
        <div className="border-r border-border-divider px-3 py-2.5 text-center">
          <AppText as="div" variant="body" weight="medium">
            {inToday}
          </AppText>
          <AppText as="div" variant="micro" className="mt-0.5 text-text-subtle">
            In today
          </AppText>
        </div>
        <div className="border-r border-border-divider px-3 py-2.5 text-center">
          <AppText as="div" variant="body" weight="medium" tone="success">
            {aboveThreeX}
          </AppText>
          <AppText as="div" variant="micro" className="mt-0.5 text-text-subtle">
            Above 3x
          </AppText>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className={cn('text-[14px] font-medium', NEEDS_PUSH_CLASS[status])}>
            {needsPush}
          </div>
          <AppText as="div" variant="micro" className="mt-0.5 text-text-subtle">
            Needs push
          </AppText>
        </div>
      </div>
    </button>
  );
}
