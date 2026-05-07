import { useEffect, useState } from 'react';
import type { AbsenceType, RotaAbsenceIndicator, RotaStaffSummary } from '@sheer/domain';
import { AppButton } from '../../design';
import { ApiRequestError, markRotaAbsence } from '../../auth/api';
import { SelectField, TextField } from '../onboarding/FormField';
import { Modal } from '../team/Modal';
import { combineDateAndTime, dateInputValue, timeInputValue } from './dateUtils';

const ABSENCE_OPTIONS: { value: AbsenceType; label: string }[] = [
  { value: 'sickness', label: 'Sickness' },
  { value: 'emergency', label: 'Emergency' },
  { value: 'bereavement', label: 'Bereavement' },
  { value: 'unauthorised', label: 'Unauthorised absence' },
  { value: 'other', label: 'Other' },
];

interface MarkAbsenceModalProps {
  open: boolean;
  onClose: () => void;
  onMarked: (absence: RotaAbsenceIndicator) => void;
  accessToken: string;
  locationId: string;
  staff: RotaStaffSummary[];
  initialStaffProfileId?: string;
}

export function MarkAbsenceModal({
  open,
  onClose,
  onMarked,
  accessToken,
  locationId,
  staff,
  initialStaffProfileId,
}: MarkAbsenceModalProps) {
  const [staffProfileId, setStaffProfileId] = useState(initialStaffProfileId ?? staff[0]?.staffProfileId ?? '');
  const [absenceType, setAbsenceType] = useState<AbsenceType>('sickness');
  const [date, setDate] = useState(() => dateInputValue(new Date()));
  const [startTime, setStartTime] = useState(() => timeInputValue(new Date().toISOString()));
  const [endTime, setEndTime] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStaffProfileId(initialStaffProfileId ?? staff[0]?.staffProfileId ?? '');
    setAbsenceType('sickness');
    setDate(dateInputValue(new Date()));
    setStartTime(timeInputValue(new Date().toISOString()));
    setEndTime('');
    setNotes('');
    setError(null);
  }, [open, staff, initialStaffProfileId]);

  async function handleSubmit() {
    if (!staffProfileId) {
      setError('Pick a stylist');
      return;
    }
    if (!date || !startTime) {
      setError('Set a start date and time');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const startsAt = combineDateAndTime(date, startTime);
      const endsAt = endTime ? combineDateAndTime(date, endTime) : undefined;
      const result = await markRotaAbsence(accessToken, {
        staffProfileId,
        locationId,
        absenceType,
        startsAt,
        endsAt,
        notes: notes.trim() || undefined,
      });
      onMarked(result.absence);
      onClose();
    } catch (err) {
      const message =
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not mark absence';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark absence"
      description="Record an unplanned absence for a stylist at this location. Captured in the rota audit log."
      footer={
        <>
          <AppButton variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </AppButton>
          <AppButton variant="primary" onClick={handleSubmit} loading={busy}>
            Mark absence
          </AppButton>
        </>
      }
    >
      <div className="space-y-4">
        {error ? (
          <div className="rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        ) : null}

        <SelectField
          label="Stylist"
          name="staffProfileId"
          value={staffProfileId}
          options={staff.map((s) => ({ value: s.staffProfileId, label: s.displayName }))}
          placeholder="Select a stylist"
          onValueChange={setStaffProfileId}
        />

        <SelectField
          label="Absence type"
          name="absenceType"
          value={absenceType}
          options={ABSENCE_OPTIONS}
          onValueChange={(value) => setAbsenceType(value as AbsenceType)}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Date"
            type="date"
            name="date"
            value={date}
            onValueChange={setDate}
          />
          <TextField
            label="Starts"
            type="time"
            name="startTime"
            value={startTime}
            onValueChange={setStartTime}
          />
          <TextField
            label="Ends"
            type="time"
            name="endTime"
            optional
            value={endTime}
            onValueChange={setEndTime}
          />
        </div>

        <TextField
          label="Notes"
          name="notes"
          optional
          value={notes}
          onValueChange={setNotes}
          placeholder="Optional context"
        />
      </div>
    </Modal>
  );
}
