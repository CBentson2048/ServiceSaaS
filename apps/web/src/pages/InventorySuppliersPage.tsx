import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { InventorySupplier } from '@sheer/domain';
import { userHasAnyRole, userHasRole } from '@sheer/domain';
import {
  ApiRequestError,
  createInventorySupplier,
  deleteInventorySupplier,
  listInventorySuppliers,
  updateInventorySupplier,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

interface SupplierForm {
  id: string | null;
  name: string;
  contactEmail: string;
  contactPhone: string;
  accountReference: string;
  leadTimeDays: string;
  notes: string;
  isActive: boolean;
}

const emptyForm: SupplierForm = {
  id: null,
  name: '',
  contactEmail: '',
  contactPhone: '',
  accountReference: '',
  leadTimeDays: '',
  notes: '',
  isActive: true,
};

export function InventorySuppliersPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const isOwner = userHasRole(auth.user, 'owner');
  const canManage = userHasAnyRole(auth.user, ['owner', 'manager']);
  const [suppliers, setSuppliers] = useState<InventorySupplier[]>([]);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<SupplierForm>(emptyForm);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listInventorySuppliers(accessToken, { includeInactive });
      setSuppliers(result.suppliers);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load suppliers');
    } finally {
      setLoading(false);
    }
  }, [accessToken, includeInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visibleSuppliers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return suppliers;
    return suppliers.filter((supplier) =>
      [supplier.name, supplier.contactEmail ?? '', supplier.accountReference ?? '']
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }, [suppliers, search]);

  if (auth.status === 'authenticated' && !userHasAnyRole(auth.user, ['owner', 'manager'])) {
    return <Navigate to="/unauthorized" replace />;
  }

  function openCreate() {
    setForm(emptyForm);
    setShowForm(true);
    setActionMessage(null);
  }

  function openEdit(supplier: InventorySupplier) {
    setForm({
      id: supplier.id,
      name: supplier.name,
      contactEmail: supplier.contactEmail ?? '',
      contactPhone: supplier.contactPhone ?? '',
      accountReference: supplier.accountReference ?? '',
      leadTimeDays: supplier.leadTimeDays === undefined ? '' : String(supplier.leadTimeDays),
      notes: supplier.notes ?? '',
      isActive: supplier.isActive,
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
      setError('Supplier name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    setActionMessage(null);
    try {
      const leadTimeDays = form.leadTimeDays.trim() === '' ? null : Number(form.leadTimeDays);
      const payload = {
        name: form.name.trim(),
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        accountReference: form.accountReference.trim() || null,
        leadTimeDays: Number.isFinite(leadTimeDays as number) ? leadTimeDays : null,
        notes: form.notes.trim() || null,
        isActive: form.isActive,
      };
      const result = form.id
        ? await updateInventorySupplier(accessToken, form.id, payload)
        : await createInventorySupplier(accessToken, payload);
      setSuppliers((current) => upsertSupplier(current, result.supplier, includeInactive));
      setActionMessage(`${result.supplier.name} ${form.id ? 'updated' : 'created'}.`);
      closeForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save supplier');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(supplier: InventorySupplier) {
    if (!accessToken || !isOwner) return;
    if (
      !window.confirm(
        `Delete supplier "${supplier.name}"? Products ordered from them keep their history but lose the supplier link. This cannot be undone.`,
      )
    )
      return;
    setError(null);
    setActionMessage(null);
    try {
      await deleteInventorySupplier(accessToken, supplier.id);
      setSuppliers((current) => current.filter((entry) => entry.id !== supplier.id));
      setActionMessage(`${supplier.name} deleted.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete supplier');
    }
  }

  return (
    <>
      <h2 className="sr-only">Suppliers</h2>
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-text-secondary">
          Maintain the suppliers your products are ordered from. The contact email is where
          automated order forms will be sent.
        </p>
        {canManage ? (
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            onClick={() => (showForm && !form.id ? closeForm() : openCreate())}
          >
            {showForm && !form.id ? 'Close form' : 'New supplier'}
          </button>
        ) : null}
      </header>

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
          <TextInput
            label="Order email"
            type="email"
            value={form.contactEmail}
            onChange={(value) => setForm((current) => ({ ...current, contactEmail: value }))}
          />
          <TextInput
            label="Phone"
            value={form.contactPhone}
            onChange={(value) => setForm((current) => ({ ...current, contactPhone: value }))}
          />
          <TextInput
            label="Account reference"
            value={form.accountReference}
            onChange={(value) => setForm((current) => ({ ...current, accountReference: value }))}
          />
          <TextInput
            label="Lead time (days)"
            value={form.leadTimeDays}
            onChange={(value) =>
              setForm((current) => ({ ...current, leadTimeDays: value.replace(/[^0-9]/g, '') }))
            }
          />
          <TextInput
            label="Notes"
            value={form.notes}
            onChange={(value) => setForm((current) => ({ ...current, notes: value }))}
          />
          <label className="flex items-center gap-2 text-[12px] font-medium text-text-secondary">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
            />
            Active
          </label>
          <div className="flex items-end justify-end gap-2 sm:col-start-2">
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
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create supplier'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          placeholder="Search suppliers"
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

      <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
        {loading ? (
          <EmptyState title="Loading suppliers…" body="Fetching your supplier catalogue." />
        ) : visibleSuppliers.length === 0 ? (
          <EmptyState
            title={suppliers.length === 0 ? 'No suppliers yet' : 'No suppliers match this search'}
            body={
              suppliers.length === 0
                ? canManage
                  ? 'Create your first supplier so products can be linked for ordering.'
                  : 'Suppliers will appear here once they are added.'
                : 'Try a different search term.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Account ref</th>
                  <th className="px-4 py-3">Lead time</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Updated</th>
                  {canManage ? <th className="px-4 py-3 text-right">Actions</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleSuppliers.map((supplier) => (
                  <tr key={supplier.id}>
                    <td className="px-4 py-3 font-medium text-text-primary">{supplier.name}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      <div>{supplier.contactEmail ?? '—'}</div>
                      {supplier.contactPhone ? (
                        <div className="text-[12px] text-text-muted">{supplier.contactPhone}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{supplier.accountReference ?? '—'}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {supplier.leadTimeDays === undefined ? '—' : `${supplier.leadTimeDays}d`}
                    </td>
                    <td className="px-4 py-3">
                      {supplier.isActive ? (
                        <span className="inline-flex rounded-pill border border-success-border bg-success-soft px-2.5 py-1 text-[12px] font-medium text-success">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex rounded-pill border border-border-strong bg-surface-alt px-2.5 py-1 text-[12px] font-medium text-text-muted">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(supplier.updatedAt)}</td>
                    {canManage ? (
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => openEdit(supplier)}
                            className="text-[13px] font-medium text-primary hover:text-primary-deep"
                          >
                            Edit
                          </button>
                          {isOwner ? (
                            <button
                              type="button"
                              onClick={() => void handleDelete(supplier)}
                              className="text-[13px] font-medium text-danger hover:opacity-80"
                            >
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function upsertSupplier(
  current: InventorySupplier[],
  saved: InventorySupplier,
  includeInactive: boolean,
): InventorySupplier[] {
  const exists = current.some((entry) => entry.id === saved.id);
  const next = exists
    ? current.map((entry) => (entry.id === saved.id ? saved : entry))
    : [...current, saved];
  const filtered = includeInactive ? next : next.filter((entry) => entry.isActive);
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
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

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}
