import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import type { ManagedService, ServiceCategory, ServiceDepositType, UpsertServiceRequest } from '@sheer/domain';
import {
  ApiRequestError,
  archiveService,
  createService,
  listServiceCategories,
  listServices,
  listUnassignedServices,
  reorderServices,
  updateService,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

interface ServiceForm {
  id: string | null;
  name: string;
  description: string;
  serviceCategoryId: string;
  estimatedDurationMinutes: string;
  processingTimeMinutes: string;
  basePrice: string;
  depositType: ServiceDepositType;
  depositValue: string;
  requiresPatchTest: boolean;
  isActive: boolean;
}

const emptyForm: ServiceForm = {
  id: null,
  name: '',
  description: '',
  serviceCategoryId: '',
  estimatedDurationMinutes: '30',
  processingTimeMinutes: '',
  basePrice: '',
  depositType: 'none',
  depositValue: '',
  requiresPatchTest: false,
  isActive: true,
};

export function ServicesPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const role = auth.user?.primaryRole;
  const isOwner = role === 'owner';
  const canManage = role === 'owner' || role === 'manager';
  const [services, setServices] = useState<ManagedService[]>([]);
  const [unassignedServices, setUnassignedServices] = useState<ManagedService[]>([]);
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ServiceForm>(emptyForm);
  const [dragId, setDragId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [serviceResult, categoryResult, unassignedResult] = await Promise.all([
        listServices(accessToken, { includeInactive }),
        listServiceCategories(accessToken, {}),
        listUnassignedServices(accessToken),
      ]);
      setServices(serviceResult.services);
      setCategories(categoryResult.categories);
      setUnassignedServices(unassignedResult.services);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load services');
    } finally {
      setLoading(false);
    }
  }, [accessToken, includeInactive]);

  // Refresh just the unassigned-services warning (cheaper than a full reload) —
  // a newly created service is always unassigned, and archiving can clear one.
  const refreshUnassigned = useCallback(async () => {
    if (!accessToken) return;
    try {
      const result = await listUnassignedServices(accessToken);
      setUnassignedServices(result.services);
    } catch {
      // Non-critical; the banner just keeps its previous state.
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visibleServices = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return services;
    return services.filter((service) =>
      [service.name, service.description ?? '', service.category ?? ''].join(' ').toLowerCase().includes(term),
    );
  }, [services, search]);

  // Drag-to-reorder is only offered over the full, unfiltered list so the saved
  // order is unambiguous (the displayed rows are exactly what gets renumbered).
  const canReorder = canManage && !search.trim();

  // Active categories for the dropdown, plus the service's current category if
  // it happens to be inactive (so editing never silently drops the assignment).
  const categoryOptions = useMemo(() => {
    const options = categories.filter((category) => category.isActive);
    if (form.serviceCategoryId && !options.some((category) => category.id === form.serviceCategoryId)) {
      const current = categories.find((category) => category.id === form.serviceCategoryId);
      if (current) options.push(current);
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, form.serviceCategoryId]);

  if (auth.status === 'authenticated' && role !== 'owner' && role !== 'manager') {
    return <Navigate to="/unauthorized" replace />;
  }

  function openCreate() {
    setForm(emptyForm);
    setShowForm(true);
    setActionMessage(null);
  }

  function openEdit(service: ManagedService) {
    setForm({
      id: service.id,
      name: service.name,
      description: service.description ?? '',
      serviceCategoryId: service.serviceCategoryId ?? '',
      estimatedDurationMinutes: String(service.estimatedDurationMinutes),
      processingTimeMinutes: service.processingTimeMinutes ? String(service.processingTimeMinutes) : '',
      basePrice: service.basePrice ? String(service.basePrice) : '',
      depositType: service.depositType,
      depositValue: service.depositValue ? String(service.depositValue) : '',
      requiresPatchTest: service.requiresPatchTest,
      isActive: service.isActive,
    });
    setShowForm(true);
    setActionMessage(null);
  }

  function closeForm() {
    setForm(emptyForm);
    setShowForm(false);
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !canManage) return;
    if (!form.name.trim()) {
      setError('Service name is required.');
      return;
    }
    const duration = Number(form.estimatedDurationMinutes);
    if (!Number.isFinite(duration) || duration < 1) {
      setError('Duration must be at least 1 minute.');
      return;
    }
    setSaving(true);
    setError(null);
    setActionMessage(null);
    try {
      const payload: UpsertServiceRequest = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        serviceCategoryId: form.serviceCategoryId || null,
        estimatedDurationMinutes: duration,
        processingTimeMinutes: form.processingTimeMinutes ? Number(form.processingTimeMinutes) : undefined,
        basePrice: form.basePrice ? Number(form.basePrice) : 0,
        depositType: form.depositType,
        depositValue: form.depositType === 'none' ? 0 : form.depositValue ? Number(form.depositValue) : 0,
        requiresPatchTest: form.requiresPatchTest,
        isActive: form.isActive,
      };
      const result = form.id
        ? await updateService(accessToken, form.id, payload)
        : await createService(accessToken, payload);
      setServices((current) => upsertService(current, result.service, includeInactive));
      void refreshUnassigned();
      setActionMessage(`${result.service.name} ${form.id ? 'updated' : 'created'}.`);
      closeForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save service');
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(service: ManagedService) {
    if (!accessToken || !isOwner) return;
    if (!window.confirm(`Archive "${service.name}"? It will no longer be bookable.`)) return;
    setError(null);
    setActionMessage(null);
    try {
      const result = await archiveService(accessToken, service.id);
      setServices((current) => upsertService(current, result.service, includeInactive));
      void refreshUnassigned();
      setActionMessage(`${service.name} archived.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not archive service');
    }
  }

  async function persistOrder(next: ManagedService[], previous: ManagedService[]) {
    if (!accessToken) return;
    setSavingOrder(true);
    setError(null);
    setActionMessage(null);
    try {
      // Adopt the server's authoritative order rather than the optimistic guess,
      // so a partial/reconciled save (e.g. inactive rows pushed to the end) is
      // reflected immediately instead of silently diverging until the next reload.
      const result = await reorderServices(accessToken, next.map((service) => service.id));
      setServices(includeInactive ? result.services : result.services.filter((service) => service.isActive));
      setActionMessage('Service order updated.');
    } catch (err: unknown) {
      setServices(previous); // roll back the optimistic move
      setError(err instanceof Error ? err.message : 'Could not save service order');
    } finally {
      setSavingOrder(false);
    }
  }

  function handleDrop(targetId: string) {
    const sourceId = dragId;
    setDragId(null);
    if (!sourceId || sourceId === targetId) return;
    const reordered = moveItem(services, sourceId, targetId);
    if (!reordered) return;
    // Keep each row's sortOrder in step with its new index so a later edit
    // (which re-sorts by sortOrder) doesn't scramble the order back.
    const renumbered = reordered.map((service, index) => ({ ...service, sortOrder: index }));
    const previous = services;
    setServices(renumbered);
    void persistOrder(renumbered, previous);
  }

  return (
    <>
      <h2 className="sr-only">Services</h2>
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-text-secondary">
          Create services and assign each to a{' '}
          <Link to="/services/categories" className="font-medium text-primary hover:text-primary-deep">
            service category
          </Link>
          .
        </p>
        {canManage ? (
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            onClick={() => (showForm && !form.id ? closeForm() : openCreate())}
          >
            {showForm && !form.id ? 'Close form' : 'New service'}
          </button>
        ) : null}
      </header>

      {unassignedServices.length > 0 ? (
        (() => {
          const count = unassignedServices.length;
          const names = unassignedServices.slice(0, 3).map((s) => s.name).join(', ');
          const extra = count > 3 ? `, +${count - 3} more` : '';
          const lead = (
            <>
              <span className="font-semibold">
                {count} unassigned service{count === 1 ? '' : 's'}
              </span>{' '}
              — no bookable stylist can perform {count === 1 ? 'it' : 'them'}, so{' '}
              {count === 1 ? 'it is' : 'they are'} not bookable ({names}
              {extra}).
            </>
          );
          const banner =
            'mb-4 flex items-start gap-3 rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3 text-[13px] text-warning';
          // /team is owner-only, so only owners get the actionable link; managers
          // get an FYI pointing them at an owner.
          return isOwner ? (
            <Link to="/team" className={`${banner} transition hover:brightness-95`}>
              <span aria-hidden className="mt-0.5 text-[15px] leading-none">⚠</span>
              <span>{lead} Assign stylists in Team →</span>
            </Link>
          ) : (
            <div className={banner}>
              <span aria-hidden className="mt-0.5 text-[15px] leading-none">⚠</span>
              <span>{lead} Ask an owner to assign stylists.</span>
            </div>
          );
        })()
      ) : null}

      {actionMessage ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {actionMessage}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {canManage && showForm ? (
        <form
          onSubmit={handleSave}
          className="mb-5 grid gap-3 rounded-card-lg border border-border bg-surface p-4 sm:grid-cols-2"
        >
          <TextInput
            label="Name"
            value={form.name}
            onChange={(value) => setForm((current) => ({ ...current, name: value }))}
            required
          />
          <label className="text-[12px] font-medium text-text-secondary">
            Service category
            <select
              value={form.serviceCategoryId}
              onChange={(event) => setForm((current) => ({ ...current, serviceCategoryId: event.target.value }))}
              className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">Uncategorised</option>
              {categoryOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {category.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <TextInput
            label="Description"
            value={form.description}
            onChange={(value) => setForm((current) => ({ ...current, description: value }))}
          />
          <TextInput
            label="Duration (minutes)"
            type="number"
            value={form.estimatedDurationMinutes}
            onChange={(value) => setForm((current) => ({ ...current, estimatedDurationMinutes: value }))}
            required
          />
          <TextInput
            label="Processing time (minutes)"
            type="number"
            value={form.processingTimeMinutes}
            onChange={(value) => setForm((current) => ({ ...current, processingTimeMinutes: value }))}
          />
          <TextInput
            label="Price"
            type="number"
            value={form.basePrice}
            onChange={(value) => setForm((current) => ({ ...current, basePrice: value }))}
          />
          <label className="text-[12px] font-medium text-text-secondary">
            Deposit
            <select
              value={form.depositType}
              onChange={(event) =>
                setForm((current) => ({ ...current, depositType: event.target.value as ServiceDepositType }))
              }
              className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="none">No deposit</option>
              <option value="fixed_amount">Fixed amount</option>
              <option value="percentage">Percentage</option>
            </select>
          </label>
          {form.depositType !== 'none' ? (
            <TextInput
              label={form.depositType === 'percentage' ? 'Deposit (%)' : 'Deposit amount'}
              type="number"
              value={form.depositValue}
              onChange={(value) => setForm((current) => ({ ...current, depositValue: value }))}
            />
          ) : null}
          <label className="flex items-center gap-2 text-[12px] font-medium text-text-secondary">
            <input
              type="checkbox"
              checked={form.requiresPatchTest}
              onChange={(event) => setForm((current) => ({ ...current, requiresPatchTest: event.target.checked }))}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
            />
            Requires patch test
          </label>
          <label className="flex items-center gap-2 text-[12px] font-medium text-text-secondary">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
            />
            Active
          </label>
          <div className="flex items-end justify-end gap-2 sm:col-span-2">
            <button
              type="button"
              onClick={closeForm}
              className="h-10 rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
            >
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create service'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          placeholder="Search services"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-96"
        />
        <label className="flex items-center gap-2 text-[12px] font-medium text-text-secondary">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => setIncludeInactive(event.target.checked)}
            className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
          />
          Show inactive
        </label>
      </div>

      {canReorder ? (
        <p className="mb-2 text-[12px] text-text-muted">
          Drag the ⠿ handle to reorder services. QLOOQO keeps this order when building appointments.
        </p>
      ) : null}

      <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
        {loading ? (
          <EmptyState title="Loading services…" body="Fetching your service catalogue." />
        ) : visibleServices.length === 0 ? (
          <EmptyState
            title={services.length === 0 ? 'No services yet' : 'No services match this search'}
            body={
              services.length === 0
                ? canManage
                  ? 'Create your first service to start building the booking menu.'
                  : 'Services will appear here once they are added.'
                : 'Try a different search term.'
            }
          />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                {canReorder ? <th className="w-8 px-2 py-3" aria-label="Reorder" /> : null}
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">Status</th>
                {canManage ? <th className="px-4 py-3 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleServices.map((service) => (
                <tr
                  key={service.id}
                  draggable={canReorder && !savingOrder}
                  onDragStart={canReorder ? () => setDragId(service.id) : undefined}
                  onDragOver={canReorder ? (event) => event.preventDefault() : undefined}
                  onDrop={canReorder ? () => handleDrop(service.id) : undefined}
                  className={dragId === service.id ? 'opacity-50' : undefined}
                >
                  {canReorder ? (
                    <td className="cursor-move px-2 py-3 text-center text-[15px] leading-none text-text-muted" aria-hidden>
                      ⠿
                    </td>
                  ) : null}
                  <td className="px-4 py-3 font-medium text-text-primary">{service.name}</td>
                  <td className="px-4 py-3 text-text-secondary">{service.category ?? 'Uncategorised'}</td>
                  <td className="px-4 py-3 text-text-secondary">{service.estimatedDurationMinutes} min</td>
                  <td className="px-4 py-3 text-text-secondary">
                    {formatMoney(service.basePrice, service.currencyCode)}
                  </td>
                  <td className="px-4 py-3">
                    {service.isActive ? (
                      <span className="inline-flex rounded-pill border border-success-border bg-success-soft px-2.5 py-1 text-[12px] font-medium text-success">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex rounded-pill border border-border-strong bg-surface-alt px-2.5 py-1 text-[12px] font-medium text-text-muted">
                        Archived
                      </span>
                    )}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => openEdit(service)}
                          className="text-[13px] font-medium text-primary hover:text-primary-deep"
                        >
                          Edit
                        </button>
                        {isOwner && service.isActive ? (
                          <button
                            type="button"
                            onClick={() => void handleArchive(service)}
                            className="text-[13px] font-medium text-danger hover:opacity-80"
                          >
                            Archive
                          </button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function upsertService(
  current: ManagedService[],
  saved: ManagedService,
  includeInactive: boolean,
): ManagedService[] {
  const exists = current.some((entry) => entry.id === saved.id);
  const next = exists
    ? current.map((entry) => (entry.id === saved.id ? saved : entry))
    : [...current, saved];
  const filtered = includeInactive ? next : next.filter((entry) => entry.isActive);
  return filtered.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

// Returns a copy of `list` with the item `fromId` moved to `toId`'s position,
// or null when the move is a no-op / either id is missing.
function moveItem<T extends { id: string }>(list: T[], fromId: string, toId: string): T[] | null {
  const from = list.findIndex((item) => item.id === fromId);
  const to = list.findIndex((item) => item.id === toId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function formatMoney(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currencyCode }).format(amount);
  } catch {
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="text-[12px] font-medium text-text-secondary">
      {label}
      <input
        type={type}
        value={value}
        required={required}
        min={type === 'number' ? 0 : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <div className="mt-1 text-[13px] text-text-secondary">{body}</div>
    </div>
  );
}
