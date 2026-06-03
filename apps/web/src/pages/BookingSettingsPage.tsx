import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import type {
  LocationCommunicationSettings,
  OwnerBookingService,
  OwnerBookingSettingsResponse,
  OwnerServiceRequirementRule,
  OwnerServiceUpgradeSuggestion,
  UpsertServiceRequirementRuleRequest,
  UpsertServiceUpgradeSuggestionRequest,
} from '@sheer/domain';
import {
  ApiRequestError,
  createServiceRequirementRule,
  createServiceUpgradeSuggestion,
  deleteServiceRequirementRule,
  deleteServiceUpgradeSuggestion,
  getOwnerBookingSettings,
  updateLocationCommunicationSettings,
  updateServiceRequirementRule,
  updateServiceUpgradeSuggestion,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

type RuleFormState = {
  id?: string;
  locationId: string;
  triggerServiceId: string;
  title: string;
  description: string;
  requiredServiceIds: string[];
  isActive: boolean;
};

type UpgradeFormState = {
  id?: string;
  locationId: string;
  triggerServiceId: string;
  suggestedServiceId: string;
  title: string;
  description: string;
  sortOrder: string;
  isActive: boolean;
};

const GLOBAL_SCOPE = '__global__';

export function BookingSettingsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [searchParams, setSearchParams] = useSearchParams();
  const locationFilter = searchParams.get('locationId') ?? '';
  const [settings, setSettings] = useState<OwnerBookingSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState<RuleFormState>(() => emptyRuleForm());
  const [upgradeForm, setUpgradeForm] = useState<UpgradeFormState>(() => emptyUpgradeForm());

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getOwnerBookingSettings(accessToken, {
        locationId: locationFilter || undefined,
      });
      setSettings(result);
      setRuleForm((current) => ensureRuleDefaults(current, result.services, locationFilter));
      setUpgradeForm((current) => ensureUpgradeDefaults(current, result.services, locationFilter));
    } catch (err) {
      setError(toErrorMessage(err, 'Could not load booking settings'));
    } finally {
      setLoading(false);
    }
  }, [accessToken, locationFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const services = settings?.services ?? [];
  const activeServices = services.filter((service) => service.isActive);
  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);

  if (auth.status === 'authenticated' && auth.user?.role !== 'owner') {
    return <Navigate to="/unauthorized" replace />;
  }

  async function saveRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    const payload: UpsertServiceRequirementRuleRequest = {
      locationId: normalizeLocation(ruleForm.locationId),
      triggerServiceId: ruleForm.triggerServiceId,
      title: ruleForm.title,
      description: ruleForm.description || null,
      requiredServiceIds: ruleForm.requiredServiceIds,
      isActive: ruleForm.isActive,
    };
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (ruleForm.id) await updateServiceRequirementRule(accessToken, ruleForm.id, payload);
      else await createServiceRequirementRule(accessToken, payload);
      setMessage(ruleForm.id ? 'Finishing rule updated.' : 'Finishing rule created.');
      setRuleForm(emptyRuleForm(locationFilter, activeServices[0]?.id));
      await reload();
    } catch (err) {
      setError(toErrorMessage(err, 'Could not save finishing rule'));
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(rule: OwnerServiceRequirementRule) {
    if (!accessToken) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await deleteServiceRequirementRule(accessToken, rule.id);
      setMessage('Finishing rule deleted.');
      await reload();
    } catch (err) {
      setError(toErrorMessage(err, 'Could not delete finishing rule'));
    } finally {
      setSaving(false);
    }
  }

  async function saveUpgrade(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    const payload: UpsertServiceUpgradeSuggestionRequest = {
      locationId: normalizeLocation(upgradeForm.locationId),
      triggerServiceId: upgradeForm.triggerServiceId,
      suggestedServiceId: upgradeForm.suggestedServiceId,
      title: upgradeForm.title,
      description: upgradeForm.description,
      sortOrder: Number(upgradeForm.sortOrder) || 0,
      isActive: upgradeForm.isActive,
    };
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (upgradeForm.id) await updateServiceUpgradeSuggestion(accessToken, upgradeForm.id, payload);
      else await createServiceUpgradeSuggestion(accessToken, payload);
      setMessage(upgradeForm.id ? 'Upgrade prompt updated.' : 'Upgrade prompt created.');
      setUpgradeForm(emptyUpgradeForm(locationFilter, activeServices[0]?.id, activeServices[1]?.id));
      await reload();
    } catch (err) {
      setError(toErrorMessage(err, 'Could not save upgrade prompt'));
    } finally {
      setSaving(false);
    }
  }

  async function removeUpgrade(suggestion: OwnerServiceUpgradeSuggestion) {
    if (!accessToken) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await deleteServiceUpgradeSuggestion(accessToken, suggestion.id);
      setMessage('Upgrade prompt deleted.');
      await reload();
    } catch (err) {
      setError(toErrorMessage(err, 'Could not delete upgrade prompt'));
    } finally {
      setSaving(false);
    }
  }

  function changeLocationFilter(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('locationId', value);
    else next.delete('locationId');
    setSearchParams(next, { replace: true });
    setRuleForm((current) => ({ ...current, locationId: value || GLOBAL_SCOPE }));
    setUpgradeForm((current) => ({ ...current, locationId: value || GLOBAL_SCOPE }));
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <nav className="mb-4 text-[12px] text-text-secondary">
        <Link to="/locations" className="hover:text-text-primary">Locations</Link>
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">Booking settings</span>
      </nav>

      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Booking settings</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Configure mandatory finishing services and upgrade prompts for public booking.
          </p>
        </div>
        <label className="text-[12px] font-medium text-text-secondary">
          Location scope
          <select
            value={locationFilter}
            onChange={(event) => changeLocationFilter(event.target.value)}
            className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary sm:w-72"
          >
            <option value="">All locations / global rules</option>
            {settings?.locations.map((location) => (
              <option key={location.id} value={location.id}>{location.name}</option>
            ))}
          </select>
        </label>
      </header>

      {message ? <Notice tone="success" text={message} /> : null}
      {error ? <Notice tone="danger" text={error} /> : null}

      {loading ? (
        <Panel><Empty title="Loading settings..." body="Fetching services, finishing rules, and upgrade prompts." /></Panel>
      ) : settings ? (
        <>
        <div className="mb-6">
          {accessToken && locationFilter ? (
            <NotificationsSection
              key={locationFilter}
              accessToken={accessToken}
              locationId={locationFilter}
              initial={settings.communicationSettings ?? null}
            />
          ) : (
            <Panel title="WhatsApp Notifications">
              <Empty
                title="Select a location"
                body="Reminder and confirmation rules are configured per location. Choose a location in the scope selector above to manage its WhatsApp notifications."
              />
            </Panel>
          )}
        </div>
        <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-6">
            <Panel title="Service Catalogue">
              <ServiceList services={services} />
            </Panel>
            <RuleForm
              form={ruleForm}
              services={activeServices}
              locations={settings.locations}
              saving={saving}
              onChange={setRuleForm}
              onSubmit={saveRule}
              onCancel={() => setRuleForm(emptyRuleForm(locationFilter, activeServices[0]?.id))}
            />
            <UpgradeForm
              form={upgradeForm}
              services={activeServices}
              locations={settings.locations}
              saving={saving}
              onChange={setUpgradeForm}
              onSubmit={saveUpgrade}
              onCancel={() => setUpgradeForm(emptyUpgradeForm(locationFilter, activeServices[0]?.id, activeServices[1]?.id))}
            />
          </div>
          <div className="space-y-6">
            <Panel title="Mandatory Finishing Rules">
              <RuleList
                rules={settings.requirementRules}
                serviceById={serviceById}
                locationName={(id) => settings.locations.find((location) => location.id === id)?.name}
                onEdit={(rule) => setRuleForm(ruleToForm(rule))}
                onDelete={(rule) => void removeRule(rule)}
              />
            </Panel>
            <Panel title="Upgrade Prompts">
              <UpgradeList
                suggestions={settings.upgradeSuggestions}
                serviceById={serviceById}
                locationName={(id) => settings.locations.find((location) => location.id === id)?.name}
                onEdit={(suggestion) => setUpgradeForm(upgradeToForm(suggestion))}
                onDelete={(suggestion) => void removeUpgrade(suggestion)}
              />
            </Panel>
          </div>
        </div>
        </>
      ) : null}
    </div>
  );
}

