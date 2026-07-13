import { useCallback, useEffect, useState } from 'react';
import type { BookOutType, UpdateBookOutTypeRequest } from '@sheer/domain';
import {
  ApiRequestError,
  createBookOutType,
  deleteBookOutType,
  listBookOutTypes,
  updateBookOutType,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { AppButton, AppCard } from '../design';

const DEFAULT_COLOR = '#94a3b8';

const FLAG_META: Array<{
  key: 'blocksAppointments' | 'reducesAvailableHours' | 'countsAsPaidTime';
  label: string;
  hint: string;
}> = [
  {
    key: 'blocksAppointments',
    label: 'Blocks appointments',
    hint: 'Clients cannot be booked over this block on the calendar.',
  },
  {
    key: 'reducesAvailableHours',
    label: 'Reduces available hours',
    hint: 'Time is removed from the utilisation denominator (available working hours).',
  },
  {
    key: 'countsAsPaidTime',
    label: 'Counts as paid time',
    hint: 'Treated as paid working time for payroll and reporting.',
  },
];

export function BookOutTypesPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;

  const [types, setTypes] = useState<BookOutType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_COLOR);
  const [newBlocks, setNewBlocks] = useState(true);
  const [newReduces, setNewReduces] = useState(true);
  const [newPaid, setNewPaid] = useState(false);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listBookOutTypes(accessToken);
      setTypes(result.bookOutTypes);
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'Could not load book-out types');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patchType = useCallback(
    async (type: BookOutType, patch: UpdateBookOutTypeRequest) => {
      if (!accessToken) return;
      setSavingId(type.id);
      setError(null);
      setNotice(null);
      // Optimistic update so toggles feel instant; reconcile with server row.
      setTypes((prev) => prev.map((t) => (t.id === type.id ? { ...t, ...patch } as BookOutType : t)));
      try {
        const result = await updateBookOutType(accessToken, type.id, patch);
        setTypes((prev) => prev.map((t) => (t.id === type.id ? result.bookOutType : t)));
        setNotice(`Saved “${result.bookOutType.name}”.`);
      } catch (err) {
        setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'Could not save changes');
        await reload();
      } finally {
        setSavingId(null);
      }
    },
    [accessToken, reload],
  );

  const removeType = useCallback(
    async (type: BookOutType) => {
      if (!accessToken) return;
      if (!window.confirm(`Delete “${type.name}”? Past bookouts using it keep their history.`)) return;
      setSavingId(type.id);
      setError(null);
      try {
        await deleteBookOutType(accessToken, type.id);
        setTypes((prev) => prev.filter((t) => t.id !== type.id));
        setNotice(`Deleted “${type.name}”.`);
      } catch (err) {
        setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'Could not delete type');
      } finally {
        setSavingId(null);
      }
    },
    [accessToken],
  );

  const handleCreate = useCallback(async () => {
    if (!accessToken) return;
    const name = newName.trim();
    if (!name) {
      setError('Give the new book-out type a name');
      return;
    }
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createBookOutType(accessToken, {
        name,
        colorHex: newColor,
        blocksAppointments: newBlocks,
        reducesAvailableHours: newReduces,
        countsAsPaidTime: newPaid,
      });
      setTypes((prev) =>
        [...prev, result.bookOutType].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        ),
      );
      setNewName('');
      setNewColor(DEFAULT_COLOR);
      setNewBlocks(true);
      setNewReduces(true);
      setNewPaid(false);
      setNotice(`Added “${result.bookOutType.name}”.`);
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'Could not create type');
    } finally {
      setCreating(false);
    }
  }, [accessToken, newName, newColor, newBlocks, newReduces, newPaid]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-[20px] font-semibold text-text-primary">Book-out types</h1>
        <p className="max-w-3xl text-[13px] text-text-secondary">
          Configure the block-out reasons your team can put on the calendar. Each type’s flags drive
          availability and the daily utilisation shown next to each provider — utilisation is measured
          against <span className="font-medium text-text-primary">available</span> hours (shift time
          minus breaks and any book-out that reduces available hours).
        </p>
      </header>

      {error ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {notice}
        </div>
      ) : null}

      <AppCard padding="none" elevation="card">
        <div className="grid grid-cols-[1.4fr_repeat(3,1fr)_auto] items-center gap-2 border-b border-border bg-surface-alt px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
          <div>Type</div>
          {FLAG_META.map((flag) => (
            <div key={flag.key} className="text-center" title={flag.hint}>
              {flag.label}
            </div>
          ))}
          <div className="text-right">Actions</div>
        </div>

        {loading ? (
          <div className="px-4 py-8 text-center text-[13px] text-text-muted">Loading…</div>
        ) : types.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-text-muted">No book-out types yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {types.map((type) => (
              <li
                key={type.id}
                className="grid grid-cols-[1.4fr_repeat(3,1fr)_auto] items-center gap-2 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                    style={{ backgroundColor: type.colorHex ?? DEFAULT_COLOR }}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-text-primary">{type.name}</span>
                      {type.isSystem ? (
                        <span className="rounded-pill bg-surface-alt px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                          Built-in
                        </span>
                      ) : null}
                      {!type.isActive ? (
                        <span className="rounded-pill bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                          Inactive
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                {FLAG_META.map((flag) => (
                  <div key={flag.key} className="flex justify-center">
                    <input
                      type="checkbox"
                      checked={type[flag.key]}
                      disabled={savingId === type.id}
                      title={flag.hint}
                      onChange={(event) => void patchType(type, { [flag.key]: event.target.checked })}
                      className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
                    />
                  </div>
                ))}

                <div className="flex items-center justify-end gap-3 text-[12px]">
                  {!type.isSystem ? (
                    <button
                      type="button"
                      disabled={savingId === type.id}
                      onClick={() => void patchType(type, { isActive: !type.isActive })}
                      className="font-medium text-text-secondary transition hover:text-text-primary disabled:opacity-50"
                    >
                      {type.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  ) : null}
                  {!type.isSystem ? (
                    <button
                      type="button"
                      disabled={savingId === type.id}
                      onClick={() => void removeType(type)}
                      className="font-medium text-danger transition hover:text-danger/80 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </AppCard>

      <AppCard elevation="card">
        <h2 className="text-[14px] font-semibold text-text-primary">Add a book-out type</h2>
        <p className="mt-0.5 text-[12px] text-text-secondary">
          Create a custom reason with the behaviour that suits your salon.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-[12px] font-medium text-text-secondary">
            Name
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="e.g. Photoshoot"
              className="mt-1 w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-primary"
            />
          </label>
          <label className="text-[12px] font-medium text-text-secondary">
            Colour
            <input
              type="color"
              value={newColor}
              onChange={(event) => setNewColor(event.target.value)}
              className="mt-1 h-9 w-16 cursor-pointer rounded-input border border-border-strong bg-surface p-1"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-4">
          {(
            [
              ['blocksAppointments', newBlocks, setNewBlocks],
              ['reducesAvailableHours', newReduces, setNewReduces],
              ['countsAsPaidTime', newPaid, setNewPaid],
            ] as const
          ).map(([key, value, setter]) => {
            const meta = FLAG_META.find((f) => f.key === key)!;
            return (
              <label key={key} className="flex items-center gap-2 text-[13px] text-text-primary" title={meta.hint}>
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(event) => setter(event.target.checked)}
                  className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
                />
                {meta.label}
              </label>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <AppButton variant="primary" onClick={() => void handleCreate()} loading={creating}>
            Add type
          </AppButton>
        </div>
      </AppCard>
    </div>
  );
}
