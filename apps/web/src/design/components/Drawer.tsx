import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@sheer/utils';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Tailwind max-width for the desktop panel. */
  widthClassName?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Right-side drawer: the house pattern for editing a record without losing your
 * place in the list behind it. Full-height panel on desktop/tablet, full-screen
 * sheet below `sm`. Mirrors the existing Modal's visual language (same overlay,
 * header, footer bar) so the two feel like one system.
 *
 * Accessibility: labelled dialog, focus moves in on open and returns to the
 * trigger on close, Tab is trapped inside, Escape closes.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  widthClassName = 'sm:max-w-xl',
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Held in a ref so the focus effect below depends ONLY on `open`. Callers
  // pass an inline arrow, which changes identity on every parent render — as a
  // dependency it would re-run the effect and snatch focus back to the first
  // field every time a background query resolved.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    // Land on the first control of the drawer's CONTENT, not the header's
    // close button — a keyboard user should arrive ready to edit, not one
    // Enter away from dismissing the drawer. Read-only drawers get the panel.
    const first = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      // `hidden` is the only visibility test that is meaningful without
      // layout; the selector already excludes disabled controls.
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
    // The page behind must not scroll while a sheet covers it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-surface-ink-deep/60"
      onClick={onClose}
      data-testid="drawer-overlay"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'flex h-full w-full flex-col border-border bg-surface shadow-modal outline-none',
          'sm:border-l',
          widthClassName,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border bg-surface-alt px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[17px] font-medium text-text-primary">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-[13px] text-text-secondary">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 shrink-0 rounded-input p-1.5 text-text-secondary transition hover:bg-surface hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {children}
        </div>

        {footer ? (
          <footer className="flex items-center justify-end gap-3 border-t border-border bg-surface-alt px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