function NotificationsSection({
  accessToken,
  locationId,
  initial,
}: {
  accessToken: string;
  locationId: string;
  initial: LocationCommunicationSettings | null;
}) {
  const fallback: LocationCommunicationSettings = {
    locationId,
    enabled: false,
    enabledChannels: ['whatsapp'],
    sendBookingConfirmation: false,
    reminder24hEnabled: false,
    reminder48hEnabled: false,
    reminder1wEnabled: false,
  };
  const [form, setForm] = useState<LocationCommunicationSettings>(initial ?? fallback);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  function set<K extends keyof LocationCommunicationSettings>(key: K, value: LocationCommunicationSettings[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const updated = await updateLocationCommunicationSettings(accessToken, {
        locationId,
        enabled: form.enabled,
        sendBookingConfirmation: form.sendBookingConfirmation,
        reminder24hEnabled: form.reminder24hEnabled,
        reminder48hEnabled: form.reminder48hEnabled,
        reminder1wEnabled: form.reminder1wEnabled,
      });
      setForm(updated);
      setNotice({ tone: 'success', text: 'WhatsApp notification settings saved.' });
    } catch (err) {
      setNotice({ tone: 'danger', text: toErrorMessage(err, 'Could not save notification settings') });
    } finally {
      setSaving(false);
    }
  }

  const remindersDisabled = !form.enabled;

  return (
    <Panel title="WhatsApp Notifications">
      <p className="mb-3 text-[13px] text-text-secondary">
        Confirmations and reminders are sent over WhatsApp to clients whose communication preference is WhatsApp.
        Reminder timings are calculated from the appointment time in the location timezone.
      </p>
      {notice ? <Notice tone={notice.tone} text={notice.text} /> : null}
      <form onSubmit={save} className="space-y-4">
        <Checkbox
          label="Enable WhatsApp notifications for this location"
          checked={form.enabled}
          onChange={(value) => set('enabled', value)}
        />
        <div className={`space-y-3 rounded-input-lg border border-border bg-surface-alt/40 p-3 ${remindersDisabled ? 'opacity-55' : ''}`}>
          <div className="text-[12px] font-medium text-text-secondary">Messages</div>
          <Checkbox
            label="Send a booking confirmation after booking"
            checked={form.sendBookingConfirmation}
            onChange={(value) => set('sendBookingConfirmation', value)}
          />
          <div className="text-[12px] font-medium text-text-secondary pt-1">Reminders before the appointment</div>
          <Checkbox
            label="1 week before"
            checked={form.reminder1wEnabled}
            onChange={(value) => set('reminder1wEnabled', value)}
          />
          <Checkbox
            label="48 hours before"
            checked={form.reminder48hEnabled}
            onChange={(value) => set('reminder48hEnabled', value)}
          />
          <Checkbox
            label="24 hours before"
            checked={form.reminder24hEnabled}
            onChange={(value) => set('reminder24hEnabled', value)}
          />
        </div>
        <div className="flex justify-end">
          <button disabled={saving} className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary disabled:opacity-60">
            {saving ? 'Saving...' : 'Save notifications'}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function RuleForm({
  form,
  services,
  locations,
  saving,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: RuleFormState;
  services: OwnerBookingService[];
  locations: OwnerBookingSettingsResponse['locations'];
  saving: boolean;
  onChange: (form: RuleFormState) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <Panel title={form.id ? 'Edit Finishing Rule' : 'New Finishing Rule'}>
      <form onSubmit={onSubmit} className="space-y-3">
        <ScopeSelect value={form.locationId} locations={locations} onChange={(locationId) => onChange({ ...form, locationId })} />
        <ServiceSelect label="Trigger service" value={form.triggerServiceId} services={services} onChange={(triggerServiceId) => onChange({ ...form, triggerServiceId })} />
        <TextInput label="Prompt title" value={form.title} onChange={(title) => onChange({ ...form, title })} required />
        <TextArea label="Help text" value={form.description} onChange={(description) => onChange({ ...form, description })} />
        <MultiServiceSelect
          label="Require one of"
          value={form.requiredServiceIds}
          services={services.filter((service) => service.id !== form.triggerServiceId)}
          onChange={(requiredServiceIds) => onChange({ ...form, requiredServiceIds })}
        />
        <Checkbox label="Active" checked={form.isActive} onChange={(isActive) => onChange({ ...form, isActive })} />
        <FormActions saving={saving} editing={Boolean(form.id)} onCancel={onCancel} />
      </form>
    </Panel>
  );
}

function UpgradeForm({
  form,
  services,
  locations,
  saving,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: UpgradeFormState;
  services: OwnerBookingService[];
  locations: OwnerBookingSettingsResponse['locations'];
  saving: boolean;
  onChange: (form: UpgradeFormState) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <Panel title={form.id ? 'Edit Upgrade Prompt' : 'New Upgrade Prompt'}>
      <form onSubmit={onSubmit} className="space-y-3">
        <ScopeSelect value={form.locationId} locations={locations} onChange={(locationId) => onChange({ ...form, locationId })} />
        <ServiceSelect label="Trigger service" value={form.triggerServiceId} services={services} onChange={(triggerServiceId) => onChange({ ...form, triggerServiceId })} />
        <ServiceSelect label="Suggested service" value={form.suggestedServiceId} services={services.filter((service) => service.id !== form.triggerServiceId)} onChange={(suggestedServiceId) => onChange({ ...form, suggestedServiceId })} />
        <TextInput label="Prompt title" value={form.title} onChange={(title) => onChange({ ...form, title })} required />
        <TextArea label="Description" value={form.description} onChange={(description) => onChange({ ...form, description })} required />
        <TextInput label="Sort order" type="number" value={form.sortOrder} onChange={(sortOrder) => onChange({ ...form, sortOrder })} />
        <Checkbox label="Active" checked={form.isActive} onChange={(isActive) => onChange({ ...form, isActive })} />
        <FormActions saving={saving} editing={Boolean(form.id)} onCancel={onCancel} />
      </form>
    </Panel>
  );
}

function ServiceList({ services }: { services: OwnerBookingService[] }) {
  if (services.length === 0) return <Empty title="No services found" body="Create booking services in the database seed/admin process first." />;
  return (
    <div className="divide-y divide-border">
      {services.map((service) => (
        <div key={service.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium text-text-primary">{service.name}</div>
              <div className="mt-1 text-[12px] text-text-secondary">
                {service.category ?? 'Uncategorised'} · {formatDuration(service.estimatedDurationMinutes)} · {formatMoney(service.startingPriceAmount, service.currencyCode)}
              </div>
            </div>
            <StatusPill active={service.isActive} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RuleList({
  rules,
  serviceById,
  locationName,
  onEdit,
  onDelete,
}: {
  rules: OwnerServiceRequirementRule[];
  serviceById: Map<string, OwnerBookingService>;
  locationName: (id: string) => string | undefined;
  onEdit: (rule: OwnerServiceRequirementRule) => void;
  onDelete: (rule: OwnerServiceRequirementRule) => void;
}) {
  if (rules.length === 0) return <Empty title="No finishing rules" body="Add a rule to require blow dry or cut-finishing options for colour and treatment services." />;
  return (
    <div className="space-y-3">
      {rules.map((rule) => (
        <ConfigCard
          key={rule.id}
          title={rule.title}
          subtitle={`${serviceName(serviceById, rule.triggerServiceId)} requires one of ${rule.requiredServiceIds.map((id) => serviceName(serviceById, id)).join(' / ')}`}
          meta={rule.locationId ? locationName(rule.locationId) ?? 'Location scoped' : 'Global'}
          active={rule.isActive}
          onEdit={() => onEdit(rule)}
          onDelete={() => onDelete(rule)}
        />
      ))}
    </div>
  );
}

function UpgradeList({
  suggestions,
  serviceById,
  locationName,
  onEdit,
  onDelete,
}: {
  suggestions: OwnerServiceUpgradeSuggestion[];
  serviceById: Map<string, OwnerBookingService>;
  locationName: (id: string) => string | undefined;
  onEdit: (suggestion: OwnerServiceUpgradeSuggestion) => void;
  onDelete: (suggestion: OwnerServiceUpgradeSuggestion) => void;
}) {
  if (suggestions.length === 0) return <Empty title="No upgrade prompts" body="Add optional suggestions that appear after service selection and before stylist choice." />;
  return (
    <div className="space-y-3">
      {suggestions.map((suggestion) => (
        <ConfigCard
          key={suggestion.id}
          title={suggestion.title}
          subtitle={`${serviceName(serviceById, suggestion.triggerServiceId)} -> ${serviceName(serviceById, suggestion.suggestedServiceId)} · ${suggestion.description}`}
          meta={suggestion.locationId ? locationName(suggestion.locationId) ?? 'Location scoped' : 'Global'}
          active={suggestion.isActive}
          onEdit={() => onEdit(suggestion)}
          onDelete={() => onDelete(suggestion)}
        />
      ))}
    </div>
  );
}

function ConfigCard({ title, subtitle, meta, active, onEdit, onDelete }: { title: string; subtitle: string; meta: string; active: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="rounded-input-lg border border-border bg-surface-alt/40 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-text-primary">{title}</div>
          <div className="mt-1 text-[12px] text-text-secondary">{subtitle}</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.08em] text-text-muted">{meta}</div>
        </div>
        <StatusPill active={active} />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onEdit} className="h-8 rounded-pill border border-border-strong bg-surface px-3 text-[12px] font-medium text-text-secondary">Edit</button>
        <button type="button" onClick={onDelete} className="h-8 rounded-pill border border-danger-border bg-danger-soft px-3 text-[12px] font-medium text-danger">Delete</button>
      </div>
    </div>
  );
}

function ScopeSelect({ value, locations, onChange }: { value: string; locations: OwnerBookingSettingsResponse['locations']; onChange: (value: string) => void }) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      Scope
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary">
        <option value={GLOBAL_SCOPE}>Global / all locations</option>
        {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
      </select>
    </label>
  );
}

function ServiceSelect({ label, value, services, onChange }: { label: string; value: string; services: OwnerBookingService[]; onChange: (value: string) => void }) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <select required value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary">
        <option value="" disabled>Select service</option>
        {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
      </select>
    </label>
  );
}

function MultiServiceSelect({ label, value, services, onChange }: { label: string; value: string[]; services: OwnerBookingService[]; onChange: (value: string[]) => void }) {
  return (
    <div>
      <div className="text-[12px] font-medium text-text-secondary">{label}</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {services.map((service) => (
          <label key={service.id} className="flex items-center gap-2 rounded-input-lg border border-border bg-surface-alt/40 px-3 py-2 text-[12px] text-text-primary">
            <input
              type="checkbox"
              checked={value.includes(service.id)}
              onChange={(event) => onChange(event.target.checked ? [...value, service.id] : value.filter((id) => id !== service.id))}
            />
            {service.name}
          </label>
        ))}
      </div>
    </div>
  );
}

function TextInput({ label, value, onChange, type = 'text', required }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <input required={required} type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary" />
    </label>
  );
}

function TextArea({ label, value, onChange, required }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <textarea required={required} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 min-h-20 w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary" />
    </label>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-text-secondary">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function FormActions({ saving, editing, onCancel }: { saving: boolean; editing: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      {editing ? <button type="button" onClick={onCancel} className="h-9 rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-medium text-text-secondary">Cancel edit</button> : null}
      <button disabled={saving} className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary disabled:opacity-60">
        {saving ? 'Saving...' : editing ? 'Save changes' : 'Create'}
      </button>
    </div>
  );
}

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card-lg border border-border bg-surface p-4">
      {title ? <h2 className="mb-3 text-[15px] font-semibold text-text-primary">{title}</h2> : null}
      {children}
    </section>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="py-6 text-center"><div className="text-[14px] font-medium text-text-primary">{title}</div><div className="mt-1 text-[13px] text-text-secondary">{body}</div></div>;
}

function Notice({ tone, text }: { tone: 'success' | 'danger'; text: string }) {
  return <div className={`mb-4 rounded-input-lg border px-4 py-3 text-[13px] ${tone === 'success' ? 'border-success-border bg-success-soft text-success' : 'border-danger-border bg-danger-soft text-danger'}`}>{text}</div>;
}

function StatusPill({ active }: { active: boolean }) {
  return <span className={`inline-flex h-6 items-center rounded-pill px-2.5 text-[11px] font-medium ${active ? 'border border-success-border bg-success-soft text-success' : 'border border-border-strong bg-surface-alt text-text-secondary'}`}>{active ? 'Active' : 'Inactive'}</span>;
}

function emptyRuleForm(locationId = '', serviceId = ''): RuleFormState {
  return { locationId: locationId || GLOBAL_SCOPE, triggerServiceId: serviceId, title: '', description: '', requiredServiceIds: [], isActive: true };
}

function emptyUpgradeForm(locationId = '', triggerServiceId = '', suggestedServiceId = ''): UpgradeFormState {
  return { locationId: locationId || GLOBAL_SCOPE, triggerServiceId, suggestedServiceId, title: '', description: '', sortOrder: '0', isActive: true };
}

function ensureRuleDefaults(form: RuleFormState, services: OwnerBookingService[], locationId: string): RuleFormState {
  return { ...form, locationId: form.locationId || locationId || GLOBAL_SCOPE, triggerServiceId: form.triggerServiceId || services[0]?.id || '' };
}

function ensureUpgradeDefaults(form: UpgradeFormState, services: OwnerBookingService[], locationId: string): UpgradeFormState {
  return { ...form, locationId: form.locationId || locationId || GLOBAL_SCOPE, triggerServiceId: form.triggerServiceId || services[0]?.id || '', suggestedServiceId: form.suggestedServiceId || services[1]?.id || '' };
}

function ruleToForm(rule: OwnerServiceRequirementRule): RuleFormState {
  return { id: rule.id, locationId: rule.locationId ?? GLOBAL_SCOPE, triggerServiceId: rule.triggerServiceId, title: rule.title, description: rule.description ?? '', requiredServiceIds: rule.requiredServiceIds, isActive: rule.isActive };
}

function upgradeToForm(suggestion: OwnerServiceUpgradeSuggestion): UpgradeFormState {
  return { id: suggestion.id, locationId: suggestion.locationId ?? GLOBAL_SCOPE, triggerServiceId: suggestion.triggerServiceId, suggestedServiceId: suggestion.suggestedServiceId, title: suggestion.title, description: suggestion.description, sortOrder: String(suggestion.sortOrder), isActive: suggestion.isActive };
}

function normalizeLocation(value: string): string | null {
  return value && value !== GLOBAL_SCOPE ? value : null;
}

function serviceName(serviceById: Map<string, OwnerBookingService>, serviceId: string): string {
  return serviceById.get(serviceId)?.name ?? 'Unknown service';
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function formatMoney(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
}

function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
