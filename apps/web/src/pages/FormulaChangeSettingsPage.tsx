import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormulaChangeSettingsResponse, FormulaChangeThresholds } from '@sheer/domain';
import { FORMULA_CHANGE_BOUNDS, validateFormulaChangeThresholds } from '@sheer/domain';
import { AppButton, AppCard } from '../design';
import { ApiRequestError, getFormulaChangeSettings, saveFormulaChangeSettings } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

/**
 * Formula change sensitivity (Wrike 4507283774, section 21).
 *
 * Three numbers and a Save button. No mathematical vocabulary reaches this
 * screen — an owner reads "Flag when the formula composition changes by at least
 * 30%", never "L1 distance" or "basis points" — and every field carries a
 * worked example so the setting means something before it is changed.
 *
 * Scope follows the platform's settings convention: a business-wide default plus
 * optional per-location overrides, where a location override replaces the
 * business row outright rather than blending with it.
 */
export function FormulaChangeSettingsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const user = auth.user;

  const [settings, setSettings] = useState<FormulaChangeSettingsResponse | null>(null);
  const [scopeId, setScopeId] = useState<string>(''); // '' = business-wide
  const [form, setForm] = useState<FormulaChangeThresholds | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const locations = useMemo(() => user?.locations ?? [], [user]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const result = await getFormulaChangeSettings(accessToken);
      setSettings(result);
      setError(null);
    } catch (err) {
      setError(toMessage(err, 'Could not load formula change settings'));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  // Whenever the chosen scope changes, show the values actually in force for it:
  // its own row if configured, otherwise the values it inherits.
  useEffect(() => {
    if (!settings) return;
    const target = scopeId || null;
    const configured = settings.scopes.find((scope) => scope.locationId === target);
    const business = settings.scopes.find((scope) => scope.locationId === null);
    const source = configured ?? business;
    setForm({
      compositionChangePercent: source?.compositionChangePercent ?? settings.defaults.compositionChangePercent,
      componentMaterialityPercent:
        source?.componentMaterialityPercent ?? settings.defaults.componentMaterialityPercent,
      developerVolumeDelta: source?.developerVolumeDelta ?? settings.defaults.developerVolumeDelta,
    });
  }, [settings, scopeId]);

  const isConfigured = Boolean(settings?.scopes.find((scope) => scope.locationId === (scopeId || null))?.configured);

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !form) return;

    // Validated with the SAME function the API uses, so the form and the server
    // can never disagree about what is allowed.
    const problems = validateFormulaChangeThresholds(form);
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await saveFormulaChangeSettings(accessToken, { ...form, locationId: scopeId || null });
      setSettings(result);
      setMessage('Sensitivity saved. It applies to every formula comparison from now on.');
    } catch (err) {
      setError(toMessage(err, 'Could not save formula change settings'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text-primary">Formula change sensitivity</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          QLOOQO compares each client&apos;s latest colour formula with their previous comparable one
          and flags meaningful changes for the stylist. These settings decide what counts as
          meaningful. A change is flagged if <em>any</em> of the rules below is met.
        </p>
      </header>

      {error ? (
        <div className="rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-lg bg-success-soft px-4 py-3 text-sm text-success" role="status">
          {message}
        </div>
      ) : null}

      {loading || !form ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : (
        <AppCard>
          <form className="space-y-6" onSubmit={handleSave}>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-text-primary">Applies to</span>
              <select
                className={INPUT}
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
              >
                <option value="">All locations (default)</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-text-secondary">
                {scopeId
                  ? isConfigured
                    ? 'This location has its own settings. They replace the default entirely.'
                    : 'This location currently follows the default. Saving gives it its own settings.'
                  : 'Used by every location that does not have its own settings.'}
              </span>
            </label>

            <Setting
              label="Formula composition"
              value={form.compositionChangePercent}
              bounds={FORMULA_CHANGE_BOUNDS.compositionChangePercent}
              suffix="%"
              onChange={(value) => setForm({ ...form, compositionChangePercent: value })}
              lead="Flag when the formula composition changes by at least"
              help="Small ratio adjustments stay unflagged; major product swaps are flagged. Mixing a bigger batch of exactly the same recipe never counts as a change."
              example={`At ${form.compositionChangePercent}%: 50/50 → 48/52 is not flagged; swapping half the mix for a different product is.`}
            />

            <Setting
              label="Material product component"
              value={form.componentMaterialityPercent}
              bounds={FORMULA_CHANGE_BOUNDS.componentMaterialityPercent}
              suffix="%"
              onChange={(value) => setForm({ ...form, componentMaterialityPercent: value })}
              lead="Only flag a product being added or removed when it is at least"
              help="Of the mix. A small additive coming or going is not a reformulation on its own."
              example={`At ${form.componentMaterialityPercent}%: dropping a 2% bond builder is not flagged on its own; dropping a ${form.componentMaterialityPercent}% component is.`}
            />

            <Setting
              label="Developer strength"
              value={form.developerVolumeDelta}
              bounds={FORMULA_CHANGE_BOUNDS.developerVolumeDelta}
              suffix="vol"
              onChange={(value) => setForm({ ...form, developerVolumeDelta: value })}
              lead="Flag when the developer changes by at least"
              help="Compared using the strongest developer in the mix. Only applies when the developer strength is recorded on the formula."
              example={`At ${form.developerVolumeDelta} vol: 20 vol → ${20 + form.developerVolumeDelta} vol is flagged.`}
            />

            <div className="rounded-lg bg-surface-alt px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                Not compared
              </p>
              <p className="mt-1 text-[13px] text-text-secondary">
                Colour level and tone are not recorded as structured data in QLOOQO, so they are not
                part of this comparison. The flag always says what it was based on.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <AppButton type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </AppButton>
            </div>
          </form>
        </AppCard>
      )}
    </div>
  );
}

function Setting({
  label,
  lead,
  value,
  bounds,
  suffix,
  help,
  example,
  onChange,
}: {
  label: string;
  lead: string;
  value: number;
  bounds: { min: number; max: number };
  suffix: string;
  help: string;
  example: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-text-primary">{label}</p>
      <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
        <span>{lead}</span>
        <input
          className={`${INPUT} w-24`}
          type="number"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={label}
        />
        <span>{suffix}</span>
      </div>
      <p className="text-xs text-text-secondary">{help}</p>
      <p className="text-xs text-text-muted">{example}</p>
    </div>
  );
}

const INPUT =
  'rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary';

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
