import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { ServiceBillingCategory, ServiceCategory } from '@sheer/domain';
import {
  ApiRequestError,
  createServiceCategory,
  deleteServiceCategory,
  listServiceCategories,
  reorderServiceCategories,
  updateServiceCategory,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

interface CategoryForm {
  id: string | null;
  name: string;
  description: string;
  colorHex: string;
  /** '' = not colour work; otherwise one of the four colour billing categories. */
  billingCategory: ServiceBillingCategory | '';
  isActive: boolean;
}

/** Friendly labels for the fixed colour billing vocabulary (0043/0091). */
const BILLING_CATEGORY_LABELS: Record<ServiceBillingCategory, string> = {
  permanent_colour: 'Permanent colour',
  lightener_bleach: 'Lightener & bleach',
  semi_toners: 'Semi & toners',
  special_treatments: 'Special treatments',
};

// Suggested swatches for quick picking; the colour input still accepts any hex.
// Each new category defaults to the next swatch so categories start visually distinct.
const SWATCHES = [
  '#A78BFA',
  '#60A5FA',
  '#34D399',
  '#FBBF24',
  '#F87171',
  '#F472B6',
  '#22D3EE',
  '#FB923C',
  '#A3E635',
  '#C084FC',
  '#2DD4BF',
  '#94A3B8',
];

const DEFAULT_COLOR = SWATCHES[0];

const emptyForm: CategoryForm = {
  id: null,
  name: '',
  description: '',
  colorHex: DEFAULT_COLOR,
  billingCategory: '',
  isActive: true,
};

export function ServiceCategoriesPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const role = auth.user?.primaryRole;
  const isOwner = role === 'owner';
  const canManage = role === 'owner' || role === 'manager';
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CategoryForm>(emptyForm);
  const [dragId, setDragId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listServiceCategories(accessToken, { includeInactive });
      setCategories(result.categories);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load service categories');
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

  // Drag-to-reorder is only offered over the full, unfiltered list so the saved
  // order is unambiguous (the displayed rows are exactly what gets renumbered).
  const canReorder = canManage && !search.trim();

  if (auth.status === 'authenticated' && role !== 'owner' && role !== 'manager') {
    return <Navigate to="/unauthorized" replace />;
  }

  function openCreate() {
    // Default to the next swatch so a fresh category starts visually distinct.
    setForm({ ...emptyForm, colorHex: SWATCHES[categories.length % SWATCHES.length] });
    setShowForm(true);
    setActionMessage(null);
  }

  function openEdit(category: ServiceCategory) {
    setForm({
      id: category.id,
      name: category.name,
      description: category.description ?? '',
      colorHex: category.colorHex ?? DEFAULT_COLOR,
      billingCategory: category.billingCategory ?? '',
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
    if (!accessToken || !canManage) return;
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
        colorHex: form.colorHex,
        billingCategory: form.billingCategory || null,
        isActive: form.isActive,
      };
      const result = form.id
        ? await updateServiceCategory(accessToken, form.id, payload)
        : await createServiceCategory(accessToken, payload);
      setCategories((current) => upsertCategory(current, result.category, includeInactive));
      setActionMessage(`${result.category.name} ${form.id ? 'updated' : 'created'}.`);
      closeForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save category');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(category: ServiceCategory) {
    if (!accessToken || !isOwner) return;
    if (!window.confirm(`Delete category "${category.name}"? This cannot be undone.`)) return;
    setError(null);
    setActionMessage(null);
    try {
      await deleteServiceCategory(accessToken, category.id);
      setCategories((current) => current.filter((entry) => entry.id !== category.id));
      setActionMessage(`${category.name} deleted.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete category');
    }
  }

  async function persistOrder(next: ServiceCategory[], previous: ServiceCategory[]) {
    if (!accessToken) return;
    setSavingOrder(true);
    setError(null);
    setActionMessage(null);
    try {
      // Adopt the server's authoritative order rather than the optimistic guess,
      // so a partial/reconciled save (e.g. inactive rows pushed to the end) is
      // reflected immediately instead of silently diverging until the next reload.
      const result = await reorderServiceCategories(accessToken, next.map((category) => category.id));
      setCategories(includeInactive ? result.categories : result.categories.filter((category) => category.isActive));
      setActionMessage('Category order updated.');
    } catch (err: unknown) {
      setCategories(previous); // roll back the optimistic move
      setError(err instanceof Error ? err.message : 'Could not save category order');
    } finally {
      setSavingOrder(false);
    }
  }

  function handleDrop(targetId: string) {
    const sourceId = dragId;
    setDragId(null);
    if (!sourceId || sourceId === targetId) return;
    const reordered = moveItem(categories, sourceId, targetId);
    if (!reordered) return;
    // Keep each row's sortOrder in step with its new index so a later edit
    // (which re-sorts by sortOrder) doesn't scramble the order back.
    const renumbered = reordered.map((category, index) => ({ ...category, sortOrder: index }));
    const previous = categories;
    setCategories(renumbered);
    void persistOrder(renumbered, previous);
  }

  return (
    <>
      <h2 className="sr-only">Service categories</h2>
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-text-secondary">
          Organise your bookable services (e.g. Hair Colour, Barbering). Separate from product categories.
        </p>
        {canManage ? (
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
            label="Description"
            value={form.description}
            onChange={(value) => setForm((current) => ({ ...current, description: value }))}
          />
          <label className="text-[12px] font-medium text-text-secondary sm:col-span-2">
            Colour billing category
            <p className="mt-0.5 text-[11px] font-normal text-text-muted">
              Tells the system this category is colour work. Tagged categories drive Colour Prep
              planning and the colour billing rules; leave as &ldquo;Not colour work&rdquo; for
              cutting, styling and everything else.
            </p>
            <select
              value={form.billingCategory}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  billingCategory: event.target.value as ServiceBillingCategory | '',
                }))
              }
              className="mt-2 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-72"
            >
              <option value="">Not colour work</option>
              {(Object.keys(BILLING_CATEGORY_LABELS) as ServiceBillingCategory[]).map((key) => (
                <option key={key} value={key}>
                  {BILLING_CATEGORY_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <div className="text-[12px] font-medium text-text-secondary sm:col-span-2">
            Calendar colour
            <p className="mt-0.5 text-[11px] font-normal text-text-muted">
              Appointments for this category are tinted with this colour on the appointment book.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                type="color"
                aria-label="Category colour"
                value={form.colorHex}
                onChange={(event) =>
                  setForm((current) => ({ ...current, colorHex: event.target.value.toUpperCase() }))
                }
                className="h-10 w-12 shrink-0 cursor-pointer rounded-input-lg border border-border-strong bg-surface p-1"
              />
              <input
                type="text"
                aria-label="Category colour hex"
                value={form.colorHex}
                onChange={(event) => setForm((current) => ({ ...current, colorHex: event.target.value.toUpperCase() }))}
                spellCheck={false}
                className="h-10 w-28 rounded-input-lg border border-border-strong bg-surface px-3 font-mono text-[13px] uppercase text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <div className="flex flex-wrap gap-1.5">
                {SWATCHES.map((swatch) => {
                  const active = swatch.toUpperCase() === form.colorHex.toUpperCase();
                  return (
                    <button
                      key={swatch}
                      type="button"
                      aria-label={`Use ${swatch}`}
                      aria-pressed={active}
                      onClick={() => setForm((current) => ({ ...current, colorHex: swatch }))}
                      className={`h-6 w-6 rounded-full border transition ${
                        active ? 'border-text-primary ring-2 ring-primary/40' : 'border-black/10 hover:scale-110'
                      }`}
                      style={{ backgroundColor: swatch }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
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

      {canReorder ? (
        <p className="mb-2 text-[12px] text-text-muted">
          Drag the ⠿ handle to reorder categories. This order is used across the booking flow.
        </p>
      ) : null}

      <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
        {loading ? (
          <EmptyState title="Loading categories…" body="Fetching service categories." />
        ) : visibleCategories.length === 0 ? (
          <EmptyState
            title={categories.length === 0 ? 'No categories yet' : 'No categories match this search'}
            body={
              categories.length === 0
                ? canManage
                  ? 'Create your first category to start organising services.'
                  : 'Categories will appear here once they are added.'
                : 'Try a different search term.'
            }
          />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                {canReorder ? <th className="w-8 px-2 py-3" aria-label="Reorder" /> : null}
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Colour work</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Updated</th>
                {canManage ? <th className="px-4 py-3 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleCategories.map((category) => (
                <tr
                  key={category.id}
                  draggable={canReorder && !savingOrder}
                  onDragStart={canReorder ? () => setDragId(category.id) : undefined}
                  onDragOver={canReorder ? (event) => event.preventDefault() : undefined}
                  onDrop={canReorder ? () => handleDrop(category.id) : undefined}
                  className={dragId === category.id ? 'opacity-50' : undefined}
                >
                  {canReorder ? (
                    <td className="cursor-move px-2 py-3 text-center text-[15px] leading-none text-text-muted" aria-hidden>
                      ⠿
                    </td>
                  ) : null}
                  <td className="px-4 py-3 font-medium text-text-primary">
                    <span className="flex items-center gap-2.5">
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/10"
                        style={{ backgroundColor: category.colorHex ?? 'transparent' }}
                        aria-hidden
                      />
                      {category.name}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{category.description ?? '—'}</td>
                  <td className="px-4 py-3">
                    {category.billingCategory ? (
                      <span className="inline-flex rounded-pill border border-primary bg-primary-soft px-2.5 py-1 text-[12px] font-medium text-primary-deep">
                        {BILLING_CATEGORY_LABELS[category.billingCategory]}
                      </span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
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
                  {canManage ? (
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => openEdit(category)}
                          className="text-[13px] font-medium text-primary hover:text-primary-deep"
                        >
                          Edit
                        </button>
                        {isOwner ? (
                          <button
                            type="button"
                            onClick={() => void handleDelete(category)}
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
        )}
      </section>
    </>
  );
}

function upsertCategory(
  current: ServiceCategory[],
  saved: ServiceCategory,
  includeInactive: boolean,
): ServiceCategory[] {
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
