import { useCallback, useEffect, useState } from 'react';
import type {
  AmendPayAssignmentResponse,
  AssignPayStructureResponse,
  PayStructureSummary,
  StaffPayAssignmentDetail,
} from '@sheer/domain';
import { AppButton, AppText } from '../../design';
import { Modal } from '../team/Modal';
import { formatLocalDate, todayLocalIso } from './format';
import { exclusiveEndDayLabel } from './structureFormat';
import { useAuth } from '../../auth/AuthProvider';
import {
  ApiRequestError,
  amendStaffPayAssignment,
  assignPayStructure,
  getStaffPayAssignment,
  listPayStructures,
} from '../../auth/api';

const INPUT_CLASSES =
  'w-full rounded-input-lg border border-border-strong bg-surface px-3.5 py-2.5 text-[14px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-surface-alt';

/**
 * Puts one staff member on a pay structure. Only ACTIVE structures are
 * offered; the server closes any open assignment at the new effective date and
 * reports it back, which is surfaced verbatim so the actor can see exactly
 * which rules stopped applying and when.
 *
 * Picking the plan they are ALREADY on switches the modal into start-date
 * correction: the server amends the current assignment's start (welding the
 * previous plan's end to it) instead of refusing with a duplicate error.
 */
export function AssignStructureModal({
  staffProfileId,
  staffName,
  defaultEffectiveFrom,
  onClose,
  onAssigned,
}: {
  staffProfileId: string;
  staffName: string;
  /**
   * Rule resolution happens at the PERIOD START, so when this modal is opened
   * from a period's readiness panel the default must be that period's start
   * date — an assignment starting "today" would not cover a period already in
   * progress and the staff member would stay blocked.
   */
  defaultEffectiveFrom?: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;

  const [structures, setStructures] = useState<PayStructureSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [structureId, setStructureId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(defaultEffectiveFrom ?? todayLocalIso());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssignPayStructureResponse | null>(null);
  const [amendResult, setAmendResult] = useState<AmendPayAssignmentResponse | null>(null);
  /** The open (unended) assignment — the row a start-date correction targets. */
  const [openAssignment, setOpenAssignment] = useState<StaffPayAssignmentDetail | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      listPayStructures(accessToken),
      // Silent on failure: without it the modal simply behaves as before
      // (same-structure submits surface the server's conflict message).
      getStaffPayAssignment(accessToken, staffProfileId).catch(() => null),
    ])
      .then(([structuresRes, assignmentRes]) => {
        if (cancelled) return;
        setStructures(structuresRes.structures.filter((structure) => structure.isActive));
        setOpenAssignment(assignmentRes?.openAssignment ?? assignmentRes?.assignment ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiRequestError ? err.message : 'Unable to load pay plans');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, staffProfileId]);

  const isDateFix = openAssignment !== null && structureId === openAssignment.structureId;

  const handleSubmit = useCallback(async () => {
    if (!accessToken) return;
    if (!structureId) {
      setError('Pick a pay plan.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setError('Pick an effective-from date.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (isDateFix) {
        const response = await amendStaffPayAssignment(accessToken, staffProfileId, {
          effectiveFrom,
        });
        setAmendResult(response);
      } else {
        const response = await assignPayStructure(accessToken, staffProfileId, {
          structureId,
          effectiveFrom,
        });
        setResult(response);
      }
      onAssigned();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : isDateFix
            ? 'Unable to update the start date'
            : 'Unable to assign the pay plan',
      );
    } finally {
      setSubmitting(false);
    }
  }, [accessToken, structureId, effectiveFrom, staffProfileId, isDateFix, onAssigned]);

  const done = result !== null || amendResult !== null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Assign pay plan"
      description={staffName}
      footer={
        done ? (
          <AppButton size="sm" onClick={onClose}>
            Done
          </AppButton>
        ) : (
          <>
            <AppButton size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </AppButton>
            <AppButton
              size="sm"
              onClick={() => void handleSubmit()}
              loading={submitting}
              disabled={loading || structures.length === 0}
            >
              {isDateFix ? 'Update start date' : 'Assign'}
            </AppButton>
          </>
        )
      }
    >
      {amendResult ? (
        <div className="space-y-3">
          <div className="rounded-input-lg border border-success-border bg-success-soft px-3 py-2.5">
            <AppText as="div" variant="caption" tone="success">
              {amendResult.assignment.structureName} now starts on{' '}
              {formatLocalDate(amendResult.assignment.effectiveFrom)} (was{' '}
              {formatLocalDate(amendResult.previousEffectiveFrom)}).
            </AppText>
          </div>
          {amendResult.staleFlaggedCount > 0 ? (
            <div className="rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5">
              <AppText as="div" variant="caption" tone="warning">
                {amendResult.staleFlaggedCount}{' '}
                {amendResult.staleFlaggedCount === 1
                  ? 'calculated pay summary is'
                  : 'calculated pay summaries are'}{' '}
                now stale — recalculate those periods before approving.
              </AppText>
            </div>
          ) : null}
          {amendResult.lockedPeriodCount > 0 ? (
            <AppText as="p" variant="caption" tone="muted">
              {amendResult.lockedPeriodCount} locked or paid{' '}
              {amendResult.lockedPeriodCount === 1 ? 'period keeps' : 'periods keep'} their
              original figures — use a pay adjustment if a correction is needed.
            </AppText>
          ) : null}
        </div>
      ) : result ? (
        <div className="space-y-3">
          <div className="rounded-input-lg border border-success-border bg-success-soft px-3 py-2.5">
            <AppText as="div" variant="caption" tone="success">
              {result.assignment.structureName} assigned from{' '}
              {formatLocalDate(result.assignment.effectiveFrom)}.
            </AppText>
          </div>
          {result.closedAssignment ? (
            <AppText as="p" variant="caption" tone="muted">
              Previous pay plan ended on{' '}
              {result.closedAssignment.effectiveTo
                ? exclusiveEndDayLabel(result.closedAssignment.effectiveTo)
                : formatLocalDate(effectiveFrom)}
              {result.closedAssignment.structureName
                ? ` (${result.closedAssignment.structureName})`
                : ''}
              .
            </AppText>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          {error ? (
            <div className="rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-6 text-center text-[13px] text-text-secondary">
              Loading pay plans…
            </div>
          ) : structures.length === 0 ? (
            <div className="rounded-input-lg border border-dashed border-border-strong bg-surface px-3 py-6 text-center text-[13px] text-text-secondary">
              No active pay plans yet. Create one under Staff pay → Pay plans first.
            </div>
          ) : (
            <>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                  Pay plan
                </span>
                <select
                  className={INPUT_CLASSES}
                  value={structureId}
                  onChange={(event) => setStructureId(event.target.value)}
                >
                  <option value="" disabled>
                    Pick a pay plan
                  </option>
                  {structures.map((structure) => (
                    <option key={structure.id} value={structure.id}>
                      {structure.name}
                      {openAssignment?.structureId === structure.id ? ' (current plan)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                  Effective from
                </span>
                <input
                  type="date"
                  className={INPUT_CLASSES}
                  value={effectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                />
                <span className="mt-1.5 block text-[12px] text-text-secondary">
                  {isDateFix && openAssignment
                    ? `They're already on this plan — this corrects its start date (currently ${formatLocalDate(openAssignment.effectiveFrom)}).`
                    : "If they're already on a plan, it ends on this date and this one takes over."}
                </span>
              </label>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
