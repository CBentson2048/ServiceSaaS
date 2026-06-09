import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { InventoryCategory } from '@sheer/domain';
import {
  ApiRequestError,
  createInventoryCategory,
  deleteInventoryCategory,
  listInventoryCategories,
  updateInventoryCategory,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

interface CategoryForm {
  id: string | null;
  name: string;
  description: string;
  isActive: boolean;
}

const emptyForm: CategoryForm = { id: null, name: '', description: '', isActive: true };

export function InventoryCategoriesPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const isOwner = auth.user?.role === 'owner';
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CategoryForm>(emptyForm);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listInventoryCategories(accessToken, { includeInactive });
      setCategories(result.categories);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load inventory categories');
    } finally {
      setLoading(false);
    }
  }, [accessToken, includeInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visibleCategories = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return categories;
    return categories.filter((category) =>
      [category.name, category.description ?? ''].join(' ').toLowerCase().includes(term),
    );
  }, [categories, search]);

  if (auth.status === 'authenticated' && auth.user?.role !== 'owner' && auth.user?.role !== 'manager') {
    return <Navigate to="/unauthorized" replace />;
  }

  function openCreate() {
    setForm(emptyForm);
    setShowForm(true);
    setActionMessage(null);
  }

  function openEdit(category: InventoryCategory) {
    setForm({
      id: category.id,
      name: category.name,
      description: category.description ?? '',
      isActive: category.isActive,
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
    if (!accessToken || !isOwner) return;
    if (!form.name.trim()) {
      setError('Category name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    setActionMessage(null);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        isActive: form.isActive,
      };
      const result = form.id
        ? await updateInventoryCategory(accessToken, form.id, payload)
        : await createInventoryCategory(accessToken, payload);
      setCategories((current) => upsertCategory(current, result.category, includeInactive));
      setActionMessage(`${result.category.name} ${form.id ? 'updated' : 'created'}.`);
      closeForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save category');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(category: InventoryCategory) {
    if (!accessToken || !isOwner) return;
    if (!window.confirm(`Delete category "${category.name}"? This cannot be undone.`)) return;
    setError(null);
    setActionMessage(null);
    try {
      await deleteInventoryCategory(accessToken, category.id);
      setCategories((current) => current.filter((entry) => entry.id !== category.id));
      setActionMessage(`${category.name} deleted.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete category');
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Inventory categories</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Maintain the category taxonomy used to organise your product range.
          </p>
        </div>
        {isOwner ? (
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            onClick={() => (showForm && !form.id ? closeForm() : openCreate())}
          >
            {showForm && !form.id ? 'Close form' : 'New category'}
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

      {isOwner && showForm ? (
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
            label="Description"
            value={form.description}
            onChange={(value) => setForm((current) => ({ ...current, description: value }))}
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
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create category'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          placeholder="Search categories"
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
          <EmptyState title="Loading categories…" body="Fetching inventory categories." />
        ) : visibleCategories.length === 0 ? (
          <EmptyState
            title={categories.length === 0 ? 'No categories yet' : 'No categories match this search'}
            body={
              categories.length === 0
                ? isOwner
                  ? 'Create your first category to start organising products.'
                  : 'Categories will appear here once an owner adds them.'
                : 'Try a different search term.'
            }
          />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Updated</th>
                {isOwner ? <th className="px-4 py-3 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleCategories.map((category) => (
                <tr key={category.id}>
                  <td className="px-4 py-3 font-medium text-text-primary">{category.name}</td>
                  <td className="px-4 py-3 text-text-secondary">{category.description ?? '—'}</td>
                  <td className="px-4 py-3">
                    {category.isActive ? (
                      <span className="inline-flex rounded-pill border border-success-border bg-success-soft px-2.5 py-1 text-[12px] font-medium text-success">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex rounded-pill border border-border-strong bg-surface-alt px-2.5 py-1 text-[12px] font-medium text-text-muted">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{formatDate(category.updatedAt)}</td>
                  {isOwner ? (
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => openEdit(category)}
                          className="text-[13px] font-medium text-primary hover:text-primary-deep"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(category)}
                          className="text-[13px] font-medium text-danger hover:opacity-80"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function upsertCategory(
  current: InventoryCategory[],
  saved: InventoryCategory,
  includeInactive: boolean,
): InventoryCategory[] {
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
