import { useCallback, useEffect, useState } from 'react';
import type { AccountTierState, BusinessTier } from '@sheer/domain';
import { BUSINESS_TIER_LABELS, BUSINESS_TIER_ORDER, BUSINESS_TIER_TAGLINES } from '@sheer/domain';
import { getAccount, updateAccountTier } from '../../auth/api';

/**
 * Account plan card: current tier, tagline, live usage (locations + bookable
 * columns), an inline "change plan" selector, and an upgrade hint. Lives under
 * Settings → Account & plan so the plan/upgrade path stays reachable on tiers
 * where the Locations screen is hidden (Wrike 4507281247).
 */
export function PlanCard({ accessToken }: { accessToken: string }) {
  const [state, setState] = useState<AccountTierState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { account } = await getAccount(accessToken);
      setState(account);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load plan');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeTier(next: BusinessTier) {
    if (!state || next === state.tier) return;
    setSaving(true);
    setError(null);
    try {
      const { account } = await updateAccountTier(accessToken, { tier: next });
      setState(account);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change plan');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mb-4 rounded-card-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary">
        Loading plan…
      </div>
    );
  }
  if (!state) {
    return error ? (
      <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
        {error}
      </div>
    ) : null;
  }

  return (
    <section className="mb-4 rounded-card-lg border border-border bg-surface px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
            Account plan
          </p>
          <p className="mt-1 text-[15px] font-semibold text-text-primary">
            {BUSINESS_TIER_LABELS[state.tier]}
          </p>
          <p className="mt-1 text-[12px] text-text-secondary">
            {BUSINESS_TIER_TAGLINES[state.tier]}
          </p>
          <p className="mt-1 text-[12px] text-text-secondary">
            Locations {formatLimit(state.usage.locationCount, state.limits.maxLocations)}
            {' · '}
            Bookable columns{' '}
            {formatLimit(
              state.usage.bookableColumnCount,
              state.limits.includedBookableColumnsPerLocation,
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          Change plan
          <select
            value={state.tier}
            disabled={saving}
            onChange={(event) => void changeTier(event.target.value as BusinessTier)}
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          >
            {BUSINESS_TIER_ORDER.map((tier) => (
              <option key={tier} value={tier}>
                {BUSINESS_TIER_LABELS[tier]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.upgradeSuggestion ? (
        <p className="mt-3 rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-warning">
          You&apos;ve reached your{' '}
          {state.upgradeSuggestion.reason === 'columns' ? 'bookable column' : 'location'} limit.
          Upgrade to {BUSINESS_TIER_LABELS[state.upgradeSuggestion.toTier]} to add more.
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function formatLimit(used: number, max: number | null): string {
  return max === null ? `${used} / Unlimited` : `${used} / ${max}`;
}
