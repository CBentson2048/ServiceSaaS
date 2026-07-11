import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  Permission,
  PermissionDefinition,
  SecurityLevel,
  SecurityLevelBaseRole,
} from '@sheer/domain';
import {
  expandPermissions,
  getPermissionDependents,
  userHasRole,
} from '@sheer/domain';
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

  // Build one tree per group. A permission nests under a prerequisite that
  // lives in the same group (e.g. crm.manage under crm.view); cross-group
  // prerequisites are surfaced as a "requires" hint instead. This turns the
  // flat catalogue into the dependency tree the page renders.
  const groupTrees = useMemo(() => buildGroupTrees(catalog), [catalog]);

  const customLevels = levels.filter((l) => !l.isSystem);
  const systemLevels = levels.filter((l) => l.isSystem);
  const editingSystem = levels.some((level) => level.id === editingId && level.isSystem);

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

  // Toggling respects the dependency tree: enabling a permission pulls in its
  // prerequisites; disabling one drops everything that depends on it.
  function setPermission(key: Permission, checked: boolean) {
    setForm((prev) => {
      let next: Set<Permission>;
      if (checked) {
        next = new Set(expandPermissions([...prev.permissions, key]));
      } else {
        next = new Set(prev.permissions);
        next.delete(key);
        for (const dependent of getPermissionDependents(key)) next.delete(dependent);
      }
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
        await updateSecurityLevel(
          accessToken,
          editingId,
          editingSystem
            ? { permissions }
            : {
                name,
                description: form.description.trim() || null,
                permissions,
              },
        );
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
                  <LevelCard
                    key={level.id}
                    level={level}
                    catalog={catalog}
                    onEdit={() => startEdit(level)}
                    busy={busy}
                  />
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
              disabled={editingSystem}
              maxLength={60}
              placeholder="e.g. Senior Stylist"
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />

            <label className={`${LABEL} mt-3`}>Description</label>
            <input
              className={FIELD}
              value={form.description}
              disabled={editingSystem}
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
              {editingSystem
                ? 'Built-in names and base roles stay fixed. Add or remove permissions below.'
                : 'Determines location scope. The permissions below decide what they can see and do.'}
            </p>

            <div className="mt-4 space-y-3">
              <p className="text-[11px] text-text-secondary">
                Turning on a feature automatically enables everything it needs (its nested
                requirements and anything listed under “also enables”). Turning off a requirement
                removes any feature that depends on it.
              </p>
              {groupTrees.map(({ group, roots, labelByKey }) => (
                <div key={group}>
                  <div className="mb-1 text-[12px] font-semibold text-text-primary">{group}</div>
                  <div className="space-y-1">
                    {roots.map((node) => (
                      <PermissionNode
                        key={node.def.key}
                        node={node}
                        selected={form.permissions}
                        labelByKey={labelByKey}
                        onChange={setPermission}
                      />
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

interface PermissionTreeNode {
  def: PermissionDefinition;
  /** Required permissions nested directly beneath this feature. */
  children: PermissionTreeNode[];
  /**
   * Other requirements this feature pulls in that aren't nested here (they live
   * under a different owner or are higher-level capabilities). Shown as an
   * "also enables" hint so the dependency is explicit.
   */
  requiresHint: Permission[];
}

interface GroupTree {
  group: string;
  roots: PermissionTreeNode[];
  labelByKey: Map<Permission, string>;
}

/**
 * Turn the flat catalogue into one dependency tree per group, oriented so the
 * high-level feature is the PARENT and the permissions it requires are its
 * CHILDREN. Selecting a parent therefore cascades down to everything it needs
 * (see {@link expandPermissions}).
 *
 * Nesting rule: a "read" prerequisite (a leaf permission with no requirements of
 * its own, e.g. `crm.view`) nests under the single feature that owns it — the
 * first feature in catalogue order that requires it. Any other requirement (a
 * shared read owned elsewhere, or a higher-level capability like `staff.manage`
 * under `staff.pay.manage`) is surfaced as an "also enables" hint instead of
 * being duplicated. Every permission is therefore reachable exactly once, and
 * every dependency edge is visible.
 */
function buildGroupTrees(catalog: PermissionDefinition[]): GroupTree[] {
  const defByKey = new Map<Permission, PermissionDefinition>(catalog.map((d) => [d.key, d]));
  const labelByKey = new Map<Permission, string>(catalog.map((d) => [d.key, d.label]));
  const isLeaf = (key: Permission) => (defByKey.get(key)?.requires ?? []).length === 0;

  // Each leaf requirement nests under the feature that "owns" it: the most
  // dedicated requirer (fewest total requirements), tie-broken by catalogue
  // order. So `services.view` nests under "Manage services" (1 requirement)
  // rather than "Manage bookings" (3), which lists it as a hint instead.
  const requirersOf = new Map<Permission, Permission[]>();
  for (const def of catalog) {
    for (const req of def.requires ?? []) {
      if (!isLeaf(req)) continue;
      const list = requirersOf.get(req) ?? [];
      list.push(def.key);
      requirersOf.set(req, list);
    }
  }
  const requiresCount = (key: Permission) => (defByKey.get(key)?.requires ?? []).length;
  const ownerOf = new Map<Permission, Permission>();
  for (const [leaf, requirers] of requirersOf) {
    let owner = requirers[0];
    for (const candidate of requirers) {
      if (requiresCount(candidate) < requiresCount(owner)) owner = candidate;
    }
    ownerOf.set(leaf, owner);
  }

  const buildNode = (key: Permission): PermissionTreeNode => {
    const def = defByKey.get(key)!;
    const requires = def.requires ?? [];
    const children = requires
      .filter((req) => ownerOf.get(req) === key)
      .map((req) => buildNode(req));
    const nested = new Set(children.map((c) => c.def.key));
    return { def, children, requiresHint: requires.filter((req) => !nested.has(req)) };
  };

  const groupOrder: string[] = [];
  const rootsByGroup = new Map<string, PermissionTreeNode[]>();
  for (const def of catalog) {
    // Owned leaves only appear nested under their owner, never as a root.
    if (ownerOf.has(def.key)) continue;
    if (!rootsByGroup.has(def.group)) {
      rootsByGroup.set(def.group, []);
      groupOrder.push(def.group);
    }
    rootsByGroup.get(def.group)!.push(buildNode(def.key));
  }

  return groupOrder.map((group) => ({ group, roots: rootsByGroup.get(group)!, labelByKey }));
}

function PermissionNode({
  node,
  selected,
  labelByKey,
  onChange,
}: {
  node: PermissionTreeNode;
  selected: Set<Permission>;
  labelByKey: Map<Permission, string>;
  onChange: (key: Permission, checked: boolean) => void;
}) {
  const { def, children, requiresHint } = node;
  return (
    <div>
      <label
        className="flex cursor-pointer items-start gap-2 text-[12px] text-text-secondary"
        title={def.description}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={selected.has(def.key)}
          onChange={(e) => onChange(def.key, e.target.checked)}
        />
        <span>
          <span className="text-text-primary">{def.label}</span>
          {def.kind === 'report' ? (
            <span className="ml-1 rounded-pill bg-surface-alt px-1.5 py-0.5 text-[10px] text-text-secondary">
              report
            </span>
          ) : null}
          {requiresHint.length ? (
            <span className="ml-1 text-[10px] text-text-muted">
              · also enables {requiresHint.map((r) => labelByKey.get(r) ?? r).join(', ')}
            </span>
          ) : null}
        </span>
      </label>
      {children.length ? (
        <div className="ml-3 mt-1 space-y-1 border-l border-border-strong pl-3">
          {children.map((child) => (
            <PermissionNode
              key={child.def.key}
              node={child}
              selected={selected}
              labelByKey={labelByKey}
              onChange={onChange}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LevelCard({
  level,
  catalog,
  onEdit,
  onDelete,
  busy,
}: {
  level: SecurityLevel;
  catalog: PermissionDefinition[];
  onEdit?: () => void;
  onDelete?: () => void;
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
        {onEdit || onDelete ? (
          <div className="flex shrink-0 gap-2">
            {onEdit ? (
              <button
                type="button"
                disabled={busy}
                onClick={onEdit}
                className="rounded-pill border border-border-strong px-3 py-1 text-[12px] font-medium text-text-secondary hover:bg-surface-alt disabled:opacity-60"
              >
                Edit permissions
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="rounded-pill border border-danger/40 px-3 py-1 text-[12px] font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
              >
                Delete
              </button>
            ) : null}
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
