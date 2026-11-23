import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ListServiceCategoriesResponse,
  ListManagedServicesResponse,
  UpsellRuleDetail,
  UpsellRuleTriggerType,
  UpsertUpsellRuleRequest,
} from '@sheer/domain';
import { AppButton, AppCard, StatusBadge } from '../design';
import {
  ApiRequestError,
  createUpsellRule,
  deleteUpsellRule,
  listServiceCategories,
  listServices,
  listUpsellRules,
  updateUpsellRule,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

/**
 * Owner configuration for suggested add-ons — "when X is booked, suggest Y".
 *
 * Deliberately a list plus one small form, not a workflow builder. A salon
 * owner has to be able to read a row and know exactly what it does, so every
 * rule renders as one sentence: trigger, add-on, where it applies, and whether
 * it is on. The scoring, thresholds and precedence behind the suggestions are
 * NOT exposed here; they would be noise to the person configuring this.
 */
export function UpsellRulesPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const user = auth.user;

  const [rules, setRules] = useState<UpsellRuleDetail[]>([]);
  const [services, setServices] = useState<ListManagedServicesResponse['services']>([]);
  const [categories, setCategories] = useState<ListServiceCategoriesResponse['categories']>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const locations = useMemo(() => user?.locations ?? [], [user]);
  const activeServices = useMemo(() => services.filter((service) => service.isActive), [services]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const [rulesResult, servicesResult, categoriesResult] = await Promise.all([
        listUpsellRules(accessToken),
        listServices(accessToken, {}),
        listServiceCategories(accessToken, {}),
      ]);
      setRules(rulesResult.rules);
      setServices(servicesResult.services);
      setCategories(categoriesResult.categories);
      setError(null);
    } catch (err) {
      setError(toMessage(err, 'Could not load add-on rules'));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload: UpsertUpsellRuleRequest = {
        name: form.name.trim(),
        locationId: form.locationId || null,
        triggerType: form.triggerType,
        // Only the id matching the chosen trigger type is sent; the server
        // normalises again, but sending a stale one would be a confusing 400.
        triggerServiceId: form.triggerType === 'service' ? form.triggerServiceId : null,
        triggerServiceCategoryId:
          form.triggerType === 'service_category' ? form.triggerServiceCategoryId : null,
        suggestedServiceId: form.suggestedServiceId,
        priority: Number(form.priority) || 0,
      };
      await createUpsellRule(accessToken, payload);
      setMessage('Add-on rule created.');
      setForm(emptyForm());
      await load();
    } catch (err) {
      setError(toMessage(err, 'Could not save the add-on rule'));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(rule: UpsellRuleDetail) {
    if (!accessToken) return;
    setBusyId(rule.id);
    setError(null);
    setMessage(null);
    try {
      await updateUpsellRule(accessToken, rule.id, { enabled: !rule.enabled });
      setMessage(
        rule.enabled
          ? `Turned off — ${rule.suggestedServiceName} will no longer be suggested here.`
          : `Turned on — ${rule.suggestedServiceName} will be suggested again.`,
      );
      await load();
    } catch (err) {
      setError(toMessage(err, 'Could not change the rule'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(rule: UpsellRuleDetail) {
    if (!accessToken) return;
    if (!window.confirm(`Delete the rule "${rule.name}"?`)) return;
    setBusyId(rule.id);
    setError(null);
    setMessage(null);
    try {
      await deleteUpsellRule(accessToken, rule.id);
      setMessage('Add-on rule deleted.');
      await load();
    } catch (err) {
      setError(toMessage(err, 'Could not delete the rule'));
    } finally {
      setBusyId(null);
    }
  }

  const canSubmit =
    form.name.trim().length > 0 &&
    form.suggestedServiceId.length > 0 &&
    (form.triggerType === 'service' ? form.triggerServiceId : form.triggerServiceCategoryId).length > 0 &&
    !saving;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-[20px] font-semibold text-text-primary">Suggested add-ons</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-text-secondary">
          Tell Service SaaS which add-on to suggest when a service is booked. Staff see the suggestion at
          booking and at checkout and choose whether to add it — nothing is ever added automatically.
          Turning a rule off also stops that add-on being suggested from booking history.
        </p>
      </header>

      {error ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {message}
        </div>
      ) : null}

      <AppCard padding="lg" elevation="card">
        <h2 className="mb-3 text-[15px] font-semibold text-text-primary">Add a rule</h2>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={handleSave}>
          <Field label="Rule name">
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Colour to Toner"
              maxLength={120}
              className={INPUT}
            />
          </Field>

          <Field label="Trigger type">
            <select
              value={form.triggerType}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  triggerType: event.target.value as UpsellRuleTriggerType,
                }))
              }
              className={INPUT}
            >
              <option value="service">A specific service</option>
              <option value="service_category">Any service in a category</option>
            </select>
          </Field>

          {form.triggerType === 'service' ? (
            <Field label="When this service is booked">
              <select
                value={form.triggerServiceId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, triggerServiceId: event.target.value }))
                }
                className={INPUT}
              >
                <option value="">Choose a service…</option>
                {activeServices.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="When any service in this category is booked">
              <select
                value={form.triggerServiceCategoryId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, triggerServiceCategoryId: event.target.value }))
                }
                className={INPUT}
              >
                <option value="">Choose a category…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Suggest this add-on">
            <select
              value={form.suggestedServiceId}
              onChange={(event) =>
                setForm((current) => ({ ...current, suggestedServiceId: event.target.value }))
              }
              className={INPUT}
            >
              <option value="">Choose a service…</option>
              {activeServices
                // A service cannot suggest itself — the server and the database
                // both reject it, so it is not offered in the first place.
                .filter((service) => service.id !== form.triggerServiceId)
                .map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
            </select>
          </Field>

          <Field label="Applies at">
            <select
              value={form.locationId}
              onChange={(event) => setForm((current) => ({ ...current, locationId: event.target.value }))}
              className={INPUT}
            >
              <option value="">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Priority (0–1000, higher shows first)">
            <input
              type="number"
              min={0}
              max={1000}
              value={form.priority}
              onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))}
              className={INPUT}
            />
          </Field>

          <div className="md:col-span-2">
            <AppButton type="submit" variant="primary" loading={saving} disabled={!canSubmit}>
              Create rule
            </AppButton>
          </div>
        </form>
      </AppCard>

      <AppCard padding="lg" elevation="card">
        <h2 className="mb-3 text-[15px] font-semibold text-text-primary">Rules</h2>
        {loading ? (
          <p className="text-[13px] text-text-secondary">Loading add-on rules…</p>
        ) : rules.length === 0 ? (
          <p className="text-[13px] text-text-secondary">
            No add-on rules yet. Service SaaS can still suggest add-ons that are frequently booked together.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-input-lg border border-border bg-surface px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-text-primary">{rule.name}</p>
                  <p className="text-[12px] text-text-secondary">
                    When{' '}
                    <strong className="font-medium">
                      {rule.triggerType === 'service'
                        ? (rule.triggerServiceName ?? 'a service')
                        : `any ${rule.triggerServiceCategoryName ?? 'category'} service`}
                    </strong>{' '}
                    is booked → suggest{' '}
                    <strong className="font-medium">{rule.suggestedServiceName}</strong>
                  </p>
                  <p className="text-[11px] text-text-tertiary">
                    {rule.locationName ? rule.locationName : 'All locations'} · priority {rule.priority}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge
                    label={rule.enabled ? 'Enabled' : 'Disabled'}
                    tone={rule.enabled ? 'success' : 'neutral'}
                  />
                  <AppButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={busyId === rule.id}
                    onClick={() => void handleToggle(rule)}
                  >
                    {rule.enabled ? 'Turn off' : 'Turn on'}
                  </AppButton>
                  <AppButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busyId === rule.id}
                    onClick={() => void handleDelete(rule)}
                  >
                    Delete
                  </AppButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AppCard>
    </div>
  );
}

const INPUT =
  'mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20';

interface FormState {
  name: string;
  locationId: string;
  triggerType: UpsellRuleTriggerType;
  triggerServiceId: string;
  triggerServiceCategoryId: string;
  suggestedServiceId: string;
  priority: string;
}

function emptyForm(): FormState {
  return {
    name: '',
    locationId: '',
    triggerType: 'service',
    triggerServiceId: '',
    triggerServiceCategoryId: '',
    suggestedServiceId: '',
    priority: '0',
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      {children}
    </label>
  );
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message || fallback;
  return err instanceof Error ? err.message : fallback;
}
