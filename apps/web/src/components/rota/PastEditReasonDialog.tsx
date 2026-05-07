import { useEffect, useState } from 'react';
import { AppButton } from '../../design';
import { Modal } from '../team/Modal';

interface PastEditReasonDialogProps {
  open: boolean;
  /** Verb describing the action (e.g. "Delete this past shift"). */
  title: string;
  description?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * Shared "why are you editing the past?" prompt. Used by the shift
 * editor, break editor, and inline delete affordances. The reason is
 * forwarded to the API which writes it into the audit trail.
 */
export function PastEditReasonDialog({
  open,
  title,
  description,
  busy,
  onCancel,
  onConfirm,
}: PastEditReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  function handleConfirm() {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setError('Please enter at least a short reason (3+ characters).');
      return;
    }
    onConfirm(trimmed);
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={
        description ??
        'Edits to past rota records are captured in an audit log along with your name and timestamp.'
      }
      footer={
        <>
          <AppButton variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </AppButton>
          <AppButton variant="primary" onClick={handleConfirm} loading={busy}>
            Save with reason
          </AppButton>
        </>
      }
    >
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
          Reason
        </span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={4}
          className="w-full rounded-input-lg border border-border-strong bg-surface px-3.5 py-2.5 text-[14px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          placeholder="e.g. Stylist ran 30 min late, recorded retroactively"
          autoFocus
        />
        {error ? (
          <span className="mt-1.5 block text-[12px] text-danger">{error}</span>
        ) : null}
      </label>
    </Modal>
  );
}
