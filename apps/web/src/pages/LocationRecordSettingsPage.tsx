import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  FixedCostCadence,
  FixedCostCategory,
  LocationFixedCost,
  LocationOpeningHoursEntry,
  LocationRecordSettings,
} from '@sheer/domain';
import {
  FIXED_COST_CADENCE_LABELS,
  FIXED_COST_CATEGORY_LABELS,
  monthlyEquivalentFixedCost,
} from '@sheer/domain';
import {
  ApiRequestError,
  createLocationFixedCost,
  deleteLocationFixedCost,
  getEffectiveFixedCosts,
  getLocationRecordSettings,
  listLocationFixedCosts,
  updateLocationFixedCost,
  updateLocationRecordSettings,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationRouteSync } from '../components/LocationScopeContext';

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FIELD =
  'w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-primary';
const LABEL = 'mb-1 block text-[12px] font-medium text-text-secondary';

const CATEGORIES = Object.keys(FIXED_COST_CATEGORY_LABELS) as FixedCostCategory[];
const CADENCES = Object.keys(FIXED_COST_CADENCE_LABELS) as FixedCostCadence[];

interface FixedCostForm {
  category: FixedCostCategory;
  label: string;
  amount: string;
  cadence: FixedCostCadence;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
}

function emptyFixedCostForm(): FixedCostForm {
  return {
    category: 'rent',
    label: '',
    amount: '',
    cadence: 'monthly',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveTo: '',
    notes: '',
  };
}

