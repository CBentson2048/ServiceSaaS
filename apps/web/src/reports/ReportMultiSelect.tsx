import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@sheer/utils';

export interface ReportMultiSelectOption {
  id: string;
  label: string;
  /** Options are shown under their group heading, in the order given. */
  group: string;
  disabled?: boolean;
  /** Shown beside the label, e.g. why an option is disabled. */
  note?: string;
}

export interface ReportMultiSelectProps {
  label: string;
  /** Wording for the "everything permitted" choice, which is the empty selection. */
  allLabel: string;
  /** Plural noun for the closed button when several are selected, e.g. 'locations'. */
  pluralNoun: string;
  options: readonly ReportMultiSelectOption[];
  /** `[]` means "all". Ids with no matching option are kept, never dropped. */
  value: readonly string[];
  disabled?: boolean;
  /** Called once, when the list closes, and only if the selection changed. */
  onCommit(next: string[]): void;
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Accessible multi-select for report scopes. The selection is edited as a draft
 * and committed once when the list closes (Done, Escape or a click outside), so
 * choosing three locations makes one request and one history entry, not three.
 * "All" is the empty selection; ticking every option one by one stays an
 * explicit list, because "all I may see" and "these exact ids" are different
 * requests.
 */
export function ReportMultiSelect(props: ReportMultiSelectProps) {
  const { label, allLabel, pluralNoun, options, value, disabled, onCommit } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([...value]);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Follow the committed value (Back/Forward, a reset): an untouched open list
  // must never commit the selection it opened with over a newer one.
  const valueKey = [...value].sort().join(',');
  useEffect(() => {
    setDraft([...value]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const close = (returnFocus = false) => {
    setOpen(false);
    if (!sameSelection(draft, value)) onCommit([...draft].sort());
    if (returnFocus) toggleRef.current?.focus();
  };

  // Re-subscribed every render so the handlers always see the current draft.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  const openList = () => {
    if (disabled) return;
    setDraft([...value]);
    setOpen(true);
  };

  const toggle = (option: ReportMultiSelectOption) => {
    if (option.disabled) return;
    setDraft((current) =>
      current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id],
    );
  };

  const onOptionKey = (event: KeyboardEvent, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };

  const summary =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? (options.find((option) => option.id === value[0])?.label ?? `1 ${pluralNoun.replace(/s$/, '')}`)
        : `${value.length} ${pluralNoun}`;

  const groups = [...new Set(options.map((option) => option.group))];

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        // Keyboard focus moving to something outside closes and commits. A null
        // target (a click on non-focusable popup chrome) is left to mousedown.
        const next = event.relatedTarget as Node | null;
        if (open && next && !event.currentTarget.contains(next)) close();
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${summary}`}
        onClick={() => (open ? close() : openList())}
        className="inline-flex min-w-[10rem] items-center justify-between gap-2 rounded-input-lg border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-text-primary transition hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">{summary}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true" className={cn('h-4 w-4 shrink-0 transition-transform', open ? 'rotate-180' : '')}>
          <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="absolute left-0 z-20 mt-1 w-72 rounded-card border border-border bg-surface p-2 shadow-hero">
          <ul id={listId} role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-72 overflow-y-auto">
            <li
              role="option"
              tabIndex={0}
              aria-selected={draft.length === 0}
              onClick={() => setDraft([])}
              onKeyDown={(event) => onOptionKey(event, () => setDraft([]))}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-input-lg px-2 py-1.5 text-[13px] hover:bg-surface-alt focus:bg-surface-alt focus:outline-none',
                draft.length === 0 ? 'font-medium text-text-primary' : 'text-text-secondary',
              )}
            >
              <CheckMark checked={draft.length === 0} />
              {allLabel}
            </li>
            {groups.map((group) => (
              <li key={group} role="presentation">
                <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted">{group}</div>
                <ul role="group" aria-label={group}>
                  {options
                    .filter((option) => option.group === group)
                    .map((option) => {
                      const selected = draft.includes(option.id);
                      return (
                        <li
                          key={option.id}
                          role="option"
                          tabIndex={option.disabled ? -1 : 0}
                          aria-selected={selected}
                          aria-disabled={option.disabled || undefined}
                          onClick={() => toggle(option)}
                          onKeyDown={(event) => onOptionKey(event, () => toggle(option))}
                          className={cn(
                            'flex items-center gap-2 rounded-input-lg px-2 py-1.5 text-[13px]',
                            option.disabled
                              ? 'cursor-not-allowed text-text-muted'
                              : 'cursor-pointer text-text-primary hover:bg-surface-alt focus:bg-surface-alt focus:outline-none',
                          )}
                        >
                          <CheckMark checked={selected} />
                          <span className="truncate">{option.label}</span>
                          {option.note ? <span className="ml-auto shrink-0 text-[11px] text-warning">{option.note}</span> : null}
                        </li>
                      );
                    })}
                </ul>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-end border-t border-border pt-2">
            <button
              type="button"
              onClick={() => close(true)}
              className="rounded-pill bg-surface-ink px-3 py-1 text-[12px] font-medium text-text-on-primary"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
        checked ? 'border-surface-ink bg-surface-ink text-text-on-primary' : 'border-border-strong bg-surface',
      )}
    >
      {checked ? (
        <svg viewBox="0 0 16 16" className="h-3 w-3">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}
