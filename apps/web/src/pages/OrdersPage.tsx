import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  BusinessLocationSummary,
  GeneratePurchaseOrdersResponse,
  PurchaseOrder,
  PurchaseOrderStatus,
} from '@sheer/domain';
import { userHasAnyRole, userHasPermission } from '@sheer/domain';
import {
  cancelPurchaseOrder,
  generatePurchaseOrders,
  listPurchaseOrders,
  sendPurchaseOrder,
  submitPurchaseOrder,
  updatePurchaseOrder,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';

type StatusFilter = PurchaseOrderStatus | 'all';

const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  // Legacy: nothing reaches this state since migration 0100, which moved every
  // row to 'approved'. The label stays so a historical row still renders.
  pending_approval: 'Awaiting approval',
  approved: 'Ready to send',
  sent: 'Sent',
  cancelled: 'Cancelled',
};

const STATUS_TONES: Record<PurchaseOrderStatus, string> = {
  draft: 'border-border-strong bg-surface-alt text-text-secondary',
  pending_approval: 'border-warning-border bg-warning-soft text-warning',
  approved: 'border-primary bg-primary-soft text-primary-deep',
  sent: 'border-success-border bg-success-soft text-success',
  cancelled: 'border-border bg-surface-alt text-text-muted',
};

export function OrdersPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canManage = userHasPermission(auth.user, 'orders.manage');
  const canApprove = userHasPermission(auth.user, 'orders.approve');
  const { selectedLocationId: scopeLocationId, isAllLocations } = useLocationScope();

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [locations, setLocations] = useState<BusinessLocationSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [generateLocationId, setGenerateLocationId] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lineEdits, setLineEdits] = useState<Record<string, string>>({});
  // Draft notes keyed by order id. Undefined means "not touched in this session",
  // which is what keeps an untouched order out of the PATCH payload entirely.
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listPurchaseOrders(accessToken, {
        locationId: isAllLocations ? undefined : scopeLocationId,
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setOrders(result.orders);
      setLocations(result.locations);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load purchase orders');
    } finally {
      setLoading(false);
    }
  }, [accessToken, scopeLocationId, isAllLocations, statusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!isAllLocations) setGenerateLocationId(scopeLocationId);
    else setGenerateLocationId((current) => current || locations[0]?.id || '');
  }, [isAllLocations, scopeLocationId, locations]);

  if (auth.status === 'authenticated' && !userHasAnyRole(auth.user, ['owner', 'manager'])) {
    return <Navigate to="/unauthorized" replace />;
  }

  function upsertOrder(order: PurchaseOrder) {
    setOrders((current) =>
      current.some((entry) => entry.id === order.id)
        ? current.map((entry) => (entry.id === order.id ? order : entry))
        : [order, ...current],
    );
  }

  async function handleGenerate() {
    if (!accessToken || !generateLocationId) return;
    setBusy('generate');
    setError(null);
    setNotice(null);
    try {
      const result = await generatePurchaseOrders(accessToken, { locationId: generateLocationId });
      setNotice(describeGenerateResult(result));
      void reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not generate orders');
    } finally {
      setBusy(null);
    }
  }

  async function runAction(
    order: PurchaseOrder,
    label: string,
    action: () => Promise<{ order: PurchaseOrder }>,
  ) {
    if (!accessToken) return;
    setBusy(`${label}-${order.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      upsertOrder(result.order);
      setNotice(`${result.order.orderNumber} ${label}.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Could not ${label} order`);
    } finally {
      setBusy(null);
    }
  }

  async function handleSend(order: PurchaseOrder) {
    if (!accessToken) return;
    setBusy(`send-${order.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await sendPurchaseOrder(accessToken, order.id);
      upsertOrder(result.order);
      if (result.delivered) {
        setNotice(`${result.order.orderNumber} sent to ${result.order.sentToEmail}.`);
      } else {
        setError(`Send failed: ${result.error ?? 'unknown error'}. The order stays ready to send. Fix and retry.`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send order');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Saves quantities AND notes in one request — `PATCH /orders/:id` already
   * accepts both, so there is no reason to make staff press two buttons or to
   * risk saving one and losing the other.
   *
   * Returns true when the order is safe to act on next (saved, or nothing to
   * save), so `handleSubmit` can chain onto it without re-implementing any of it.
   */
  async function handleSaveChanges(order: PurchaseOrder, silent = false): Promise<boolean> {
    if (!accessToken) return false;
    const changes = order.lines
      .map((line) => {
        const edited = lineEdits[line.id];
        if (edited === undefined) return null;
        const quantity = Number(edited);
        if (!Number.isInteger(quantity) || quantity < 0 || quantity === line.orderedQuantity) return null;
        return { id: line.id, orderedQuantity: quantity };
      })
      .filter((change): change is { id: string; orderedQuantity: number } => change !== null);

    const editedNote = noteEdits[order.id];
    const noteChanged = editedNote !== undefined && editedNote.trim() !== (order.notes ?? '').trim();

    if (changes.length === 0 && !noteChanged) return true;

    setBusy(`save-${order.id}`);
    setError(null);
    try {
      const result = await updatePurchaseOrder(accessToken, order.id, {
        ...(changes.length > 0 ? { lines: changes } : {}),
        ...(noteChanged ? { notes: editedNote } : {}),
      });
      upsertOrder(result.order);
      setLineEdits({});
      setNoteEdits((current) => {
        const next = { ...current };
        delete next[order.id];
        return next;
      });
      if (!silent) {
        setNotice(
          `${result.order.orderNumber} updated${noteChanged ? ' (including notes)' : ''}.`,
        );
      }
      return true;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update order');
      return false;
    } finally {
      setBusy(null);
    }
  }

  /**
   * "Submit for order". Flushes any unsaved edits first: notes typed but not
   * explicitly saved must reach the supplier, and submitting locks the order for
   * editing — so a silent drop here would be invisible until the email went out
   * missing the note. If the save fails the submit does not run.
   */
  async function handleSubmit(order: PurchaseOrder) {
    if (!accessToken) return;
    const saved = await handleSaveChanges(order, true);
    if (!saved) return;
    await runAction(order, 'submitted', () => submitPurchaseOrder(accessToken, order.id));
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Purchase orders</h1>
          <p className="mt-1 max-w-lg text-[13px] text-text-secondary">
            Suggested from trailing usage, grouped by supplier. Drafts are editable: adjust
            quantities and add any notes for the supplier, submit for order, then send the
            order form by email.
          </p>
        </div>
        {canManage ? (
          <div className="flex items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-text-secondary">Location</span>
              <select
                value={generateLocationId}
                onChange={(event) => setGenerateLocationId(event.target.value)}
                className="h-10 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
              >
                {locations.length === 0 ? <option value="">No locations</option> : null}
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
              onClick={() => void handleGenerate()}
              disabled={busy === 'generate' || !generateLocationId}
            >
              {busy === 'generate' ? 'Generating…' : 'Generate suggested orders'}
            </button>
          </div>
        ) : null}
      </header>

      {notice ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {(['all', 'draft', 'approved', 'sent', 'cancelled'] as StatusFilter[]).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setStatusFilter(status)}
            className={`h-9 rounded-pill border px-4 text-[13px] font-medium transition ${
              statusFilter === status
                ? 'border-primary bg-primary-soft text-primary-deep'
                : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
            }`}
          >
            {status === 'all' ? 'All' : STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      {loading && orders.length === 0 ? (
        <EmptyState label="Loading purchase orders…" />
      ) : orders.length === 0 ? (
        <EmptyState
          label={
            statusFilter === 'all'
              ? 'No purchase orders yet. Generate suggestions to create the first drafts.'
              : `No ${STATUS_LABELS[statusFilter as PurchaseOrderStatus].toLowerCase()} orders.`
          }
        />
      ) : (
        <div className="space-y-4">
          {orders.map((order) => {
            const expanded = expandedId === order.id;
            const isDraft = order.status === 'draft';
            return (
              <section key={order.id} className="rounded-card-lg border border-border bg-surface shadow-card">
                <button
                  type="button"
                  className="flex w-full flex-col gap-2 px-5 py-4 text-left sm:flex-row sm:items-center sm:justify-between"
                  onClick={() => setExpandedId(expanded ? null : order.id)}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-semibold text-text-primary">{order.orderNumber}</span>
                    <span className="text-[13px] text-text-secondary">{order.supplierName}</span>
                    <span className="text-[12px] text-text-muted">{order.locationName}</span>
                    <span
                      className={`inline-flex items-center rounded-pill border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STATUS_TONES[order.status]}`}
                    >
                      {STATUS_LABELS[order.status]}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-[13px] text-text-secondary">
                    <span>{order.lines.length} line{order.lines.length === 1 ? '' : 's'}</span>
                    {order.subtotalCents > 0 ? (
                      <span className="font-semibold text-text-primary">{formatPounds(order.subtotalCents)}</span>
                    ) : null}
                    <span className="text-text-muted">{formatDate(order.createdAt)}</span>
                  </div>
                </button>

                {order.sendError && order.status !== 'sent' ? (
                  <div className="border-t border-danger-border bg-danger-soft px-5 py-2.5 text-[13px] text-danger">
                    Last send failed: {order.sendError}
                  </div>
                ) : null}

                {expanded ? (
                  <div className="border-t border-border">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left text-[13px]">
                        <thead className="bg-surface-alt text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                          <tr>
                            <th className="px-5 py-2.5 font-medium">Product</th>
                            <th className="px-5 py-2.5 text-right font-medium">Pack</th>
                            <th className="px-5 py-2.5 text-right font-medium">Suggested</th>
                            <th className="px-5 py-2.5 text-right font-medium">Ordering</th>
                            <th className="px-5 py-2.5 text-right font-medium">Est. total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {order.lines.map((line) => (
                            <tr key={line.id}>
                              <td className="px-5 py-3 font-medium text-text-primary">{line.productName}</td>
                              <td className="px-5 py-3 text-right text-text-secondary">{packLabel(line.packSize, line.stockUnit)}</td>
                              <td className="px-5 py-3 text-right text-text-secondary">{line.suggestedQuantity}</td>
                              <td className="px-5 py-3 text-right">
                                {isDraft && canManage ? (
                                  <input
                                    inputMode="numeric"
                                    value={lineEdits[line.id] ?? String(line.orderedQuantity)}
                                    onChange={(event) =>
                                      setLineEdits((current) => ({
                                        ...current,
                                        [line.id]: event.target.value.replace(/[^0-9]/g, ''),
                                      }))
                                    }
                                    className="h-8 w-20 rounded-input border border-border-strong bg-surface px-2 text-right text-[13px] outline-none focus:border-primary"
                                  />
                                ) : (
                                  <span className="font-semibold text-text-primary">{line.orderedQuantity}</span>
                                )}
                              </td>
                              <td className="px-5 py-3 text-right text-text-secondary">
                                {line.lineTotalCents > 0 ? formatPounds(line.lineTotalCents) : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/*
                      Notes reach the SUPPLIER: renderPurchaseOrderEmail puts this
                      text in the order email, so the label says so plainly rather
                      than leaving staff to guess it is an internal memo.
                      Editable only while the order is a draft, matching the API,
                      which rejects edits once an order is ready to send.
                    */}
                    {isDraft && canManage ? (
                      <div className="border-t border-border px-5 py-4">
                        <label
                          htmlFor={`notes-${order.id}`}
                          className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                        >
                          Notes
                          <span className="ml-2 font-normal text-text-muted">
                            Included in the email to {order.supplierName}
                          </span>
                        </label>
                        <textarea
                          id={`notes-${order.id}`}
                          rows={3}
                          maxLength={1000}
                          value={noteEdits[order.id] ?? order.notes ?? ''}
                          onChange={(event) =>
                            setNoteEdits((current) => ({ ...current, [order.id]: event.target.value }))
                          }
                          placeholder="e.g. Please deliver before Friday"
                          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
                        />
                      </div>
                    ) : order.notes ? (
                      <div className="border-t border-border px-5 py-4">
                        <div className="mb-1 text-[13px] font-medium text-text-secondary">Notes</div>
                        <p className="whitespace-pre-wrap text-[13px] text-text-primary">{order.notes}</p>
                      </div>
                    ) : null}

                    <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-[12px] text-text-muted">
                        {order.submittedAt ? `Submitted ${formatDate(order.submittedAt)}. ` : ''}
                        {order.approvedAt && !order.submittedAt ? `Approved ${formatDate(order.approvedAt)}. ` : ''}
                        {order.sentAt ? `Sent ${formatDate(order.sentAt)} to ${order.sentToEmail}. ` : ''}
                        {order.cancelledAt ? `Cancelled ${formatDate(order.cancelledAt)}. ` : ''}
                        {!order.supplierEmail && order.status !== 'sent'
                          ? 'Supplier has no order email. Add one under Inventory → Suppliers before sending.'
                          : ''}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {isDraft && canManage ? (
                          <>
                            <ActionButton
                              label="Save changes"
                              busy={busy === `save-${order.id}`}
                              onClick={() => void handleSaveChanges(order)}
                            />
                            <ActionButton
                              label="Submit for order"
                              primary
                              busy={busy === `submitted-${order.id}`}
                              onClick={() => void handleSubmit(order)}
                            />
                          </>
                        ) : null}
                        {order.status === 'approved' && canApprove ? (
                          <ActionButton
                            label={order.sendError ? 'Retry send' : 'Send to supplier'}
                            primary
                            busy={busy === `send-${order.id}`}
                            onClick={() => void handleSend(order)}
                          />
                        ) : null}
                        {(order.status === 'draft' || order.status === 'pending_approval') && canManage ? (
                          <ActionButton
                            label="Cancel order"
                            danger
                            busy={busy === `cancelled-${order.id}`}
                            onClick={() =>
                              void runAction(order, 'cancelled', () =>
                                cancelPurchaseOrder(accessToken as string, order.id),
                              )
                            }
                          />
                        ) : null}
                        {order.status === 'approved' && canApprove ? (
                          <ActionButton
                            label="Cancel order"
                            danger
                            busy={busy === `cancelled-${order.id}`}
                            onClick={() =>
                              void runAction(order, 'cancelled', () =>
                                cancelPurchaseOrder(accessToken as string, order.id),
                              )
                            }
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function describeGenerateResult(result: GeneratePurchaseOrdersResponse): ReactNode {
  if (result.nothingNeeded) {
    return 'Nothing needs ordering. Every stocked product covers its forecast usage.';
  }
  const parts: string[] = [];
  if (result.created.length > 0) {
    parts.push(
      `Created ${result.created.length} draft${result.created.length === 1 ? '' : 's'}: ${result.created
        .map((order) => `${order.orderNumber} (${order.supplierName})`)
        .join(', ')}.`,
    );
  }
  if (result.skippedExistingOrder.length > 0) {
    parts.push(
      `Skipped ${result.skippedExistingOrder
        .map((entry) => `${entry.supplierName} (open order ${entry.orderNumber} already exists)`)
        .join('; ')}.`,
    );
  }
  if (result.unorderable.length > 0) {
    parts.push(
      `Could not order: ${result.unorderable
        .map(
          (entry) =>
            `${entry.productName} (${entry.reason === 'no_supplier' ? 'no supplier assigned' : 'no pack size recorded'})`,
        )
        .join('; ')}.`,
    );
  }
  return parts.join(' ');
}

function ActionButton({
  label,
  onClick,
  busy,
  primary,
  danger,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const cls = primary
    ? 'bg-primary text-text-on-primary hover:bg-primary-deep'
    : danger
      ? 'border border-danger-border text-danger hover:bg-danger-soft'
      : 'border border-border-strong text-text-primary hover:bg-surface-alt';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`h-9 rounded-pill px-4 text-[12px] font-semibold transition disabled:opacity-50 ${cls}`}
    >
      {busy ? 'Working…' : label}
    </button>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-card-lg border border-border bg-surface px-4 py-12 text-center text-[13px] text-text-secondary">
      {label}
    </div>
  );
}

function packLabel(packSize: number | undefined, stockUnit: 'gram' | 'millilitre' | 'unit'): string {
  if (stockUnit === 'unit') return 'unit';
  if (!packSize) return '-';
  return `${packSize}${stockUnit === 'millilitre' ? 'ml' : 'g'}`;
}

function formatPounds(cents: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(cents / 100);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(value),
  );
}
