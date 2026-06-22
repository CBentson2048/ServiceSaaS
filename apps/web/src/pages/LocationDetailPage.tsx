import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  BusinessLocation,
  LocationCancellationPolicy,
  LocationProductBillingSettings,
  LocationTaxSettings,
  ProductBillingRule,
  TaxAppliesTo,
  TaxDisplayMode,
} from '@sheer/domain';
import { describeTaxedAmount } from '@sheer/domain';
import {
  ApiRequestError,
  getCancellationPolicy,
  getLocation,
  getLocationProductBillingSettings,
  getLocationTaxSettings,
  updateCancellationPolicy,
  updateLocationProductBillingSettings,
  updateLocationTaxSettings,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

export function LocationDetailPage() {
  const auth = useAuth();
  const params = useParams<{ id: string }>();
  const accessToken = auth.session?.accessToken;
  const role = auth.user?.primaryRole;
  const [location, setLocation] = useState<BusinessLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!accessToken || !params.id) return;
      setLoading(true);
      setError(null);
      try {
        const { location: loaded } = await getLocation(accessToken, params.id);
        if (!cancelled) setLocation(loaded);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load location');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [accessToken, params.id]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
      <nav className="mb-4 flex items-center gap-1.5 text-[12px] text-text-secondary">
        {role === 'owner' ? (
          <Link to="/locations" className="hover:text-text-primary transition-colors">Locations</Link>
        ) : (
          <span>My location</span>
        )}
        <span className="text-text-muted">/</span>
        <span className="text-text-primary">{location?.name ?? 'Loading…'}</span>
      </nav>

      {loading ? (
        <div className="rounded-card-lg border border-border bg-surface px-5 py-10 text-center text-[13px] text-text-secondary">
          Loading location…
        </div>
      ) : error ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : location ? (
        <div className="space-y-5">
          {/* Header */}
          <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-[22px] font-semibold leading-7 text-text-primary">
                {location.name}
              </h1>
              <p className="mt-1 text-[13px] text-text-secondary">
                <span className="font-mono">{location.slug}</span>
                <span className="mx-1.5 text-text-muted">·</span>
                {location.code}
                <span className="mx-1.5 text-text-muted">·</span>
                {location.timezone}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill active={location.isActive} />
              {role === 'owner' ? (
                <Link
                  to={`/locations/${location.id}/edit`}
                  className="inline-flex h-9 items-center justify-center rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
                >
                  Edit basics
                </Link>
              ) : null}
            </div>
          </header>

          {/* Contact summary */}
          <section className="rounded-card-lg border border-border bg-surface px-5 py-5">
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.08em] text-text-muted">
              Summary
            </h2>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SummaryRow label="Phone" value={location.phone} />
              <SummaryRow label="Email" value={location.email} />
              <SummaryRow label="Address" value={joinAddress(location)} placeholder="No address on file" />
              <SummaryRow label="Country" value={location.countryCode} />
            </dl>
          </section>

          {/* Booking config */}
          <section className="rounded-card-lg border border-border bg-surface px-5 py-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-[14px] font-semibold text-text-primary">Booking configuration</h2>
                <p className="mt-1 text-[13px] text-text-secondary">
                  Mandatory finishing services and upgrade prompts for public booking.
                </p>
              </div>
              {role === 'owner' ? (
                <Link
                  to={`/settings/booking?locationId=${encodeURIComponent(location.id)}`}
                  className="inline-flex h-9 shrink-0 items-center justify-center rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
                >
                  Booking settings
                </Link>
              ) : null}
            </div>
          </section>

          {/* Product auto-billing */}
          {role === 'owner' || role === 'manager' ? (
            <ProductBillingSection locationId={location.id} accessToken={accessToken} />
          ) : null}

          {/* Tax configuration */}
          {role === 'owner' || role === 'manager' ? (
            <TaxSettingsSection locationId={location.id} accessToken={accessToken} />
          ) : null}

          {/* Cancellation policy */}
          {role === 'owner' || role === 'manager' ? (
            <CancellationPolicySection locationId={location.id} accessToken={accessToken} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product Auto-Billing
// ---------------------------------------------------------------------------

type BillingFormState = {
  productBillingEnabled: boolean;
  productBillingRule: ProductBillingRule;
  productMarkupPercent: string;
  productFixedUpliftAmount: string;
  productRoundUpEnabled: boolean;
  productRoundUpIncrement: string;
};

// Common round-up steps offered as quick presets (decimal GBP).
const ROUND_UP_PRESETS = ['0.05', '0.10', '0.50', '1.00'];

/** Rounds a major-unit amount UP to the nearest increment, working in pence to avoid float drift. */
function applyRoundUpMajor(amount: number, increment: number): number {
  if (!(increment > 0)) return amount;
  const amountPence = Math.round(amount * 100);
  const stepPence = Math.round(increment * 100);
  if (stepPence <= 0) return amount;
  return (Math.ceil(amountPence / stepPence) * stepPence) / 100;
}

const BILLING_RULES: { value: ProductBillingRule; label: string; description: string }[] = [
  {
    value: 'cost_only',
    label: 'Cost only',
    description: 'Bill exactly what the product costs.',
  },
  {
    value: 'cost_plus_markup_percent',
    label: 'Cost + markup %',
    description: 'Add a percentage on top of product cost.',
  },
  {
    value: 'fixed_uplift',
    label: 'Fixed uplift',
    description: 'Add a fixed amount on top of product cost.',
  },
];

const EXAMPLE_COST = 10;

function previewBillableAmount(
  rule: ProductBillingRule,
  markup: string,
  uplift: string,
  roundUpEnabled: boolean,
  roundUpIncrement: string,
): { amount: number; base: number; valid: boolean; rounded: boolean } {
  const base = baseBillableAmount(rule, markup, uplift);
  if (base === null) return { amount: EXAMPLE_COST, base: EXAMPLE_COST, valid: false, rounded: false };

  if (!roundUpEnabled) return { amount: base, base, valid: true, rounded: false };
  const inc = parseFloat(roundUpIncrement);
  if (isNaN(inc) || inc <= 0) return { amount: base, base, valid: true, rounded: false };
  const amount = applyRoundUpMajor(base, inc);
  return { amount, base, valid: true, rounded: amount !== base };
}

function baseBillableAmount(rule: ProductBillingRule, markup: string, uplift: string): number | null {
  if (rule === 'cost_only') return EXAMPLE_COST;
  if (rule === 'cost_plus_markup_percent') {
    const pct = parseFloat(markup);
    if (isNaN(pct) || pct < 0) return null;
    return EXAMPLE_COST + (EXAMPLE_COST * pct) / 100;
  }
  if (rule === 'fixed_uplift') {
    const amt = parseFloat(uplift);
    if (isNaN(amt) || amt < 0) return null;
    return EXAMPLE_COST + amt;
  }
  return null;
}

function toForm(settings?: LocationProductBillingSettings): BillingFormState {
  return {
    productBillingEnabled: settings?.productBillingEnabled ?? true,
    productBillingRule: settings?.productBillingRule ?? 'cost_only',
    productMarkupPercent:
      settings?.productMarkupPercent != null ? String(settings.productMarkupPercent) : '',
    productFixedUpliftAmount:
      settings?.productFixedUpliftAmount != null ? String(settings.productFixedUpliftAmount) : '',
    productRoundUpEnabled: settings?.productRoundUpEnabled ?? false,
    productRoundUpIncrement:
      settings?.productRoundUpIncrement != null ? String(settings.productRoundUpIncrement) : '0.50',
  };
}

function isDirty(form: BillingFormState, settings: LocationProductBillingSettings): boolean {
  const markupNum =
    form.productBillingRule === 'cost_plus_markup_percent'
      ? parseFloat(form.productMarkupPercent)
      : null;
  const upliftNum =
    form.productBillingRule === 'fixed_uplift'
      ? parseFloat(form.productFixedUpliftAmount)
      : null;
  const incrementNum = form.productRoundUpEnabled ? parseFloat(form.productRoundUpIncrement) : null;
  return (
    form.productBillingEnabled !== settings.productBillingEnabled ||
    form.productBillingRule !== settings.productBillingRule ||
    markupNum !== settings.productMarkupPercent ||
    upliftNum !== settings.productFixedUpliftAmount ||
    form.productRoundUpEnabled !== settings.productRoundUpEnabled ||
    incrementNum !== settings.productRoundUpIncrement
  );
}

function ProductBillingSection({
  locationId,
  accessToken,
}: {
  locationId: string;
  accessToken: string | undefined;
}) {
  const [settings, setSettings] = useState<LocationProductBillingSettings | null>(null);
  const [form, setForm] = useState<BillingFormState>(() => toForm());
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((tone: 'success' | 'danger', text: string) => {
    setNotice({ tone, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (tone === 'success') {
      noticeTimer.current = setTimeout(() => setNotice(null), 4000);
    }
  }, []);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoadState('loading');
    try {
      const { settings: loaded } = await getLocationProductBillingSettings(accessToken, locationId);
      setSettings(loaded);
      setForm(toForm(loaded));
      setLoadState('ready');
    } catch {
      setLoadState('unavailable');
    }
  }, [accessToken, locationId]);

  useEffect(() => {
    void load();
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [load]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !settings) return;

    const rule = form.productBillingRule;
    const markupPercent =
      rule === 'cost_plus_markup_percent' ? parseFloat(form.productMarkupPercent) : null;
    const fixedUpliftAmount =
      rule === 'fixed_uplift' ? parseFloat(form.productFixedUpliftAmount) : null;

    if (rule === 'cost_plus_markup_percent' && (isNaN(markupPercent!) || markupPercent! < 0)) {
      showNotice('danger', 'Markup percentage must be a valid number of 0 or more.');
      return;
    }
    if (rule === 'fixed_uplift' && (isNaN(fixedUpliftAmount!) || fixedUpliftAmount! < 0)) {
      showNotice('danger', 'Fixed uplift amount must be a valid number of 0 or more.');
      return;
    }

    const roundUpEnabled = form.productRoundUpEnabled;
    const roundUpIncrement = roundUpEnabled ? parseFloat(form.productRoundUpIncrement) : null;
    if (roundUpEnabled && (isNaN(roundUpIncrement!) || roundUpIncrement! <= 0)) {
      showNotice('danger', 'Round-up increment must be a number greater than 0 (e.g. 0.50).');
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const { settings: updated } = await updateLocationProductBillingSettings(accessToken, {
        locationId,
        productBillingEnabled: form.productBillingEnabled,
        productBillingRule: rule,
        productMarkupPercent: markupPercent,
        productFixedUpliftAmount: fixedUpliftAmount,
        productRoundUpEnabled: roundUpEnabled,
        productRoundUpIncrement: roundUpIncrement,
      });
      setSettings(updated);
      setForm(toForm(updated));
      showNotice('success', 'Product billing settings saved successfully.');
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message
        : err instanceof Error ? err.message
        : 'Could not save billing settings.';
      showNotice('danger', message);
    } finally {
      setSaving(false);
    }
  }

  if (loadState === 'loading') {
    return (
      <section className="rounded-card-lg border border-border bg-surface px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          <span className="text-[13px] text-text-secondary">Loading billing settings…</span>
        </div>
      </section>
    );
  }

  if (loadState === 'unavailable') return null;

  const preview = previewBillableAmount(
    form.productBillingRule,
    form.productMarkupPercent,
    form.productFixedUpliftAmount,
    form.productRoundUpEnabled,
    form.productRoundUpIncrement,
  );

  const hasChanges = settings ? isDirty(form, settings) : false;

  return (
    <section className="rounded-card-lg border border-border bg-surface">
      {/* Section header */}
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[14px] font-semibold text-text-primary">Product Auto-Billing</h2>
            <p className="mt-0.5 text-[12px] text-text-secondary">
              Controls how product usage is billed during checkout at this location.
            </p>
          </div>
          <EnableToggle
            enabled={form.productBillingEnabled}
            onChange={(enabled) => setForm((f) => ({ ...f, productBillingEnabled: enabled }))}
          />
        </div>
      </div>

      <form onSubmit={(e) => { void handleSubmit(e); }} className="px-5 py-5">
        {/* Notice */}
        {notice ? (
          <div
            role="alert"
            className={`mb-5 flex items-start gap-3 rounded-input-lg border px-4 py-3 text-[13px] ${
              notice.tone === 'success'
                ? 'border-success-border bg-success-soft text-success'
                : 'border-danger-border bg-danger-soft text-danger'
            }`}
          >
            <span className="mt-px shrink-0 text-[15px] leading-none">
              {notice.tone === 'success' ? '✓' : '!'}
            </span>
            <span>{notice.text}</span>
          </div>
        ) : null}

        <fieldset
          disabled={!form.productBillingEnabled}
          className="space-y-5 transition-opacity disabled:pointer-events-none disabled:opacity-40"
        >
          {/* Rule selection */}
          <div>
            <div className="mb-2.5 text-[12px] font-semibold text-text-secondary">
              Billing method
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {BILLING_RULES.map(({ value, label, description }) => {
                const selected = form.productBillingRule === value;
                return (
                  <label
                    key={value}
                    className={`group flex cursor-pointer flex-col gap-1 rounded-input-lg border px-4 py-3 transition-colors ${
                      selected
                        ? 'border-primary bg-primary/[0.05]'
                        : 'border-border bg-surface hover:border-border-strong hover:bg-surface-alt/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="productBillingRule"
                      value={value}
                      checked={selected}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          productBillingRule: value,
                          productMarkupPercent: value !== 'cost_plus_markup_percent' ? f.productMarkupPercent : f.productMarkupPercent || '',
                          productFixedUpliftAmount: value !== 'fixed_uplift' ? f.productFixedUpliftAmount : f.productFixedUpliftAmount || '',
                        }))
                      }
                      className="sr-only"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[13px] font-medium ${selected ? 'text-primary' : 'text-text-primary'}`}>
                        {label}
                      </span>
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                          selected ? 'border-primary bg-primary' : 'border-border-strong bg-surface'
                        }`}
                      >
                        {selected ? (
                          <span className="block h-1.5 w-1.5 rounded-full bg-white" />
                        ) : null}
                      </span>
                    </div>
                    <span className="text-[11px] leading-4 text-text-muted">{description}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Parameter input */}
          {form.productBillingRule === 'cost_plus_markup_percent' ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="markup-pct" className="text-[12px] font-medium text-text-secondary">
                Markup percentage
              </label>
              <div className="relative w-52">
                <input
                  id="markup-pct"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.productMarkupPercent}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, productMarkupPercent: e.target.value }))
                  }
                  placeholder="e.g. 25"
                  className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 pr-9 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-medium text-text-muted">
                  %
                </span>
              </div>
              <p className="text-[11px] text-text-muted">
                Billable = product cost × (1 + markup ÷ 100)
              </p>
            </div>
          ) : null}

          {form.productBillingRule === 'fixed_uplift' ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fixed-uplift" className="text-[12px] font-medium text-text-secondary">
                Fixed uplift amount
              </label>
              <div className="relative w-52">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] font-medium text-text-muted">
                  £
                </span>
                <input
                  id="fixed-uplift"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.productFixedUpliftAmount}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, productFixedUpliftAmount: e.target.value }))
                  }
                  placeholder="e.g. 4.00"
                  className="h-10 w-full rounded-input-lg border border-border-strong bg-surface pl-7 pr-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <p className="text-[11px] text-text-muted">
                Billable = product cost + fixed uplift
              </p>
            </div>
          ) : null}

          {/* Round-up */}
          <div className="rounded-input-lg border border-border bg-surface-alt/30 px-4 py-3.5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[12px] font-semibold text-text-secondary">Round up billable amount</div>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  Rounds the final amount up to the nearest increment — e.g. £4.44 → £4.50, £4.89 → £5.00.
                </p>
              </div>
              <EnableToggle
                enabled={form.productRoundUpEnabled}
                onChange={(enabled) => setForm((f) => ({ ...f, productRoundUpEnabled: enabled }))}
              />
            </div>

            {form.productRoundUpEnabled ? (
              <div className="mt-3.5 flex flex-col gap-2">
                <label htmlFor="round-up-increment" className="text-[12px] font-medium text-text-secondary">
                  Round up to the nearest
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-32">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] font-medium text-text-muted">
                      £
                    </span>
                    <input
                      id="round-up-increment"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={form.productRoundUpIncrement}
                      onChange={(e) => setForm((f) => ({ ...f, productRoundUpIncrement: e.target.value }))}
                      placeholder="e.g. 0.50"
                      className="h-10 w-full rounded-input-lg border border-border-strong bg-surface pl-7 pr-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ROUND_UP_PRESETS.map((preset) => {
                      const active = parseFloat(form.productRoundUpIncrement) === parseFloat(preset);
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, productRoundUpIncrement: preset }))}
                          className={`inline-flex h-8 items-center rounded-pill border px-3 text-[12px] font-medium transition-colors ${
                            active
                              ? 'border-primary bg-primary/[0.06] text-primary'
                              : 'border-border bg-surface text-text-secondary hover:border-border-strong hover:bg-surface-alt'
                          }`}
                        >
                          £{preset}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Live preview */}
          <BillingPreview
            rule={form.productBillingRule}
            preview={preview}
            markupPercent={form.productMarkupPercent}
            fixedUplift={form.productFixedUpliftAmount}
            roundUpEnabled={form.productRoundUpEnabled}
            roundUpIncrement={form.productRoundUpIncrement}
          />
        </fieldset>

        {/* Footer */}
        <div className="mt-5 flex items-center justify-between gap-4 border-t border-border pt-4">
          <p className="text-[12px] text-text-muted">
            {settings && !hasChanges ? 'No unsaved changes.' : hasChanges ? 'You have unsaved changes.' : ''}
          </p>
          <button
            type="submit"
            disabled={saving || !hasChanges}
            className="inline-flex h-9 items-center gap-2 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Saving…
              </>
            ) : (
              'Save settings'
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

function EnableToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <span className="text-[12px] font-medium text-text-secondary">
        {enabled ? 'Enabled' : 'Disabled'}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
          enabled ? 'border-primary bg-primary' : 'border-border-strong bg-surface-alt'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}

function BillingPreview({
  rule,
  preview,
  markupPercent,
  fixedUplift,
  roundUpEnabled,
  roundUpIncrement,
}: {
  rule: ProductBillingRule;
  preview: { amount: number; base: number; valid: boolean; rounded: boolean };
  markupPercent: string;
  fixedUplift: string;
  roundUpEnabled: boolean;
  roundUpIncrement: string;
}) {
  const baseFmt = fmtGbp(EXAMPLE_COST);
  const baseBillFmt = preview.valid ? fmtGbp(preview.base) : '—';
  const billFmt = preview.valid ? fmtGbp(preview.amount) : '—';

  let formulaLabel = '';
  if (rule === 'cost_only') formulaLabel = `${baseFmt} (cost only)`;
  else if (rule === 'cost_plus_markup_percent') {
    const pct = parseFloat(markupPercent);
    formulaLabel = isNaN(pct) ? `${baseFmt} + ?%` : `${baseFmt} + ${pct}% = ${baseBillFmt}`;
  } else if (rule === 'fixed_uplift') {
    const amt = parseFloat(fixedUplift);
    formulaLabel = isNaN(amt)
      ? `${baseFmt} + £?`
      : `${baseFmt} + ${fmtGbp(amt)} uplift = ${baseBillFmt}`;
  }

  if (preview.valid && roundUpEnabled) {
    const inc = parseFloat(roundUpIncrement);
    if (!isNaN(inc) && inc > 0) {
      formulaLabel = `${formulaLabel}, rounded up to nearest ${fmtGbp(inc)} = ${billFmt}`;
    }
  }

  return (
    <div className="rounded-input-lg border border-border bg-surface-alt/40 px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Example preview
          </p>
          <p className="mt-1 text-[12px] text-text-secondary">{formulaLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Billable amount
          </p>
          <p
            className={`mt-1 text-[20px] font-bold tabular-nums tracking-tight ${
              preview.valid ? 'text-text-primary' : 'text-text-muted'
            }`}
          >
            {billFmt}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tax Configuration
// ---------------------------------------------------------------------------

type TaxFormState = {
  taxEnabled: boolean;
  taxLabel: string;
  taxRatePercent: string;
  appliesTo: TaxAppliesTo;
  displayMode: TaxDisplayMode;
};

const APPLIES_TO_OPTIONS: { value: TaxAppliesTo; label: string }[] = [
  { value: 'services', label: 'Services only' },
  { value: 'retail', label: 'Retail only' },
  { value: 'both', label: 'Services & retail' },
];

const DISPLAY_MODE_OPTIONS: { value: TaxDisplayMode; label: string; description: string }[] = [
  { value: 'ex_tax', label: 'Tax-exclusive', description: 'Prices shown without tax; tax added on top.' },
  { value: 'inc_tax', label: 'Tax-inclusive', description: 'Prices shown with tax already included.' },
  { value: 'both', label: 'Show both', description: 'Show net, tax and gross side by side.' },
];

const TAX_EXAMPLE_CENTS = 10000; // £100.00 sample

function toTaxForm(settings?: LocationTaxSettings): TaxFormState {
  return {
    taxEnabled: settings?.taxEnabled ?? false,
    taxLabel: settings?.taxLabel ?? '',
    taxRatePercent: settings?.taxRatePercent != null ? String(settings.taxRatePercent) : '',
    appliesTo: settings?.appliesTo ?? 'both',
    displayMode: settings?.displayMode ?? 'ex_tax',
  };
}

function parseRate(value: string): number {
  return value.trim() === '' ? 0 : parseFloat(value);
}

function isTaxDirty(form: TaxFormState, settings: LocationTaxSettings): boolean {
  return (
    form.taxEnabled !== settings.taxEnabled ||
    (form.taxLabel.trim() || null) !== (settings.taxLabel || null) ||
    parseRate(form.taxRatePercent) !== settings.taxRatePercent ||
    form.appliesTo !== settings.appliesTo ||
    form.displayMode !== settings.displayMode
  );
}

function formStateToSettings(locationId: string, form: TaxFormState): LocationTaxSettings {
  const rate = parseRate(form.taxRatePercent);
  return {
    locationId,
    taxEnabled: form.taxEnabled,
    taxLabel: form.taxLabel.trim() || null,
    taxRatePercent: Number.isNaN(rate) ? 0 : rate,
    appliesTo: form.appliesTo,
    displayMode: form.displayMode,
  };
}

function TaxSettingsSection({
  locationId,
  accessToken,
}: {
  locationId: string;
  accessToken: string | undefined;
}) {
  const [settings, setSettings] = useState<LocationTaxSettings | null>(null);
  const [form, setForm] = useState<TaxFormState>(() => toTaxForm());
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((tone: 'success' | 'danger', text: string) => {
    setNotice({ tone, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (tone === 'success') {
      noticeTimer.current = setTimeout(() => setNotice(null), 4000);
    }
  }, []);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoadState('loading');
    try {
      const { settings: loaded } = await getLocationTaxSettings(accessToken, locationId);
      setSettings(loaded);
      setForm(toTaxForm(loaded));
      setLoadState('ready');
    } catch {
      setLoadState('unavailable');
    }
  }, [accessToken, locationId]);

  useEffect(() => {
    void load();
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [load]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !settings) return;

    const rate = parseRate(form.taxRatePercent);
    if (Number.isNaN(rate) || rate < 0) {
      showNotice('danger', 'Tax rate must be a valid number of 0 or more.');
      return;
    }
    if (form.taxEnabled && !form.taxLabel.trim()) {
      showNotice('danger', 'A tax label is required when tax is enabled.');
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const { settings: updated } = await updateLocationTaxSettings(accessToken, {
        locationId,
        taxEnabled: form.taxEnabled,
        taxLabel: form.taxLabel.trim(),
        taxRatePercent: rate,
        appliesTo: form.appliesTo,
        displayMode: form.displayMode,
      });
      setSettings(updated);
      setForm(toTaxForm(updated));
      showNotice('success', 'Tax settings saved successfully.');
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message
        : err instanceof Error ? err.message
        : 'Could not save tax settings.';
      showNotice('danger', message);
    } finally {
      setSaving(false);
    }
  }

  if (loadState === 'loading') {
    return (
      <section className="rounded-card-lg border border-border bg-surface px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          <span className="text-[13px] text-text-secondary">Loading tax settings…</span>
        </div>
      </section>
    );
  }

  if (loadState === 'unavailable') return null;

  const previewCategory = form.appliesTo === 'retail' ? 'retail' : 'service';
  const preview = describeTaxedAmount(
    TAX_EXAMPLE_CENTS,
    formStateToSettings(locationId, form),
    previewCategory,
    (cents) => fmtGbp(cents / 100),
  );
  const hasChanges = settings ? isTaxDirty(form, settings) : false;

  return (
    <section className="rounded-card-lg border border-border bg-surface">
      {/* Section header */}
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[14px] font-semibold text-text-primary">Tax Configuration</h2>
            <p className="mt-0.5 text-[12px] text-text-secondary">
              Configurable, location-aware tax. Not hardcoded to any single jurisdiction.
            </p>
          </div>
          <EnableToggle
            enabled={form.taxEnabled}
            onChange={(enabled) => setForm((f) => ({ ...f, taxEnabled: enabled }))}
          />
        </div>
      </div>

      <form onSubmit={(e) => { void handleSubmit(e); }} className="px-5 py-5">
        {notice ? (
          <div
            role="alert"
            className={`mb-5 flex items-start gap-3 rounded-input-lg border px-4 py-3 text-[13px] ${
              notice.tone === 'success'
                ? 'border-success-border bg-success-soft text-success'
                : 'border-danger-border bg-danger-soft text-danger'
            }`}
          >
            <span className="mt-px shrink-0 text-[15px] leading-none">
              {notice.tone === 'success' ? '✓' : '!'}
            </span>
            <span>{notice.text}</span>
          </div>
        ) : null}

        <fieldset
          disabled={!form.taxEnabled}
          className="space-y-5 transition-opacity disabled:pointer-events-none disabled:opacity-40"
        >
          {/* Label + rate */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tax-label" className="text-[12px] font-medium text-text-secondary">
                Tax label
              </label>
              <input
                id="tax-label"
                type="text"
                value={form.taxLabel}
                onChange={(e) => setForm((f) => ({ ...f, taxLabel: e.target.value }))}
                placeholder="e.g. VAT, GST, Sales Tax"
                maxLength={60}
                className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tax-rate" className="text-[12px] font-medium text-text-secondary">
                Tax rate
              </label>
              <div className="relative w-full">
                <input
                  id="tax-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.taxRatePercent}
                  onChange={(e) => setForm((f) => ({ ...f, taxRatePercent: e.target.value }))}
                  placeholder="e.g. 20"
                  className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 pr-9 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-medium text-text-muted">
                  %
                </span>
              </div>
            </div>
          </div>

          {/* Applies to */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="tax-applies-to" className="text-[12px] font-medium text-text-secondary">
              Applies to
            </label>
            <select
              id="tax-applies-to"
              value={form.appliesTo}
              onChange={(e) => setForm((f) => ({ ...f, appliesTo: e.target.value as TaxAppliesTo }))}
              className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-72"
            >
              {APPLIES_TO_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Display mode */}
          <div>
            <div className="mb-2.5 text-[12px] font-semibold text-text-secondary">Display mode</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {DISPLAY_MODE_OPTIONS.map(({ value, label, description }) => {
                const selected = form.displayMode === value;
                return (
                  <label
                    key={value}
                    className={`group flex cursor-pointer flex-col gap-1 rounded-input-lg border px-4 py-3 transition-colors ${
                      selected
                        ? 'border-primary bg-primary/[0.05]'
                        : 'border-border bg-surface hover:border-border-strong hover:bg-surface-alt/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="taxDisplayMode"
                      value={value}
                      checked={selected}
                      onChange={() => setForm((f) => ({ ...f, displayMode: value }))}
                      className="sr-only"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[13px] font-medium ${selected ? 'text-primary' : 'text-text-primary'}`}>
                        {label}
                      </span>
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                          selected ? 'border-primary bg-primary' : 'border-border-strong bg-surface'
                        }`}
                      >
                        {selected ? <span className="block h-1.5 w-1.5 rounded-full bg-white" /> : null}
                      </span>
                    </div>
                    <span className="text-[11px] leading-4 text-text-muted">{description}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Live preview */}
          <div className="rounded-input-lg border border-border bg-surface-alt/40 px-4 py-3.5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                  Example preview
                </p>
                <p className="mt-1 text-[12px] text-text-secondary">
                  A {fmtGbp(TAX_EXAMPLE_CENTS / 100)} {previewCategory} line, shown to users as:
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                  Displayed
                </p>
                <p className="mt-1 text-[18px] font-bold tabular-nums tracking-tight text-text-primary">
                  {preview.label}
                </p>
              </div>
            </div>
          </div>
        </fieldset>

        {/* Footer */}
        <div className="mt-5 flex items-center justify-between gap-4 border-t border-border pt-4">
          <p className="text-[12px] text-text-muted">
            {settings && !hasChanges ? 'No unsaved changes.' : hasChanges ? 'You have unsaved changes.' : ''}
          </p>
          <button
            type="submit"
            disabled={saving || !hasChanges}
            className="inline-flex h-9 items-center gap-2 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Saving…
              </>
            ) : (
              'Save settings'
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cancellation policy
// ---------------------------------------------------------------------------

function CancellationPolicySection({
  locationId,
  accessToken,
}: {
  locationId: string;
  accessToken: string | undefined;
}) {
  const [settings, setSettings] = useState<LocationCancellationPolicy | null>(null);
  const [windowDays, setWindowDays] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((tone: 'success' | 'danger', text: string) => {
    setNotice({ tone, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (tone === 'success') {
      noticeTimer.current = setTimeout(() => setNotice(null), 4000);
    }
  }, []);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoadState('loading');
    try {
      const { settings: loaded } = await getCancellationPolicy(accessToken, locationId);
      setSettings(loaded);
      setWindowDays(String(loaded.cancellationWindowDays));
      setLoadState('ready');
    } catch {
      setLoadState('unavailable');
    }
  }, [accessToken, locationId]);

  useEffect(() => {
    void load();
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [load]);

  const parsed = Number.parseInt(windowDays, 10);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 60;
  const hasChanges = settings ? valid && parsed !== settings.cancellationWindowDays : false;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !settings) return;
    if (!valid) {
      showNotice('danger', 'Enter a whole number of days between 0 and 60.');
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const { settings: updated } = await updateCancellationPolicy(accessToken, {
        locationId,
        cancellationWindowDays: parsed,
      });
      setSettings(updated);
      setWindowDays(String(updated.cancellationWindowDays));
      showNotice('success', 'Cancellation policy saved successfully.');
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message
        : err instanceof Error ? err.message
        : 'Could not save the cancellation policy.';
      showNotice('danger', message);
    } finally {
      setSaving(false);
    }
  }

  if (loadState === 'loading') {
    return (
      <section className="rounded-card-lg border border-border bg-surface px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          <span className="text-[13px] text-text-secondary">Loading cancellation policy…</span>
        </div>
      </section>
    );
  }

  if (loadState === 'unavailable') return null;

  return (
    <section className="rounded-card-lg border border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[14px] font-semibold text-text-primary">Cancellation Policy</h2>
        <p className="mt-0.5 text-[12px] text-text-secondary">
          How far ahead customers can cancel (with a deposit refund) or rebook from the app.
        </p>
      </div>

      <form onSubmit={(e) => { void handleSubmit(e); }} className="px-5 py-5">
        {notice ? (
          <div
            role="alert"
            className={`mb-5 flex items-start gap-3 rounded-input-lg border px-4 py-3 text-[13px] ${
              notice.tone === 'success'
                ? 'border-success-border bg-success-soft text-success'
                : 'border-danger-border bg-danger-soft text-danger'
            }`}
          >
            <span className="mt-px shrink-0 text-[15px] leading-none">
              {notice.tone === 'success' ? '✓' : '!'}
            </span>
            <span>{notice.text}</span>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cancellation-window" className="text-[12px] font-medium text-text-secondary">
            Cancellation window
          </label>
          <div className="flex items-center gap-3">
            <div className="relative w-40">
              <input
                id="cancellation-window"
                type="number"
                min="0"
                max="60"
                step="1"
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value)}
                placeholder="e.g. 2"
                className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 pr-16 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-medium text-text-muted">
                days
              </span>
            </div>
          </div>
          <p className="mt-1 text-[12px] text-text-muted">
            Customers can cancel or rebook up to this many days before their appointment. Inside this window a
            cancellation forfeits the deposit and rebooking is disabled.
          </p>
        </div>

        <div className="mt-5 flex items-center justify-between gap-4 border-t border-border pt-4">
          <p className="text-[12px] text-text-muted">
            {settings && !hasChanges ? 'No unsaved changes.' : hasChanges ? 'You have unsaved changes.' : ''}
          </p>
          <button
            type="submit"
            disabled={saving || !hasChanges}
            className="inline-flex h-9 items-center gap-2 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Saving…
              </>
            ) : (
              'Save settings'
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex h-7 items-center rounded-pill px-3 text-[12px] font-medium ${
        active
          ? 'border border-success-border bg-success-soft text-success'
          : 'border border-border-strong bg-surface-alt text-text-secondary'
      }`}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function SummaryRow({
  label,
  value,
  placeholder,
}: {
  label: string;
  value?: string | null;
  placeholder?: string;
}) {
  const display = value && value.trim() ? value : placeholder ?? '—';
  const isEmpty = !value || !value.trim();
  return (
    <div className="rounded-input-lg border border-border bg-surface-alt/50 px-3 py-2.5">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
        {label}
      </dt>
      <dd className={`mt-1 text-[13px] ${isEmpty ? 'text-text-muted' : 'text-text-primary'}`}>
        {display}
      </dd>
    </div>
  );
}

function fmtGbp(amount: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount);
}

function joinAddress(location: BusinessLocation): string | undefined {
  const lines = [
    location.addressLine1,
    location.addressLine2,
    [location.city, location.region].filter(Boolean).join(', ') || undefined,
    location.postalCode,
  ].filter((part): part is string => Boolean(part?.trim()));
  return lines.length === 0 ? undefined : lines.join('\n');
}
