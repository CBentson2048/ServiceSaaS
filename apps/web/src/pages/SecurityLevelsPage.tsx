import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  Permission,
  PermissionDefinition,
  SecurityLevel,
  SecurityLevelBaseRole,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import {
  ApiRequestError,
  createSecurityLevel,
  deleteSecurityLevel,
  getPermissionCatalog,
  listSecurityLevels,
  updateSecurityLevel,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

const FIELD =
  'w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-primary';
const LABEL = 'mb-1 block text-[12px] font-medium text-text-secondary';

const BASE_ROLE_LABELS: Record<SecurityLevelBaseRole, string> = {
  owner: 'Owner (all locations)',
  manager: 'Manager (location-scoped)',
  stylist: 'Stylist (own column)',
};

interface LevelForm {
  name: string;
  description: string;
  baseRole: SecurityLevelBaseRole;
  permissions: Set<Permission>;
}

function emptyForm(): LevelForm {
  return { name: '', description: '', baseRole: 'manager', permissions: new Set() };
}

export function SecurityLevelsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const isOwner = userHasRole(auth.user, 'owner');

  const [levels, setLevels] = useState<SecurityLevel[]>([]);
  const [catalog, setCatalog] = useState<PermissionDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [form, setForm] = useState<LevelForm>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [levelsRes, catalogRes] = await Promise.all([
        listSecurityLevels(accessToken),
        getPermissionCatalog(accessToken),
      ]);
      setLevels(levelsRes.levels);
      setCatalog(catalogRes.permissions);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load security levels');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo(() => {
    const map = new Map<string, PermissionDefinition[]>();
    for (const def of catalog) {
      const list = map.get(def.group) ?? [];
      list.push(def);
      map.set(def.group, list);
    }
    return Array.from(map.entries());
  }, [catalog]);

  const customLevels = levels.filter((l) => !l.isSystem);
  const systemLevels = levels.filter((l) => l.isSystem);

  if (!isOwner) {
    return <Navigate to="/unauthorized" replace />;
  }

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
  }

  function startEdit(level: SecurityLevel) {
    setEditingId(level.id);
    setForm({
      name: level.name,
      description: level.description ?? '',
      baseRole: level.baseRole,
      permissions: new Set(level.permissions),
    });
    setFormError(null);
  }

  function togglePermission(key: Permission) {
    setForm((prev) => {
      const next = new Set(prev.permissions);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, permissions: next };
    });
  }

  async function onSubmit() {
    if (!accessToken) return;
    const name = form.name.trim();
    if (name.length < 2) {
      setFormError('Give the level a name (at least 2 characters).');
      return;
    }
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const permissions = Array.from(form.permissions);
      if (editingId) {
        await updateSecurityLevel(accessToken, editingId, {
          name,
          description: form.description.trim() || null,
          permissions,
        });
        setNotice(`Updated "${name}".`);
      } else {
        await createSecurityLevel(accessToken, {
          name,
          description: form.description.trim() || null,
          baseRole: form.baseRole,
          permissions,
        });
        setNotice(`Created "${name}".`);
      }
      setForm(emptyForm());
      setEditingId(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Unable to save security level');
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(level: SecurityLevel) {
    if (!accessToken) return;
    if (!window.confirm(`Delete "${level.name}"? Members on this level revert to their base role.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteSecurityLevel(accessToken, level.id);
      if (editingId === level.id) startCreate();
      setNotice(`Deleted "${level.name}".`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to delete security level');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] font-semibold text-text-primary">Security levels</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          Control exactly what each team member can see and do. Assign a level to a member on the
          Team page. System levels are built in; create custom levels for anything in between.
        </p>
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 rounded-input-lg border border-primary/40 bg-primary/10 px-3 py-2 text-[13px] text-text-primary">
          {notice}
        </div>
      ) : null}

      {loading ? (
        <div className="py-16 text-center text-[13px] text-text-secondary">Loading…</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            <section>
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                Custom levels
              </h2>
              {customLevels.length === 0 ? (
                <p className="rounded-input-lg border border-dashed border-border-strong bg-surface px-3 py-4 text-[13px] text-text-secondary">
                  No custom levels yet. Create one on the right (e.g. “Senior Stylist” or “Bookkeeper
                  view-only”).
                </p>
              ) : (
                <ul className="space-y-2">
                  {customLevels.map((level) => (
                    <LevelCard
                      key={level.id}
                      level={level}
                      catalog={catalog}
                      onEdit={() => startEdit(level)}
                      onDelete={() => onDelete(level)}
                      busy={busy}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                Built-in levels
              </h2>
              <ul className="space-y-2">
                {systemLevels.map((level) => (
                  <LevelCard key={level.id} level={level} catalog={catalog} readOnly />
                ))}
              </ul>
            </section>
          </div>

          <aside className="h-fit rounded-card border border-border-strong bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-text-primary">
                {editingId ? 'Edit level' : 'New custom level'}
              </h2>
              {editingId ? (
                <button
                  type="button"
                  onClick={startCreate}
                  className="text-[12px] font-medium text-text-secondary hover:text-text-primary"
                >
                  + New
                </button>
              ) : null}
            </div>

            {formError ? (
              <div className="mb-3 rounded-input-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                {formError}
              </div>
            ) : null}

            <label className={LABEL}>Name</label>
            <input
              className={FIELD}
              value={form.name}
              maxLength={60}
              placeholder="e.g. Senior Stylist"
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />

            <label className={`${LABEL} mt-3`}>Description</label>
            <input
              className={FIELD}
              value={form.description}
              maxLength={280}
              placeholder="Optional"
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            />

            <label className={`${LABEL} mt-3`}>Base role</label>
            <select
              className={FIELD}
              value={form.baseRole}
              disabled={!!editingId}
              onChange={(e) =>
                setForm((p) => ({ ...p, baseRole: e.target.value as SecurityLevelBaseRole }))
              }
            >
              {(Object.keys(BASE_ROLE_LABELS) as SecurityLevelBaseRole[]).map((role) => (
                <option key={role} value={role}>
                  {BASE_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-text-secondary">
              Determines location scope. The permissions below decide what they can see and do.
            </p>

            <div className="mt-4 space-y-3">
              {groups.map(([group, defs]) => (
                <div key={group}>
                  <div className="mb-1 text-[12px] font-semibold text-text-primary">{group}</div>
                  <div className="space-y-1">
                    {defs.map((def) => (
                      <label
                        key={def.key}
                        className="flex cursor-pointer items-start gap-2 text-[12px] text-text-secondary"
                        title={def.description}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={form.permissions.has(def.key)}
                          onChange={() => togglePermission(def.key)}
                        />
                        <span>
                          <span className="text-text-primary">{def.label}</span>
                          {def.kind === 'report' ? (
                            <span className="ml-1 rounded-pill bg-surface-alt px-1.5 py-0.5 text-[10px] text-text-secondary">
                              report
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => void onSubmit()}
              className="mt-4 w-full rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            >
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Create level'}
            </button>
          </aside>
        </div>
      )}
    </div>
  );
}

function LevelCard({
  level,
  catalog,
  onEdit,
  onDelete,
  readOnly,
  busy,
}: {
  level: SecurityLevel;
  catalog: PermissionDefinition[];
  onEdit?: () => void;
  onDelete?: () => void;
  readOnly?: boolean;
  busy?: boolean;
}) {
  const labelByKey = useMemo(
    () => new Map(catalog.map((d) => [d.key, d.label])),
    [catalog],
  );
  return (
    <li className="rounded-card border border-border-strong bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-text-primary">{level.name}</span>
            {level.isSystem ? (
              <span className="rounded-pill bg-surface-alt px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
                Built-in
              </span>
            ) : null}
          </div>
          {level.description ? (
            <p className="mt-0.5 text-[12px] text-text-secondary">{level.description}</p>
          ) : null}
        </div>
        {!readOnly ? (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onEdit}
              className="rounded-pill border border-border-strong px-3 py-1 text-[12px] font-medium text-text-secondary hover:bg-surface-alt disabled:opacity-60"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="rounded-pill border border-danger/40 px-3 py-1 text-[12px] font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {level.permissions.length === 0 ? (
          <span className="text-[11px] text-text-secondary">No permissions</span>
        ) : (
          level.permissions.map((p) => (
            <span
              key={p}
              className="rounded-pill bg-surface-alt px-2 py-0.5 text-[11px] text-text-secondary"
            >
              {labelByKey.get(p) ?? p}
            </span>
          ))
        )}
      </div>
    </li>
  );
}
