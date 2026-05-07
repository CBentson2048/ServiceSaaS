import { useEffect, useMemo, useState } from 'react';
import type {
  RotaBreak,
  RotaShift,
  RotaStaffSummary,
} from '@sheer/domain';
import { AppButton } from '../../design';
import {
  ApiRequestError,
  addRotaBreak,
  createRotaShift,
  deleteRotaBreak,
  deleteRotaShift,
  updateRotaBreak,
  updateRotaShift,
} from '../../auth/api';
import { SelectField, TextField } from '../onboarding/FormField';
import { Modal } from '../team/Modal';
import { PastEditReasonDialog } from './PastEditReasonDialog';
import {
  combineDateAndTime,
  dateInputValue,
  formatTime,
  isPastDate,
  timeInputValue,
} from './dateUtils';

interface ShiftEditorModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (shift: RotaShift) => void;
  onDeleted: (shiftId: string) => void;
  accessToken: string;
  /** Manager: their assigned location id. Owner: the focused location id. */
  locationId: string;
  staff: RotaStaffSummary[];
  /** Provided when editing; absent when creating. */
  shift?: RotaShift;
  /** Pre-filled date when creating from a column header. */
  initialDate?: string;
  /** Pre-filled stylist when creating from a stylist row. */
  initialStaffProfileId?: string;
  draftMode?: boolean;
}

interface FormState {
  staffProfileId: string;
  date: string;
  startTime: string;
  endTime: string;
  notes: string;
}

