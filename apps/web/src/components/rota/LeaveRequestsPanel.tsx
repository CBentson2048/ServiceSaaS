import { useEffect, useState } from 'react';
import type {
  LeaveRequestStatus,
  ListLeaveRequestsResponse,
  RotaLeaveRequest,
} from '@sheer/domain';
import { AppButton } from '../../design';
import {
  ApiRequestError,
  approveRotaLeaveRequest,
  listRotaLeaveRequests,
  rejectRotaLeaveRequest,
} from '../../auth/api';

interface LeaveRequestsPanelProps {
  accessToken: string;
  locationId: string;
}

const FILTERS: { id: LeaveRequestStatus | 'all'; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

export function LeaveRequestsPanel({ accessToken, locationId }: LeaveRequestsPanelProps) {
  const [data, setData] = useState<ListLeaveRequestsResponse | null>(null);
  const [filter, setFilter] = useState<LeaveRequestStatus | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await listRotaLeaveRequests(accessToken, {
          locationId,
          status: filter,
        });
        if (!cancelled) setData(result);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load leave requests');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, locationId, filter]);

  async function handleApprove(req: RotaLeaveRequest, override: boolean) {
    setBusyId(req.id);
    setActionMessage(null);
    setError(null);
    try {
      const result = await approveRotaLeaveRequest(accessToken, req.id, { override });
      setData((current) => (current ? upsertLeave(current, result.leaveRequest) : current));
      setActionMessage(
        override
          ? `Approved with override of the ${data?.holidayNoticeDays ?? 30}-day notice rule.`
          : 'Leave request approved.',
      );
    } catch (err) {
      if (err instanceof Error) setError(err.message);
      else setError('Could not approve leave request');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(req: RotaLeaveRequest) {
    const reason = window.prompt('Reason (optional, shown to the stylist):') ?? undefined;
    setBusyId(req.id);
    setActionMessage(null);
    setError(null);
    try {
      const result = await rejectRotaLeaveRequest(accessToken, req.id, { reason });
      setData((current) => (current ? upsertLeave(current, result.leaveRequest) : current));
      setActionMessage('Leave request rejected.');
    } catch (err) {
      if (err instanceof Error) setError(err.message);
      else setError('Could not reject leave request');
    } finally {
      setBusyId(null);
    }
  }

  const requests = data?.leaveRequests ?? [];

  return (
    <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
      <header className="flex flex-col gap-2 border-b border-border bg-surface-alt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Leave requests
          </div>
          <div className="mt-0.5 text-[12px] text-text-secondary">
            Holiday notice rule: {data?.holidayNoticeDays ?? 30} days. Requests inside the
            window auto-decline unless you override.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`h-8 rounded-pill border px-3 text-[12px] font-medium transition ${
                filter === f.id
                  ? 'border-primary bg-primary-soft text-primary-deep'
                  : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
              }`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {actionMessage ? (
        <div className="border-b border-border bg-success-soft/50 px-4 py-2 text-[12px] text-success">
          {actionMessage}
        </div>
      ) : null}
      {error ? (
        <div className="border-b border-border bg-danger-soft/60 px-4 py-2 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="px-4 py-6 text-center text-[13px] text-text-secondary">
          Loading leave requests…
        </div>
      ) : requests.length === 0 ? (
        <div className="px-4 py-6 text-center text-[13px] text-text-secondary">
          No leave requests for this filter.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {requests.map((req) => (
            <LeaveRow
              key={req.id}
              request={req}
              busy={busyId === req.id}
              onApprove={() => handleApprove(req, false)}
              onApproveOverride={() => handleApprove(req, true)}
              onReject={() => handleReject(req)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function upsertLeave(
  current: ListLeaveRequestsResponse,
  next: RotaLeaveRequest,
): ListLeaveRequestsResponse {
  const idx = current.leaveRequests.findIndex((r) => r.id === next.id);
  const list = current.leaveRequests.slice();
  if (idx === -1) list.unshift(next);
  else list[idx] = next;
  return { ...current, leaveRequests: list };
}

function LeaveRow({
  request,
  busy,
  onApprove,
  onApproveOverride,
  onReject,
}: {
  request: RotaLeaveRequest;
  busy: boolean;
  onApprove: () => void;
  onApproveOverride: () => void;
  onReject: () => void;
}) {
  const isPending = request.status === 'pending';
  const insideThreshold = request.insideNoticeWindow;

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-[13px] font-medium text-text-primary">
          {request.staff?.displayName ?? request.staffProfileId}{' '}
          <span
            className={`ml-2 inline-flex h-5 items-center rounded-pill px-2 text-[10px] font-medium uppercase tracking-[0.06em] ${statusTone(request.status)}`}
          >
            {request.status}
          </span>
          {isPending && insideThreshold ? (
            <span className="ml-2 inline-flex h-5 items-center rounded-pill border border-warning-border bg-warning-soft px-2 text-[10px] font-medium text-warning">
              Inside notice rule
            </span>
          ) : null}
        </div>
        <div className="text-[12px] text-text-secondary">
          {formatLeaveRange(request)} · starts in{' '}
          {request.noticeDays >= 0 ? `${request.noticeDays} day${request.noticeDays === 1 ? '' : 's'}` : 'the past'}
          {request.reason ? <> · &ldquo;{request.reason}&rdquo;</> : null}
        </div>
      </div>
      {isPending ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {insideThreshold ? (
            <AppButton
              variant="secondary"
              size="sm"
              onClick={onApproveOverride}
              disabled={busy}
            >
              Approve with override
            </AppButton>
          ) : (
            <AppButton variant="success" size="sm" onClick={onApprove} disabled={busy}>
              Approve
            </AppButton>
          )}
          <AppButton variant="danger" size="sm" onClick={onReject} disabled={busy}>
            Reject
          </AppButton>
        </div>
      ) : null}
    </li>
  );
}

function statusTone(status: LeaveRequestStatus): string {
  switch (status) {
    case 'pending':
      return 'border border-primary/30 bg-primary-soft text-primary-deep';
    case 'approved':
      return 'border border-success-border bg-success-soft text-success';
    case 'rejected':
      return 'border border-danger-border bg-danger-soft text-danger';
    case 'cancelled':
    default:
      return 'border border-border-strong bg-surface-alt text-text-secondary';
  }
}

function formatLeaveRange(req: RotaLeaveRequest): string {
  const start = new Date(`${req.startDate}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const end = new Date(`${req.endDate}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return start === end ? start : `${start} – ${end}`;
}
