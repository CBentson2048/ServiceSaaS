import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OperationalSignalThresholds } from '@sheer/domain';
import { OPERATIONAL_SIGNAL_BOUNDS, validateOperationalSignalThresholds } from '@sheer/domain';
import { AppButton, AppCard } from '../design';
import {
  ApiRequestError,
  getOperationalSignalSettings,
  saveOperationalSignalSettings,
  type OperationalSignalSettingsResponse,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

/**
 * Sensitivity for the four operational signals (Wrike 4507283793, section 43).
 *
 * Ten numbers, grouped by the signal they govern, each with a sentence a salon
 * owner can read. No mathematical vocabulary reaches this screen. Scope follows
 * the platform convention: a business-wide default plus optional per-location
 * overrides, where a location override replaces the business row whole.
 */
export function OperationalSignalSettingsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const user = auth.user;

  const [settings, setSettings] = useState<OperationalSignalSettingsResponse | null>(null);
  const [scopeId, setScopeId] = useState('');
  const [form, setForm] = useState<OperationalSignalThresholds | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const locations = useMemo(() => user?.locations ?? [], [user]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      setSettings(await getOperationalSignalSettings(accessToken));
      setError(null);
    } catch (err) {
      setError(toMessage(err, 'Could not load intelligence settings'));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  // Show the values actually in force for the chosen scope: its own row when
  // configured, otherwise the values it inherits.
  useEffect(() => {
    if (!settings) return;
    const target = scopeId || null;
    const source =
      settings.scopes.find((scope) => scope.locationId === target) ??
      settings.scopes.find((scope) => scope.locationId === null);
    setForm({
      spend: { ...(source?.spend ?? settings.defaults.spend) },
      noShow: { ...(source?.noShow ?? settings.defaults.noShow) },
      colour: { ...(source?.colour ?? settings.defaults.colour) },
      slotGap: { ...(source?.slotGap ?? settings.defaults.slotGap) },
    });
  }, [settings, scopeId]);

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !form) return;
    // Validated with the SAME function the API uses, so the form and the server
    // can never disagree about what is allowed.
    const problems = validateOperationalSignalThresholds(form);
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      setSettings(await saveOperationalSignalSettings(accessToken, { ...form, locationId: scopeId || null }));
      setMessage('Saved. Signals are recomputed on every read, so this applies immediately.');
    } catch (err) {
      setError(toMessage(err, 'Could not save intelligence settings'));
    } finally {
      setSaving(false);
    }
  }

  const set = <G extends keyof OperationalSignalThresholds>(
    group: G,
    key: keyof OperationalSignalThresholds[G],
    value: number,
  ) => form && setForm({ ...form, [group]: { ...form[group], [key]: value } });

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text-primary">Intelligence sensitivity</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          QLOOQO watches four things for you: how a client&apos;s spend is trending, whether they
          have a pattern of missed appointments, whether two colour clients are stacked on one
          stylist, and where a diary has unbooked time between appointments. These settings decide
          what counts as worth telling you about.
        </p>
      </header>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {message ? <Banner tone="success">{message}</Banner> : null}

      {loading || !form ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : (
        <AppCard>
          <form className="space-y-6" onSubmit={handleSave}>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-text-primary">Applies to</span>
              <select className={INPUT} value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                <option value="">All locations (default)</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>

            <Section title="Client spend">
              <Row
                lead="Compare the last"
                suffix="visits with the ones before"
                value={form.spend.windowVisits}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.spendWindowVisits}
                onChange={(v) => set('spend', 'windowVisits', v)}
                help={`A trend needs ${form.spend.windowVisits * 2} settled visits before anything is claimed.`}
              />
              <Row
                lead="Flag when the average per visit moves by at least"
                suffix="%"
                value={form.spend.materialityPercent}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.spendMaterialityPercent}
                onChange={(v) => set('spend', 'materialityPercent', v)}
                help="Compares the value of a visit, not how often they come — those are shown separately."
              />
            </Section>

            <Section title="Missed appointments">
              <Row
                lead="Look back over the last"
                suffix="days"
                value={form.noShow.lookbackDays}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.noShowLookbackDays}
                onChange={(v) => set('noShow', 'lookbackDays', v)}
                help="Older history ages out rather than following a client forever."
              />
              <Row
                lead="Only judge a rate once there are at least"
                suffix="appointments"
                value={form.noShow.minimumRelevantAppointments}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.noShowMinimumRelevantAppointments}
                onChange={(v) => set('noShow', 'minimumRelevantAppointments', v)}
                help="Stops one miss out of one appointment reading as a 100% problem."
              />
              <Row
                lead="Worth noting at a no-show rate of"
                suffix="%"
                value={form.noShow.mediumRatePercent}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.noShowMediumRatePercent}
                onChange={(v) => set('noShow', 'mediumRatePercent', v)}
              />
              <Row
                lead="Repeat pattern at a no-show rate of"
                suffix="%"
                value={form.noShow.highRatePercent}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.noShowHighRatePercent}
                onChange={(v) => set('noShow', 'highRatePercent', v)}
              />
              <Row
                lead="…or after"
                suffix="no-shows, whatever the rate"
                value={form.noShow.highNoShowCount}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.noShowHighNoShowCount}
                onChange={(v) => set('noShow', 'highNoShowCount', v)}
              />
              <Row
                lead="Note after"
                suffix="cancellations made inside the notice period"
                value={form.noShow.mediumLateCancellationCount}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.noShowMediumLateCancellationCount}
                onChange={(v) => set('noShow', 'mediumLateCancellationCount', v)}
                help="Counted separately from no-shows — the client did tell you, just late."
              />
            </Section>

            <Section title="Colour sequencing">
              <Row
                lead="Warn when two colour clients on one stylist have less than"
                suffix="minutes between them"
                value={form.colour.minimumBufferMinutes}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.colourMinimumBufferMinutes}
                onChange={(v) => set('colour', 'minimumBufferMinutes', v)}
                help="Measured against time the stylist is actually busy, so colour development counts as free."
              />
            </Section>

            <Section title="Diary gaps">
              <Row
                lead="Show unbooked gaps of at least"
                suffix="minutes"
                value={form.slotGap.minimumGapMinutes}
                bounds={OPERATIONAL_SIGNAL_BOUNDS.slotGapMinimumGapMinutes}
                onChange={(v) => set('slotGap', 'minimumGapMinutes', v)}
                help="Breaks, leave and book-outs are never counted as gaps."
              />
            </Section>

            <AppButton type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </AppButton>
          </form>
        </AppCard>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({
  lead,
  suffix,
  value,
  bounds,
  onChange,
  help,
}: {
  lead: string;
  suffix: string;
  value: number;
  bounds: { min: number; max: number };
  onChange: (value: number) => void;
  help?: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
        <span>{lead}</span>
        <input
          className={`${INPUT} w-20`}
          type="number"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={lead}
        />
        <span>{suffix}</span>
      </div>
      {help ? <p className="text-xs text-text-muted">{help}</p> : null}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'danger' | 'success'; children: React.ReactNode }) {
  const cls = tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success';
  return (
    <div className={`rounded-lg px-4 py-3 text-sm ${cls}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
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
