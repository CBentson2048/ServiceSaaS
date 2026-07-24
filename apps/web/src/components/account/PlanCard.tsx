import { useCallback, useEffect, useState } from 'react';
import type { AccountTierState, BusinessTier, BusinessTierLimits } from '@sheer/domain';
import {
  BUSINESS_TIER_LABELS,
  BUSINESS_TIER_LIMITS,
  BUSINESS_TIER_ORDER,
  BUSINESS_TIER_TAGLINES,
  userHasRole,
} from '@sheer/domain';
import { getAccount, updateAccountTier } from '../../auth/api';
import { useAuth } from '../../auth/AuthProvider';
import { Modal } from '../team/Modal';

/**
 * Settings → Account & plan body: current tier with live usage meters, a
 * three-tier comparison grid (Spark / Pulse / Infinity) and a confirm-to-change
 * flow. Feature copy is derived from BUSINESS_TIER_LIMITS so the cards can
 * never drift from the limits the API enforces. Only owners can change tier
 * (mirrors AccountService.assertOwner); managers get a read-only view.
 */
export function PlanCard({ accessToken }: { accessToken: string }) {
  const auth = useAuth();
  const isOwner = userHasRole(auth.user, 'owner');

  const [state, setState] = useState<AccountTierState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [pendingTier, setPendingTier] = useState<BusinessTier | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { account } = await getAccount(accessToken);
      setState(account);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Could not load plan');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  function requestTierChange(next: BusinessTier) {
    setChangeError(null);
    setPendingTier(next);
  }

  async function confirmTierChange() {
    if (!state || !pendingTier || pendingTier === state.tier) return;
    setSaving(true);
    setChangeError(null);
    try {
      const { account } = await updateAccountTier(accessToken, { tier: pendingTier });
      setState(account);
      setPendingTier(null);
    } catch (err: unknown) {
      setChangeError(err instanceof Error ? err.message : 'Could not change plan');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-40 animate-pulse rounded-card-lg border border-border bg-surface" />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="h-72 animate-pulse rounded-card-lg border border-border bg-surface" />
          <div className="h-72 animate-pulse rounded-card-lg border border-border bg-surface" />
          <div className="h-72 animate-pulse rounded-card-lg border border-border bg-surface" />
        </div>
      </div>
    );
  }
  if (!state) {
    return loadError ? (
      <div
        role="alert"
        className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger"
      >
        {loadError}
      </div>
    ) : null;
  }

  const recommendedTier = state.upgradeSuggestion?.toTier ?? null;
  // Exactly one filled CTA on the page: the data-driven recommendation when we
  // have one, otherwise the next tier up. Everything else stays a quiet outline.
  const emphasizedTier =
    recommendedTier ?? BUSINESS_TIER_ORDER[BUSINESS_TIER_ORDER.indexOf(state.tier) + 1] ?? null;

  return (
    <div className="space-y-6">
      <CurrentPlanSummary
        state={state}
        isOwner={isOwner}
        onUpgrade={recommendedTier ? () => requestTierChange(recommendedTier) : undefined}
      />

      <section aria-label="Available plans">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-text-primary">Compare plans</h2>
          {!isOwner ? (
            <p className="text-[12px] text-text-secondary">
              Only the account owner can change the plan.
            </p>
          ) : null}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {BUSINESS_TIER_ORDER.map((tier) => (
            <TierOptionCard
              key={tier}
              tier={tier}
              state={state}
              isOwner={isOwner}
              recommended={tier === recommendedTier}
              emphasized={tier === emphasizedTier}
              onSelect={() => requestTierChange(tier)}
            />
          ))}
        </div>
        <p className="mt-4 text-[12px] text-text-secondary">
          Every plan includes the full appointment book, client records, colour tracking and
          inventory — no features are held back on smaller plans.
        </p>
      </section>

      <ConfirmTierChangeModal
        state={state}
        pendingTier={pendingTier}
        saving={saving}
        error={changeError}
        onClose={() => {
          if (!saving) setPendingTier(null);
        }}
        onConfirm={() => void confirmTierChange()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Current plan summary
// ---------------------------------------------------------------------------

function CurrentPlanSummary({
  state,
  isOwner,
  onUpgrade,
}: {
  state: AccountTierState;
  isOwner: boolean;
  onUpgrade?: () => void;
}) {
  const { tier, limits, usage, upgradeSuggestion } = state;
  const columnsIncluded = includedColumnsForBusiness(limits, usage.locationCount);

  return (
    <section className="overflow-hidden rounded-card-lg border border-border bg-surface shadow-card">
      <div className="border-b border-border bg-gradient-to-r from-primary-soft via-surface to-surface px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              Your current plan
            </p>
            <div className="mt-1 flex items-center gap-2">
              <h2 className="text-[24px] font-semibold leading-8 text-text-primary">
                {BUSINESS_TIER_LABELS[tier]}
              </h2>
              <span className="rounded-pill border border-primary/40 bg-primary-soft px-2.5 py-0.5 text-[11px] font-medium text-primary-deep">
                Active
              </span>
            </div>
            <p className="mt-1 text-[13px] text-text-secondary">{BUSINESS_TIER_TAGLINES[tier]}</p>
          </div>
          {upgradeSuggestion && isOwner && onUpgrade ? (
            <button
              type="button"
              onClick={onUpgrade}
              className="rounded-input-lg bg-primary px-4 py-2.5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              Upgrade to {BUSINESS_TIER_LABELS[upgradeSuggestion.toTier]}
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
        <UsageMeter
          label="Locations"
          used={usage.locationCount}
          max={limits.maxLocations}
        />
        <UsageMeter
          label="Bookable columns"
          used={usage.bookableColumnCount}
          max={columnsIncluded}
          softCap={!limits.bookableColumnsHardCapped}
          hint={
            limits.maxLocations === null && limits.includedBookableColumnsPerLocation !== null
              ? `${limits.includedBookableColumnsPerLocation} included per location`
              : undefined
          }
        />
        <div>
          <p className="text-[12px] font-medium text-text-secondary">Client messages</p>
          <p className="mt-1 text-[14px] font-semibold text-text-primary">
            {limits.messagingMonthlyCapPerLocation === null
              ? 'Unlimited'
              : limits.maxLocations === 1
                ? `${limits.messagingMonthlyCapPerLocation} / month`
                : `${limits.messagingMonthlyCapPerLocation} / location / month`}
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">WhatsApp &amp; SMS included</p>
        </div>
      </div>

      {upgradeSuggestion ? (
        <div className="border-t border-border bg-primary-soft px-5 py-3">
          <p className="text-[12px] text-text-secondary">
            You&apos;re using every{' '}
            {upgradeSuggestion.reason === 'columns' ? 'bookable column' : 'location'} included with{' '}
            {BUSINESS_TIER_LABELS[tier]} —{' '}
            {BUSINESS_TIER_LABELS[upgradeSuggestion.toTier]} gives you room to grow.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function UsageMeter({
  label,
  used,
  max,
  softCap = false,
  hint,
}: {
  label: string;
  used: number;
  max: number | null;
  softCap?: boolean;
  hint?: string;
}) {
  const overIncluded = softCap && max !== null && used > max;
  const pct = max === null || max === 0 ? 0 : Math.min(100, Math.round((used / max) * 100));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[12px] font-medium text-text-secondary">{label}</p>
        <p className="text-[12px] text-text-secondary">
          {max === null ? `${used} · Unlimited` : `${used} of ${max}`}
        </p>
      </div>
      {max !== null ? (
        <div
          role="progressbar"
          aria-label={`${label} used`}
          aria-valuenow={Math.min(used, max)}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuetext={`${used} of ${max}`}
          className="mt-1.5 h-1.5 overflow-hidden rounded-pill bg-border"
        >
          <div
            className="h-full rounded-pill bg-primary-deep transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {overIncluded ? (
        <p className="mt-1 text-[11px] text-text-secondary">
          Extra columns beyond included are billable
        </p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tier comparison cards
// ---------------------------------------------------------------------------

function TierOptionCard({
  tier,
  state,
  isOwner,
  recommended,
  emphasized,
  onSelect,
}: {
  tier: BusinessTier;
  state: AccountTierState;
  isOwner: boolean;
  recommended: boolean;
  emphasized: boolean;
  onSelect: () => void;
}) {
  const limits = BUSINESS_TIER_LIMITS[tier];
  const isCurrent = tier === state.tier;
  const isUpgrade = BUSINESS_TIER_ORDER.indexOf(tier) > BUSINESS_TIER_ORDER.indexOf(state.tier);
  const blockedReason = isCurrent ? null : describeSwitchBlocker(limits, state.usage);
  const bullets = tierBullets(tier);

  const frame = recommended
    ? 'border-primary-deep ring-1 ring-primary-deep'
    : isCurrent
      ? 'border-primary/50'
      : 'border-border';

  return (
    <article
      className={`relative flex flex-col rounded-card-lg border bg-surface p-5 shadow-card ${frame}`}
    >
      {recommended ? (
        <span className="absolute -top-2.5 left-5 rounded-pill bg-primary-deep px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-text-on-primary">
          Recommended
        </span>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[17px] font-semibold text-text-primary">
          {BUSINESS_TIER_LABELS[tier]}
        </h3>
        {isCurrent ? (
          <span className="rounded-pill border border-primary/40 bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary-deep">
            Current plan
          </span>
        ) : null}
      </div>
      <p className="mt-1 min-h-[32px] text-[12px] leading-4 text-text-secondary">
        {BUSINESS_TIER_TAGLINES[tier]}
      </p>

      <div className="mt-4 space-y-1.5 rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
        <TierStat
          label="Locations"
          value={limits.maxLocations === null ? 'Unlimited' : String(limits.maxLocations)}
        />
        <TierStat
          label="Bookable columns"
          value={
            limits.includedBookableColumnsPerLocation === null
              ? 'Unlimited'
              : String(limits.includedBookableColumnsPerLocation)
          }
        />
        <TierStat
          label="Messages / month"
          value={
            limits.messagingMonthlyCapPerLocation === null
              ? 'Unlimited'
              : String(limits.messagingMonthlyCapPerLocation)
          }
        />
      </div>

      <div className="mt-4 flex-1">
        {bullets.lead ? (
          <p className="text-[12px] font-medium text-text-primary">{bullets.lead}</p>
        ) : null}
        <ul className={`space-y-2.5 ${bullets.lead ? 'mt-2.5' : ''}`}>
          {bullets.items.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-[13px] text-text-primary">
              <CheckIcon />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>

      {isOwner ? (
        <div className="mt-5">
          {isCurrent ? (
            <button
              type="button"
              disabled
              className="w-full cursor-default rounded-input-lg border border-border bg-surface-alt px-4 py-2.5 text-[13px] font-medium text-text-muted"
            >
              Your current plan
            </button>
          ) : (
            <button
              type="button"
              onClick={onSelect}
              disabled={blockedReason !== null}
              className={
                isUpgrade && emphasized
                  ? 'w-full rounded-input-lg bg-primary px-4 py-2.5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50'
                  : 'w-full rounded-input-lg border border-border-strong bg-surface px-4 py-2.5 text-[13px] font-medium text-text-primary transition hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50'
              }
            >
              {isUpgrade
                ? `Upgrade to ${BUSINESS_TIER_LABELS[tier]}`
                : `Switch to ${BUSINESS_TIER_LABELS[tier]}`}
            </button>
          )}
          {blockedReason ? (
            <p className="mt-2 text-[11px] leading-4 text-text-secondary">{blockedReason}</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TierStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-[13px] font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 flex-none text-primary-deep"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Confirm change modal
// ---------------------------------------------------------------------------

function ConfirmTierChangeModal({
  state,
  pendingTier,
  saving,
  error,
  onClose,
  onConfirm,
}: {
  state: AccountTierState;
  pendingTier: BusinessTier | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!pendingTier || pendingTier === state.tier) return null;

  const isUpgrade =
    BUSINESS_TIER_ORDER.indexOf(pendingTier) > BUSINESS_TIER_ORDER.indexOf(state.tier);
  const nextLimits = BUSINESS_TIER_LIMITS[pendingTier];
  const label = BUSINESS_TIER_LABELS[pendingTier];

  return (
    <Modal
      open
      onClose={onClose}
      title={isUpgrade ? `Upgrade to ${label}` : `Switch to ${label}`}
      description={
        isUpgrade
          ? `Your business moves to ${label} straight away.`
          : `Moving from ${BUSINESS_TIER_LABELS[state.tier]} to ${label} lowers your plan limits.`
      }
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-input-lg border border-border-strong bg-surface px-4 py-2 text-[13px] font-medium text-text-primary transition hover:bg-surface-alt disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="rounded-input-lg bg-primary px-4 py-2 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
          >
            {saving ? 'Applying…' : `Confirm ${isUpgrade ? 'upgrade' : 'change'}`}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-text-secondary">On {label} your plan includes:</p>
      <ul className="mt-3 space-y-2">
        {tierFeatures(nextLimits).map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-[13px] text-text-primary">
            <CheckIcon />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      {!isUpgrade ? (
        <p className="mt-4 rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-warning">
          Anything over the new limits has to be removed before the switch — the change is blocked
          if your current usage doesn&apos;t fit.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[12px] text-danger"
        >
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Derivations from BUSINESS_TIER_LIMITS (keep card copy in lockstep with the
// limits the API enforces — never hardcode counts here)
// ---------------------------------------------------------------------------

/**
 * Comparison-card bullets. The stat strip above them carries the raw numbers,
 * so Spark's bullets sell what EVERY plan gets and higher tiers list only what
 * they add ("Everything in X, plus:"). Counts interpolate from the limits.
 */
function tierBullets(tier: BusinessTier): { lead: string | null; items: string[] } {
  const limits = BUSINESS_TIER_LIMITS[tier];
  switch (tier) {
    case 'spark':
      return {
        lead: null,
        items: [
          'Full appointment book & online booking',
          'Colour tracking, inventory & client records',
          'WhatsApp & SMS appointment messaging',
        ],
      };
    case 'pulse':
      return {
        lead: `Everything in ${BUSINESS_TIER_LABELS.spark}, plus:`,
        items: [
          `${limits.includedBookableColumnsPerLocation} bookable columns included — add more anytime`,
          `${limits.messagingMonthlyCapPerLocation} client messages every month`,
        ],
      };
    case 'infinity':
      return {
        lead: `Everything in ${BUSINESS_TIER_LABELS.pulse}, plus:`,
        items: [
          'Unlimited locations under one account',
          `${limits.includedBookableColumnsPerLocation} bookable columns included per location`,
          `${limits.messagingMonthlyCapPerLocation} client messages / location / month`,
        ],
      };
  }
}

function tierFeatures(limits: BusinessTierLimits): string[] {
  const features: string[] = [];

  features.push(
    limits.maxLocations === null
      ? 'Unlimited locations'
      : `${limits.maxLocations} location${limits.maxLocations === 1 ? '' : 's'}`,
  );

  if (limits.includedBookableColumnsPerLocation === null) {
    features.push('Unlimited bookable columns');
  } else if (limits.bookableColumnsHardCapped) {
    features.push(
      `${limits.includedBookableColumnsPerLocation} bookable column${
        limits.includedBookableColumnsPerLocation === 1 ? '' : 's'
      }`,
    );
  } else {
    features.push(
      `${limits.includedBookableColumnsPerLocation} bookable columns included per location — add more anytime`,
    );
  }

  features.push(
    limits.messagingMonthlyCapPerLocation === null
      ? 'Unlimited client messages'
      : `${limits.messagingMonthlyCapPerLocation} client messages / location / month`,
  );

  features.push('Full colour tracking, inventory & client records');

  return features;
}

/**
 * Total included bookable columns for the business right now: per-location
 * allowance × active locations (minimum one, so an empty business still shows
 * a sensible denominator). Matches how the per-location allowance scales.
 */
function includedColumnsForBusiness(
  limits: BusinessTierLimits,
  locationCount: number,
): number | null {
  if (limits.includedBookableColumnsPerLocation === null) return null;
  return limits.includedBookableColumnsPerLocation * Math.max(locationCount, 1);
}

/**
 * Client-side mirror of AccountService.updateTier's downgrade guards so we can
 * disable a switch (with a reason) instead of letting it 409. Keep in lockstep
 * with the API rules.
 */
function describeSwitchBlocker(
  target: BusinessTierLimits,
  usage: AccountTierState['usage'],
): string | null {
  if (target.maxLocations !== null && usage.locationCount > target.maxLocations) {
    return `You have ${usage.locationCount} locations, but ${BUSINESS_TIER_LABELS[target.tier]} allows ${target.maxLocations}. Remove locations first.`;
  }
  if (
    target.bookableColumnsHardCapped &&
    target.includedBookableColumnsPerLocation !== null &&
    usage.bookableColumnCount > target.includedBookableColumnsPerLocation
  ) {
    return `You have ${usage.bookableColumnCount} bookable columns, but ${BUSINESS_TIER_LABELS[target.tier]} includes ${target.includedBookableColumnsPerLocation}. Reduce bookable team members first.`;
  }
  return null;
}