export function ShiftEditorModal({
  open,
  onClose,
  onSaved,
  onDeleted,
  accessToken,
  locationId,
  staff,
  shift,
  initialDate,
  initialStaffProfileId,
  draftMode = false,
}: ShiftEditorModalProps) {
  const isEditing = Boolean(shift);

  const [form, setForm] = useState<FormState>(() => buildInitialForm(shift, initialDate, initialStaffProfileId, staff));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [breaks, setBreaks] = useState<RotaBreak[]>(shift?.breaks ?? []);
  // We wrap the deferred callback in an object so React's lazy-initialiser
  // detection (which is special-cased for plain function values) doesn't
  // accidentally invoke it during setState.
  const [pendingPastEdit, setPendingPastEdit] =
    useState<null | { run: (reason: string) => Promise<void> }>(null);
  const [pastEditTitle, setPastEditTitle] = useState('Edit past rota');

  useEffect(() => {
    if (!open) return;
    setForm(buildInitialForm(shift, initialDate, initialStaffProfileId, staff));
    setErrors({});
    setSubmitError(null);
    setBreaks(shift?.breaks ?? []);
    setPendingPastEdit(null);
  }, [open, shift, initialDate, initialStaffProfileId, staff]);

  const staffOptions = useMemo(
    () =>
      staff.map((s) => ({
        value: s.staffProfileId,
        label: s.displayName,
      })),
    [staff],
  );

  const selectedStaff = staff.find((s) => s.staffProfileId === form.staffProfileId);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: '' }));
  }

  function validate(): { startIso: string; endIso: string } | null {
    const next: Record<string, string> = {};
    if (!form.staffProfileId) next.staffProfileId = 'Pick a stylist';
    if (!form.date) next.date = 'Pick a date';
    if (!form.startTime) next.startTime = 'Start time required';
    if (!form.endTime) next.endTime = 'End time required';

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return null;
    }

    const startIso = combineDateAndTime(form.date, form.startTime);
    const endIso = combineDateAndTime(form.date, form.endTime);

    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      next.endTime = 'End must be after start';
      setErrors(next);
      return null;
    }

    return { startIso, endIso };
  }

  async function persistShift(reason?: string) {
    const valid = validate();
    if (!valid) return;
    if (draftMode) {
      const draftShift: RotaShift = {
        id: shift?.id ?? `draft:${crypto.randomUUID()}`,
        businessId: shift?.businessId ?? '',
        locationId,
        staffProfileId: form.staffProfileId,
        status: 'published',
        scheduledStartAt: valid.startIso,
        scheduledEndAt: valid.endIso,
        notes: form.notes.trim() || undefined,
        breaks,
      };
      onSaved(draftShift);
      onClose();
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      if (isEditing && shift) {
        const result = await updateRotaShift(accessToken, shift.id, {
          scheduledStartAt: valid.startIso,
          scheduledEndAt: valid.endIso,
          notes: form.notes.trim() || null,
          ...(reason ? { pastEditReason: reason } : {}),
        });
        onSaved({ ...result.shift, breaks });
      } else {
        const result = await createRotaShift(accessToken, {
          locationId,
          staffProfileId: form.staffProfileId,
          scheduledStartAt: valid.startIso,
          scheduledEndAt: valid.endIso,
          notes: form.notes.trim() || undefined,
          ...(reason ? { pastEditReason: reason } : {}),
        });
        onSaved(result.shift);
      }
      onClose();
    } catch (error) {
      const message =
        error instanceof ApiRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Could not save shift';
      // Server flagged a past edit without a reason — open the prompt.
      if (/Reason is required/i.test(message)) {
        setPastEditTitle(isEditing ? 'Edit past shift' : 'Create past shift');
        setPendingPastEdit({
          run: async (r: string) => {
            await persistShift(r);
          },
        });
      } else {
        setSubmitError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    const valid = validate();
    if (!valid) return;
    if (isPastDate(valid.startIso)) {
      setPastEditTitle(isEditing ? 'Edit past shift' : 'Create past shift');
      setPendingPastEdit({ run: (reason: string) => persistShift(reason) });
      return;
    }
    void persistShift();
  }

  async function handleDelete(reason?: string) {
    if (!shift) return;
    if (draftMode) {
      onDeleted(shift.id);
      onClose();
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      await deleteRotaShift(accessToken, shift.id, reason);
      onDeleted(shift.id);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete shift';
      if (/Reason is required/i.test(message)) {
        setPastEditTitle('Delete past shift');
        setPendingPastEdit({ run: (r: string) => handleDelete(r) });
      } else {
        setSubmitError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  function startDelete() {
    if (!shift) return;
    if (isPastDate(shift.scheduledStartAt)) {
      setPastEditTitle('Delete past shift');
      setPendingPastEdit({ run: (reason: string) => handleDelete(reason) });
    } else {
      void handleDelete();
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={isEditing ? 'Edit shift' : 'New shift'}
        description={
          isEditing
            ? 'Adjust hours, add breaks, or update notes.'
            : 'Schedule a new shift for a stylist at this location.'
        }
        footer={
          <>
            {isEditing ? (
              <AppButton
                variant="danger"
                onClick={startDelete}
                disabled={busy}
                className="mr-auto"
              >
                Delete shift
              </AppButton>
            ) : null}
            <AppButton variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </AppButton>
            <AppButton variant="primary" onClick={handleSubmit} loading={busy}>
              {isEditing ? 'Save changes' : 'Create shift'}
            </AppButton>
          </>
        }
      >
        <div className="space-y-4">
          {submitError ? (
            <div className="rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[12px] text-danger">
              {submitError}
            </div>
          ) : null}

          <SelectField
            label="Stylist"
            name="staffProfileId"
            value={form.staffProfileId}
            placeholder="Select a stylist"
            options={staffOptions}
            error={errors.staffProfileId}
            disabled={isEditing}
            onValueChange={(value) => update('staffProfileId', value)}
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="Date"
              type="date"
              name="date"
              value={form.date}
              error={errors.date}
              onValueChange={(value) => update('date', value)}
            />
            <TextField
              label="Start"
              type="time"
              name="startTime"
              value={form.startTime}
              error={errors.startTime}
              onValueChange={(value) => update('startTime', value)}
            />
            <TextField
              label="End"
              type="time"
              name="endTime"
              value={form.endTime}
              error={errors.endTime}
              onValueChange={(value) => update('endTime', value)}
            />
          </div>

          {/* V2: if draft/published workflow returns, prefer modelling it at rota-week
              creation/publish level rather than as a per-shift V1 modal control. */}

          <TextField
            label="Notes"
            name="notes"
            optional
            value={form.notes}
            onValueChange={(value) => update('notes', value)}
            placeholder="Optional shift notes"
          />

          {isEditing && shift ? (
            <BreakEditor
              accessToken={accessToken}
              shift={shift}
              breaks={breaks}
              onChange={(next) => {
                setBreaks(next);
                onSaved({ ...shift, breaks: next });
              }}
              defaultBreakMinutes={selectedStaff?.defaultBreakMinutes ?? 30}
              defaultBreakIsPaid={selectedStaff?.defaultBreakIsPaid ?? false}
              onError={setSubmitError}
              draftMode={draftMode}
            />
          ) : (
            <div className="rounded-input-lg border border-border-strong bg-surface-alt px-3 py-2.5 text-[12px] text-text-secondary">
              Save the shift first, then you can add breaks. Default break is{' '}
              <strong>{selectedStaff?.defaultBreakMinutes ?? 30} min</strong>{' '}
              {selectedStaff?.defaultBreakIsPaid ? 'paid' : 'unpaid'}.
            </div>
          )}
        </div>
      </Modal>

      <PastEditReasonDialog
        open={pendingPastEdit !== null}
        title={pastEditTitle}
        busy={busy}
        onCancel={() => setPendingPastEdit(null)}
        onConfirm={(reason) => {
          const action = pendingPastEdit;
          setPendingPastEdit(null);
          if (action) void action.run(reason);
        }}
      />
    </>
  );
}

function buildInitialForm(
  shift: RotaShift | undefined,
  initialDate: string | undefined,
  initialStaffProfileId: string | undefined,
  staff: RotaStaffSummary[],
): FormState {
  if (shift) {
    const start = new Date(shift.scheduledStartAt);
    return {
      staffProfileId: shift.staffProfileId,
      date: dateInputValue(start),
      startTime: timeInputValue(shift.scheduledStartAt),
      endTime: timeInputValue(shift.scheduledEndAt),
      notes: shift.notes ?? '',
    };
  }
  return {
    staffProfileId: initialStaffProfileId ?? staff[0]?.staffProfileId ?? '',
    date: initialDate ?? dateInputValue(new Date()),
    startTime: '09:00',
    endTime: '17:00',
    notes: '',
  };
}

interface BreakEditorProps {
  accessToken: string;
  shift: RotaShift;
  breaks: RotaBreak[];
  onChange: (breaks: RotaBreak[]) => void;
  defaultBreakMinutes: number;
  defaultBreakIsPaid: boolean;
  onError: (message: string) => void;
  draftMode?: boolean;
}

function BreakEditor({
  accessToken,
  shift,
  breaks,
  onChange,
  defaultBreakMinutes,
  defaultBreakIsPaid,
  onError,
  draftMode = false,
}: BreakEditorProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingPastEdit, setPendingPastEdit] =
    useState<null | { run: (reason: string) => Promise<void> }>(null);
  const [draftStart, setDraftStart] = useState(() => timeInputValue(shift.scheduledStartAt));
  const [draftEnd, setDraftEnd] = useState(() => suggestBreakEnd(shift, defaultBreakMinutes));
  const [draftPaid, setDraftPaid] = useState(defaultBreakIsPaid);
  const [draftNotes, setDraftNotes] = useState('');

  useEffect(() => {
    setDraftStart(timeInputValue(shift.scheduledStartAt));
    setDraftEnd(suggestBreakEnd(shift, defaultBreakMinutes));
    setDraftPaid(defaultBreakIsPaid);
    setDraftNotes('');
  }, [shift, defaultBreakMinutes, defaultBreakIsPaid]);

  const shiftDateIso = dateInputValue(new Date(shift.scheduledStartAt));

  async function handleAdd(reason?: string) {
    const startedAt = combineDateAndTime(shiftDateIso, draftStart);
    const endedAt = combineDateAndTime(shiftDateIso, draftEnd);
    if (new Date(endedAt).getTime() <= new Date(startedAt).getTime()) {
      onError('Break end must be after start');
      return;
    }
    if (draftMode) {
      onChange([
        ...breaks,
        {
          id: `draft-break:${crypto.randomUUID()}`,
          shiftId: shift.id,
          startedAt,
          endedAt,
          isPaid: draftPaid,
          notes: draftNotes.trim() || undefined,
        },
      ]);
      setDraftNotes('');
      return;
    }
    setBusy('add');
    try {
      const result = await addRotaBreak(accessToken, shift.id, {
        startedAt,
        endedAt,
        isPaid: draftPaid,
        notes: draftNotes.trim() || undefined,
        ...(reason ? { pastEditReason: reason } : {}),
      });
      onChange(result.shift.breaks);
      setDraftNotes('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not add break';
      if (/Reason is required/i.test(message)) {
        setPendingPastEdit({ run: (r: string) => handleAdd(r) });
      } else {
        onError(message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleTogglePaid(b: RotaBreak, reason?: string) {
    if (draftMode) {
      onChange(breaks.map((item) => (item.id === b.id ? { ...item, isPaid: !item.isPaid } : item)));
      return;
    }
    setBusy(b.id);
    try {
      const result = await updateRotaBreak(accessToken, shift.id, b.id, {
        isPaid: !b.isPaid,
        ...(reason ? { pastEditReason: reason } : {}),
      });
      onChange(result.shift.breaks);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update break';
      if (/Reason is required/i.test(message)) {
        setPendingPastEdit({ run: (r: string) => handleTogglePaid(b, r) });
      } else {
        onError(message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(b: RotaBreak, reason?: string) {
    if (draftMode) {
      onChange(breaks.filter((x) => x.id !== b.id));
      return;
    }
    setBusy(b.id);
    try {
      await deleteRotaBreak(accessToken, shift.id, b.id, reason);
      onChange(breaks.filter((x) => x.id !== b.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete break';
      if (/Reason is required/i.test(message)) {
        setPendingPastEdit({ run: (r: string) => handleDelete(b, r) });
      } else {
        onError(message);
      }
    } finally {
      setBusy(null);
    }
  }

  function startAdd() {
    if (isPastDate(shift.scheduledStartAt)) {
      setPendingPastEdit({ run: (reason: string) => handleAdd(reason) });
      return;
    }
    void handleAdd();
  }

  return (
    <div className="rounded-card-lg border border-border bg-surface-alt">
      <header className="border-b border-border px-4 py-2.5">
        <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
          Breaks
        </div>
      </header>

      <ul className="divide-y divide-border">
        {breaks.length === 0 ? (
          <li className="px-4 py-3 text-[12px] text-text-secondary">
            No breaks yet. Default is {defaultBreakMinutes} min{' '}
            {defaultBreakIsPaid ? 'paid' : 'unpaid'}.
          </li>
        ) : null}
        {breaks.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div>
              <div className="text-[13px] font-medium text-text-primary">
                {formatTime(b.startedAt)} – {formatTime(b.endedAt)}
              </div>
              <div className="text-[11px] text-text-secondary">
                {b.isPaid ? 'Paid' : 'Unpaid'}
                {b.notes ? ` · ${b.notes}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <AppButton
                variant="ghost"
                size="sm"
                disabled={busy === b.id}
                onClick={() => {
                  if (isPastDate(b.startedAt)) {
                    setPendingPastEdit({ run: (r: string) => handleTogglePaid(b, r) });
                  } else {
                    void handleTogglePaid(b);
                  }
                }}
              >
                {b.isPaid ? 'Mark unpaid' : 'Mark paid'}
              </AppButton>
              <AppButton
                variant="danger"
                size="sm"
                disabled={busy === b.id}
                onClick={() => {
                  if (isPastDate(b.startedAt)) {
                    setPendingPastEdit({ run: (r: string) => handleDelete(b, r) });
                  } else {
                    void handleDelete(b);
                  }
                }}
              >
                Remove
              </AppButton>
            </div>
          </li>
        ))}
      </ul>

      <div className="grid gap-2 border-t border-border px-4 py-3 sm:grid-cols-[auto_auto_auto_1fr_auto] sm:items-end">
        <TextField
          label="Start"
          type="time"
          name="break-start"
          value={draftStart}
          onValueChange={setDraftStart}
        />
        <TextField
          label="End"
          type="time"
          name="break-end"
          value={draftEnd}
          onValueChange={setDraftEnd}
        />
        <label className="flex select-none items-center gap-2 pb-3 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            checked={draftPaid}
            onChange={(event) => setDraftPaid(event.target.checked)}
          />
          Paid break
        </label>
        <TextField
          label="Notes"
          optional
          name="break-notes"
          value={draftNotes}
          onValueChange={setDraftNotes}
          placeholder="Optional"
        />
        <AppButton
          variant="secondary"
          size="md"
          onClick={startAdd}
          loading={busy === 'add'}
          className="self-end"
        >
          Add break
        </AppButton>
      </div>

      <PastEditReasonDialog
        open={pendingPastEdit !== null}
        title="Past break edit"
        description="Editing a break on a past shift is captured in the rota audit log."
        busy={busy !== null}
        onCancel={() => setPendingPastEdit(null)}
        onConfirm={(reason) => {
          const action = pendingPastEdit;
          setPendingPastEdit(null);
          if (action) void action.run(reason);
        }}
      />
    </div>
  );
}

function suggestBreakEnd(shift: RotaShift, defaultMinutes: number): string {
  const start = new Date(shift.scheduledStartAt);
  const end = new Date(start.getTime() + defaultMinutes * 60_000);
  return timeInputValue(end.toISOString());
}
