import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@sheer/utils';

export interface ReportMultiSelectOption {
  id: string;
  label: string;
  /** Options are shown under their group heading, in the order given. */
  group: string;
  /** Cannot be added. An option that is already selected can still be removed. */
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
  /** The most ids an explicit selection may hold; further ticks are refused. */
  maxSelected?: number;
  disabled?: boolean;
  /** Called once, when the list closes, and only if the selection changed. */
  onCommit(next: string[]): void;
}

/** Roving-focus id of the "All" row. Never a real option id (those are uuids). */
const ALL_ROW = '__all__';

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Accessible multi-select for report scopes (WAI-ARIA multi-select listbox).
 * The selection is edited as a draft and committed once when the list closes
 * (Done, Escape, Tab away or a click outside), so choosing three locations
 * makes one request and one history entry, not three. "All" is the empty
 * selection; ticking every option one by one stays an explicit list, because
 * "all I may see" and "these exact ids" are different requests.
 *
 * Keyboard: opening moves focus to the first selected row (or "All"); Arrow
 * Up/Down, Home and End move between rows with a single tab stop; Space or
 * Enter toggles; Escape closes and returns focus to the button.
 */
export function ReportMultiSelect(props: ReportMultiSelectProps) {
  const { label, allLabel, pluralNoun, options, value, maxSelected, disabled, onCommit } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([...value]);
  const [activeId, setActiveId] = useState<string>(ALL_ROW);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const focusOnOpen = useRef(false);
  const listId = useId();
  const noteId = useId();

  // Follow the committed value (Back/Forward, a reset): an untouched open list
  // must never commit the selection it opened with over a newer one.
  const valueKey = [...value].sort().join(',');
  useEffect(() => {
    setDraft([...value]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const groups = [...new Set(options.map((option) => option.group))];
  const ordered = groups.flatMap((group) => options.filter((option) => option.group === group));
  const atMax = maxSelected !== undefined && draft.length >= maxSelected;
  /** Reachable by keyboard: anything that can be added, or removed. */
  const reachable = (option: ReportMultiSelectOption) => !option.disabled || draft.includes(option.id);
  const canToggle = (option: ReportMultiSelectOption) =>
    draft.includes(option.id) || (!option.disabled && !atMax);
  /** Every rendered row, in order. Keyboard moves skip rows that cannot be changed. */
  const rowIds = [ALL_ROW, ...ordered.map((option) => option.id)];
  const rowReachable = (id: string) => {
    if (id === ALL_ROW) return true;
    const option = ordered.find((candidate) => candidate.id === id);
    return option !== undefined && reachable(option);
  };
  // The active row is always the single tab stop — even one that just became
  // locked (a broken location unticked) — and is "All" if its row is gone.
  const focusId = rowIds.includes(activeId) ? activeId : ALL_ROW;

  const close = (returnFocus = false) => {
    setOpen(false);
    if (!sameSelection(draft, value)) onCommit([...draft].sort());
    if (returnFocus) toggleRef.current?.focus();
  };

  // A list left open when the control becomes disabled closes without committing.
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

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

  useEffect(() => {
    if (open && focusOnOpen.current) {
      focusOnOpen.current = false;
      rowRefs.current.get(activeId)?.focus();
    }
  }, [open, activeId]);

  // The focused row left the list (its location went away while open): keep
  // keyboard focus in the list instead of dropping it to the page.
  useEffect(() => {
    if (open && focusId !== activeId) {
      const lostFocus = !containerRef.current?.contains(document.activeElement);
      setActiveId(ALL_ROW);
      if (lostFocus) rowRefs.current.get(ALL_ROW)?.focus();
    }
  }, [open, focusId, activeId]);

  const openList = () => {
    if (disabled) return;
    setDraft([...value]);
    const firstSelected = ordered.find((option) => value.includes(option.id));
    setActiveId(firstSelected ? firstSelected.id : ALL_ROW);
    focusOnOpen.current = true;
    setOpen(true);
  };

  const toggle = (option: ReportMultiSelectOption) => {
    setDraft((current) => {
      if (current.includes(option.id)) return current.filter((id) => id !== option.id);
      if (option.disabled || (maxSelected !== undefined && current.length >= maxSelected)) return current;
      return [...current, option.id];
    });
  };

  const moveTo = (id: string | undefined) => {
    if (!id) return;
    setActiveId(id);
    rowRefs.current.get(id)?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = rowIds.indexOf(focusId);
    const after = rowIds.slice(index + 1).filter(rowReachable);
    const before = rowIds.slice(0, index).filter(rowReachable);
    const reachableIds = rowIds.filter(rowReachable);
    const next: Record<string, string | undefined> = {
      ArrowDown: after[0],
      ArrowUp: before[before.length - 1],
      Home: reachableIds[0],
      End: reachableIds[reachableIds.length - 1],
    };
    if (event.key in next) {
      event.preventDefault();
      moveTo(next[event.key]);
    }
  };

  const onRowKey = (event: KeyboardEvent, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };

  const rowRef = (id: string) => (element: HTMLLIElement | null) => {
    if (element) rowRefs.current.set(id, element);
    else rowRefs.current.delete(id);
  };

  const summary =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? (options.find((option) => option.id === value[0])?.label ?? `1 ${pluralNoun.replace(/s$/, '')}`)
        : `${value.length} ${pluralNoun}`;

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
          <ul
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={label}
            aria-describedby={atMax ? noteId : undefined}
            onKeyDown={onListKeyDown}
            className="max-h-72 overflow-y-auto"
          >
            <li
              ref={rowRef(ALL_ROW)}
              role="option"
              tabIndex={focusId === ALL_ROW ? 0 : -1}
              aria-selected={draft.length === 0}
              onClick={() => {
                setActiveId(ALL_ROW);
                setDraft([]);
              }}
              onFocus={() => setActiveId(ALL_ROW)}
              onKeyDown={(event) => onRowKey(event, () => setDraft([]))}
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
                      const locked = !canToggle(option);
                      return (
                        <li
                          key={option.id}
                          ref={rowRef(option.id)}
                          role="option"
                          tabIndex={focusId === option.id ? 0 : -1}
                          aria-selected={selected}
                          aria-disabled={locked || undefined}
                          onClick={() => {
                            if (reachable(option)) setActiveId(option.id);
                            toggle(option);
                          }}
                          onFocus={() => setActiveId(option.id)}
                          onKeyDown={(event) => onRowKey(event, () => toggle(option))}
                          className={cn(
                            'flex items-center gap-2 rounded-input-lg px-2 py-1.5 text-[13px]',
                            locked
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
          {atMax ? (
            <p id={noteId} role="status" className="mt-2 px-2 text-[11px] text-text-secondary">
              Up to {maxSelected} {pluralNoun} — or choose {allLabel}.
            </p>
          ) : null}
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
