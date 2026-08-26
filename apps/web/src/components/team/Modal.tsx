import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Tailwind max-width class for the dialog. Defaults to a compact form width. */
  widthClassName?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  widthClassName = 'max-w-lg',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Held in a ref so the effect depends only on `open`: callers pass inline
  // arrows, and re-running this would steal focus on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const first = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => !element.hasAttribute('hidden') && element.closest('[hidden]') === null,
      );
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

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
        ref={panelRef}
        tabIndex={-1}
        className={`w-full ${widthClassName} overflow-hidden rounded-card-lg border border-border bg-surface shadow-modal outline-none`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border bg-surface-alt px-6 py-4">
          <h2 className="text-[18px] font-medium text-text-primary">{title}</h2>
          {description ? (
            <p className="mt-1 text-[13px] text-text-secondary">{description}</p>
          ) : null}
        </div>
        <div ref={bodyRef} className="max-h-[70vh] overflow-y-auto px-6 py-5">
          {children}
        </div>
        {footer ? (
          <div className="flex items-center justify-end gap-3 border-t border-border bg-surface-alt px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