export function LocationRecordSettingsPage() {
  const auth = useAuth();
  const params = useParams<{ id: string }>();
  // Follow the sidebar location picker (and reflect the URL back into it).
  useLocationRouteSync(params.id, '/record-settings');
  const accessToken = auth.session?.accessToken;
  const locationId = params.id;

  const [settings, setSettings] = useState<LocationRecordSettings | null>(null);
  const [fixedCosts, setFixedCosts] = useState<LocationFixedCost[]>([]);
  const [monthlyTotal, setMonthlyTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [costForm, setCostForm] = useState<FixedCostForm>(emptyFixedCostForm());
  const [editingCostId, setEditingCostId] = useState<string | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [costBusy, setCostBusy] = useState(false);

  const currency = settings?.currencyCode ?? 'GBP';
  const money = useMemo(
    () => new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 2 }),
    [currency],
  );

  const reload = useCallback(async () => {
    if (!accessToken || !locationId) return;
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, costsRes, effectiveRes] = await Promise.all([
        getLocationRecordSettings(accessToken, locationId),
        listLocationFixedCosts(accessToken, locationId),
        getEffectiveFixedCosts(accessToken, { locationId }),
      ]);
      setSettings(settingsRes.settings);
      setFixedCosts(costsRes.fixedCosts);
      setMonthlyTotal(effectiveRes.monthlyEquivalentTotal);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load location settings');
    } finally {
      setLoading(false);
    }
  }, [accessToken, locationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function patchSettings(patch: Partial<LocationRecordSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function patchHours(weekday: number, patch: Partial<LocationOpeningHoursEntry>) {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            openingHours: prev.openingHours.map((entry) =>
              entry.weekday === weekday ? { ...entry, ...patch } : entry,
            ),
          }
        : prev,
    );
  }

  async function saveSettings() {
    if (!accessToken || !settings || !locationId) return;
    if (settings.payrollCriticalPercent < settings.payrollWarningPercent) {
      setError('Payroll critical % must be greater than or equal to the warning %.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await updateLocationRecordSettings(accessToken, {
        locationId,
        openingHours: settings.openingHours,
        chairCount: settings.chairCount,
        appointmentSlotMinutes: settings.appointmentSlotMinutes,
        defaultDepositType: settings.defaultDepositType,
        defaultDepositValue: settings.defaultDepositValue,
        discountAuthorisationThresholdPercent: settings.discountAuthorisationThresholdPercent,
        cashVarianceThresholdAmount: settings.cashVarianceThresholdAmount,
        colourMarginTargetPercent: settings.colourMarginTargetPercent,
        wasteAllowancePercent: settings.wasteAllowancePercent,
        rebookRateBenchmarkPercent: settings.rebookRateBenchmarkPercent,
        utilisationWarningThresholdPercent: settings.utilisationWarningThresholdPercent,
        payrollWarningPercent: settings.payrollWarningPercent,
        payrollCriticalPercent: settings.payrollCriticalPercent,
        sundayReportEnabled: settings.sundayReportEnabled,
        sundayReportRecipients: settings.sundayReportRecipients,
        sundayReportSendHour: settings.sundayReportSendHour,
      });
      setSettings(res.settings);
      setNotice('Settings saved.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to save settings');
    } finally {
      setSaving(false);
    }
  }

  function startEditCost(cost: LocationFixedCost) {
    setEditingCostId(cost.id);
    setCostError(null);
    setCostForm({
      category: cost.category,
      label: cost.label ?? '',
      amount: String(cost.amount),
      cadence: cost.cadence,
      effectiveFrom: cost.effectiveFrom,
      effectiveTo: cost.effectiveTo ?? '',
      notes: cost.notes ?? '',
    });
  }

  function resetCostForm() {
    setEditingCostId(null);
    setCostForm(emptyFixedCostForm());
    setCostError(null);
  }

  async function submitCost() {
    if (!accessToken || !locationId) return;
    const amount = Number.parseFloat(costForm.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      setCostError('Enter a valid amount.');
      return;
    }
    if (!costForm.effectiveFrom) {
      setCostError('Effective-from date is required.');
      return;
    }
    if (costForm.effectiveTo && costForm.effectiveTo <= costForm.effectiveFrom) {
      setCostError('Effective-to must be after effective-from.');
      return;
    }
    setCostBusy(true);
    setCostError(null);
    try {
      if (editingCostId) {
        await updateLocationFixedCost(accessToken, editingCostId, {
          category: costForm.category,
          label: costForm.label.trim() || null,
          amount,
          cadence: costForm.cadence,
          effectiveFrom: costForm.effectiveFrom,
          effectiveTo: costForm.effectiveTo || null,
          notes: costForm.notes.trim() || null,
        });
      } else {
        await createLocationFixedCost(accessToken, {
          locationId,
          category: costForm.category,
          label: costForm.label.trim() || null,
          amount,
          cadence: costForm.cadence,
          effectiveFrom: costForm.effectiveFrom,
          effectiveTo: costForm.effectiveTo || null,
          notes: costForm.notes.trim() || null,
        });
      }
      resetCostForm();
      await reload();
    } catch (err) {
      setCostError(err instanceof ApiRequestError ? err.message : 'Unable to save fixed cost');
    } finally {
      setCostBusy(false);
    }
  }

  async function removeCost(id: string) {
    if (!accessToken) return;
    setCostBusy(true);
    try {
      await deleteLocationFixedCost(accessToken, id);
      if (editingCostId === id) resetCostForm();
      await reload();
    } catch (err) {
      setCostError(err instanceof ApiRequestError ? err.message : 'Unable to delete fixed cost');
    } finally {
      setCostBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <nav className="mb-4 flex items-center gap-2 text-[13px] text-text-secondary">
        <Link to="/locations" className="hover:text-text-primary transition-colors">Locations</Link>
        <span className="text-text-muted">/</span>
        {locationId ? (
          <Link to={`/locations/${locationId}`} className="hover:text-text-primary transition-colors">
            Location
          </Link>
        ) : null}
        <span className="text-text-muted">/</span>
        <span className="text-text-primary">Record &amp; reporting settings</span>
      </nav>

      <header className="mb-5">
        <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Record &amp; reporting settings</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          Operating details, policy thresholds, reporting targets and fixed costs that power reports and the P&amp;L.
        </p>
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {notice}
        </div>
      ) : null}

      {loading || !settings ? (
        <div className="rounded-card-lg border border-border bg-surface px-5 py-10 text-center text-[13px] text-text-secondary">
          Loading settings…
        </div>
      ) : (
        <div className="space-y-5">
          {/* Opening hours */}
          <Section title="Opening hours" subtitle="Trading hours used by utilisation and reporting.">
            <div className="space-y-2">
              {[1, 2, 3, 4, 5, 6, 0].map((weekday) => {
                const entry =
                  settings.openingHours.find((item) => item.weekday === weekday) ?? {
                    weekday,
                    isOpen: false,
                    opensAt: '09:00',
                    closesAt: '18:00',
                  };
                return (
                  <div key={weekday} className="flex flex-wrap items-center gap-3">
                    <label className="flex w-32 items-center gap-2 text-[13px] text-text-primary">
                      <input
                        type="checkbox"
                        checked={entry.isOpen}
                        onChange={(e) => patchHours(weekday, { isOpen: e.target.checked })}
                      />
                      {WEEKDAY_LABELS[weekday]}
                    </label>
                    <input
                      type="time"
                      value={entry.opensAt}
                      disabled={!entry.isOpen}
                      onChange={(e) => patchHours(weekday, { opensAt: e.target.value })}
                      className={`${FIELD} w-32 disabled:opacity-50`}
                    />
                    <span className="text-text-muted">to</span>
                    <input
                      type="time"
                      value={entry.closesAt}
                      disabled={!entry.isOpen}
                      onChange={(e) => patchHours(weekday, { closesAt: e.target.value })}
                      className={`${FIELD} w-32 disabled:opacity-50`}
                    />
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Capacity & booking */}
          <Section title="Capacity & booking" subtitle="Chairs and default booking behaviour.">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Working chairs"
                value={settings.chairCount}
                min={0}
                onChange={(v) => patchSettings({ chairCount: v })}
              />
              <NumberField
                label="Appointment slot (minutes)"
                value={settings.appointmentSlotMinutes}
                min={1}
                onChange={(v) => patchSettings({ appointmentSlotMinutes: v })}
              />
              <div>
                <label className={LABEL}>Default deposit</label>
                <select
                  className={FIELD}
                  value={settings.defaultDepositType}
                  onChange={(e) =>
                    patchSettings({
                      defaultDepositType: e.target.value as LocationRecordSettings['defaultDepositType'],
                    })
                  }
                >
                  <option value="none">None</option>
                  <option value="fixed_amount">Fixed amount</option>
                  <option value="percentage">Percentage</option>
                </select>
              </div>
              <NumberField
                label={settings.defaultDepositType === 'percentage' ? 'Deposit value (%)' : 'Deposit value'}
                value={settings.defaultDepositValue}
                min={0}
                disabled={settings.defaultDepositType === 'none'}
                onChange={(v) => patchSettings({ defaultDepositValue: v })}
              />
            </div>
          </Section>

          {/* Policy thresholds */}
          <Section title="Policy thresholds" subtitle="Guardrails enforced at the till.">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Discount authorisation threshold (%)"
                value={settings.discountAuthorisationThresholdPercent}
                min={0}
                max={100}
                onChange={(v) => patchSettings({ discountAuthorisationThresholdPercent: v })}
              />
              <NumberField
                label={`Cash variance threshold (${currency})`}
                value={settings.cashVarianceThresholdAmount}
                min={0}
                onChange={(v) => patchSettings({ cashVarianceThresholdAmount: v })}
              />
            </div>
          </Section>

          {/* Reporting targets */}
          <Section title="Reporting targets & warnings" subtitle="Benchmarks used by dashboards and the Sunday Night Report.">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Colour margin target (%)"
                value={settings.colourMarginTargetPercent}
                min={0}
                max={100}
                onChange={(v) => patchSettings({ colourMarginTargetPercent: v })}
              />
              <NumberField
                label="Waste allowance (%)"
                value={settings.wasteAllowancePercent}
                min={0}
                max={100}
                onChange={(v) => patchSettings({ wasteAllowancePercent: v })}
              />
              <NumberField
                label="Rebook-rate benchmark (%)"
                value={settings.rebookRateBenchmarkPercent}
                min={0}
                max={100}
                onChange={(v) => patchSettings({ rebookRateBenchmarkPercent: v })}
              />
              <NumberField
                label="Utilisation warning threshold (%)"
                value={settings.utilisationWarningThresholdPercent}
                min={0}
                max={100}
                onChange={(v) => patchSettings({ utilisationWarningThresholdPercent: v })}
              />
              <NumberField
                label="Payroll warning (% of revenue)"
                value={settings.payrollWarningPercent}
                min={0}
                max={100}
                onChange={(v) => patchSettings({ payrollWarningPercent: v })}
              />
              <NumberField
                label="Payroll critical (% of revenue)"
                value={settings.payrollCriticalPercent}
                min={0}
                max={100}
                onChange={(v) => patchSettings({ payrollCriticalPercent: v })}
              />
            </div>
          </Section>

          {/* Sunday Night Report */}
          <Section title="Sunday Night Report" subtitle="Weekly summary emailed to the recipients below.">
            <label className="mb-3 flex items-center gap-2 text-[13px] text-text-primary">
              <input
                type="checkbox"
                checked={settings.sundayReportEnabled}
                onChange={(e) => patchSettings({ sundayReportEnabled: e.target.checked })}
              />
              Send the Sunday Night Report
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={LABEL}>Recipients (one email per line)</label>
                <textarea
                  className={`${FIELD} min-h-[80px] font-mono`}
                  value={settings.sundayReportRecipients.join('\n')}
                  onChange={(e) =>
                    patchSettings({
                      sundayReportRecipients: e.target.value
                        .split(/[\n,]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
              <NumberField
                label="Send hour (0-23, local)"
                value={settings.sundayReportSendHour}
                min={0}
                max={23}
                onChange={(v) => patchSettings({ sundayReportSendHour: v })}
              />
            </div>
          </Section>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={saveSettings}
              disabled={saving}
              className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-6 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>

          {/* Fixed costs */}
          <Section
            title="Fixed costs (effective-dated)"
            subtitle="Overheads the P&L reads. Effective-dating keeps historical reports accurate when a cost changes."
          >
            <div className="mb-4 rounded-input-lg border border-border bg-surface-alt px-4 py-3 text-[13px] text-text-secondary">
              Current monthly-equivalent total:{' '}
              <span className="font-semibold text-text-primary">{money.format(monthlyTotal)}</span>
            </div>

            {fixedCosts.length === 0 ? (
              <p className="mb-4 text-[13px] text-text-secondary">No fixed costs recorded yet.</p>
            ) : (
              <div className="mb-4 overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="text-text-muted">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Category</th>
                      <th className="px-2 py-1.5 font-medium">Amount</th>
                      <th className="px-2 py-1.5 font-medium">Monthly eq.</th>
                      <th className="px-2 py-1.5 font-medium">Effective</th>
                      <th className="px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {fixedCosts.map((cost) => (
                      <tr key={cost.id} className="border-t border-border">
                        <td className="px-2 py-2 text-text-primary">
                          {FIXED_COST_CATEGORY_LABELS[cost.category]}
                          {cost.label ? <span className="text-text-muted"> · {cost.label}</span> : null}
                        </td>
                        <td className="px-2 py-2 text-text-primary">
                          {money.format(cost.amount)}{' '}
                          <span className="text-text-muted">/ {FIXED_COST_CADENCE_LABELS[cost.cadence].toLowerCase()}</span>
                        </td>
                        <td className="px-2 py-2 text-text-secondary">
                          {money.format(monthlyEquivalentFixedCost(cost.amount, cost.cadence))}
                        </td>
                        <td className="px-2 py-2 text-text-secondary">
                          {cost.effectiveFrom} → {cost.effectiveTo ?? 'ongoing'}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => startEditCost(cost)}
                            className="mr-3 text-primary hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => removeCost(cost.id)}
                            disabled={costBusy}
                            className="text-danger hover:underline disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Add / edit form */}
            <div className="rounded-input-lg border border-border bg-surface-alt p-4">
              <h3 className="mb-3 text-[13px] font-semibold text-text-primary">
                {editingCostId ? 'Edit fixed cost' : 'Add fixed cost'}
              </h3>
              {costError ? (
                <div className="mb-3 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[12px] text-danger">
                  {costError}
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL}>Category</label>
                  <select
                    className={FIELD}
                    value={costForm.category}
                    onChange={(e) => setCostForm({ ...costForm, category: e.target.value as FixedCostCategory })}
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {FIXED_COST_CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Label (optional)</label>
                  <input
                    className={FIELD}
                    value={costForm.label}
                    onChange={(e) => setCostForm({ ...costForm, label: e.target.value })}
                  />
                </div>
                <div>
                  <label className={LABEL}>Amount ({currency})</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className={FIELD}
                    value={costForm.amount}
                    onChange={(e) => setCostForm({ ...costForm, amount: e.target.value })}
                  />
                </div>
                <div>
                  <label className={LABEL}>Cadence</label>
                  <select
                    className={FIELD}
                    value={costForm.cadence}
                    onChange={(e) => setCostForm({ ...costForm, cadence: e.target.value as FixedCostCadence })}
                  >
                    {CADENCES.map((cad) => (
                      <option key={cad} value={cad}>
                        {FIXED_COST_CADENCE_LABELS[cad]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Effective from</label>
                  <input
                    type="date"
                    className={FIELD}
                    value={costForm.effectiveFrom}
                    onChange={(e) => setCostForm({ ...costForm, effectiveFrom: e.target.value })}
                  />
                </div>
                <div>
                  <label className={LABEL}>Effective to (optional)</label>
                  <input
                    type="date"
                    className={FIELD}
                    value={costForm.effectiveTo}
                    onChange={(e) => setCostForm({ ...costForm, effectiveTo: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={LABEL}>Notes (optional)</label>
                  <input
                    className={FIELD}
                    value={costForm.notes}
                    onChange={(e) => setCostForm({ ...costForm, notes: e.target.value })}
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={submitCost}
                  disabled={costBusy}
                  className="inline-flex h-9 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
                >
                  {editingCostId ? 'Update cost' : 'Add cost'}
                </button>
                {editingCostId ? (
                  <button
                    type="button"
                    onClick={resetCostForm}
                    className="inline-flex h-9 items-center justify-center rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card-lg border border-border bg-surface px-5 py-5">
      <h2 className="text-[14px] font-semibold text-text-primary">{title}</h2>
      {subtitle ? (
        <p className="mb-4 mt-0.5 text-[13px] text-text-secondary">{subtitle}</p>
      ) : (
        <div className="mb-4" />
      )}
      {children}
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      <input
        type="number"
        className={`${FIELD} disabled:opacity-50`}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step="0.01"
        disabled={disabled}
        onChange={(e) => {
          const parsed = Number.parseFloat(e.target.value);
          onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
      />
    </div>
  );
}
