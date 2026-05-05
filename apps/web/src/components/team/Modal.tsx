import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, description, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-ink-deep/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-card-lg border border-border bg-surface shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border bg-surface-alt px-6 py-4">
          <h2 className="text-[18px] font-medium text-text-primary">{title}</h2>
          {description ? (
            <p className="mt-1 text-[13px] text-text-secondary">{description}</p>
          ) : null}
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-3 border-t border-border bg-surface-alt px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
