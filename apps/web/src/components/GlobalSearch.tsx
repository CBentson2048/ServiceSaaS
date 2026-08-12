import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CrmClientSearchResult } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { searchCrmClients } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useDebounce } from '../hooks/useDebounce';
import { ALL_LOCATIONS, useLocationScope } from './LocationScopeContext';

const MIN_TERM_LENGTH = 2;
const PALETTE_PAGE_SIZE = 8;
const OPEN_EVENT = 'qlooqo:open-client-search';

/**
 * Opens the client-search palette from anywhere in the app (the quick-action
 * toolbar's Client Search button). A DOM event keeps the callers decoupled
 * from the palette's internal state.
 */
export function openGlobalClientSearch(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/**
 * Global client search (Week 5): a top-bar trigger plus a Ctrl/⌘-K palette that
 * searches clients by name, phone, email or Q code from any dashboard screen.
 * Results are fetched as the user types (debounced, rank-ordered, fuzzy
 * server-side). Selecting a row opens the client profile; "View all" hands the
 * term to the Client Hub, whose URL carries the full table state for sharing.
 */
export function GlobalSearch() {
  const { user, session } = useAuth();
  const accessToken = session?.accessToken;
  const { locations, selectedLocationId } = useLocationScope();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CrmClientSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic id so only the most recently issued search applies its result.
  const reloadIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedTerm = useDebounce(term, 250);
  const trimmedTerm = debouncedTerm.trim();
  // The palette follows the sidebar location picker: a concrete selection
  // narrows the search, "All" searches every location the user may read.
  const scopedLocationId = selectedLocationId !== ALL_LOCATIONS ? selectedLocationId : undefined;
  const scopedLocationName = scopedLocationId
    ? locations.find((location) => location.id === scopedLocationId)?.name
    : undefined;

  const canSearch = Boolean(user && userHasPermission(user, 'crm.view'));

  // Ctrl/⌘-K opens (or closes) the palette from anywhere in the dashboard;
  // the quick-action toolbar opens it via the custom event.
  useEffect(() => {
    if (!canSearch) return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpenEvent);
    };
  }, [canSearch]);

  useEffect(() => {
    if (!open || !accessToken) return;
    if (trimmedTerm.length < MIN_TERM_LENGTH) {
      // Also advance the request id so an in-flight response for a longer
      // earlier term can't land late and resurrect results under the hint.
      reloadIdRef.current += 1;
      setResults([]);
      setTotal(0);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++reloadIdRef.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await searchCrmClients(accessToken, {
          q: trimmedTerm,
          locationId: scopedLocationId,
          pageSize: PALETTE_PAGE_SIZE,
        });
        if (requestId !== reloadIdRef.current) return;
        setResults(response.results);
        setTotal(response.pagination.total);
        setActiveIndex(0);
      } catch (err: unknown) {
        if (requestId !== reloadIdRef.current) return;
        setResults([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        if (requestId === reloadIdRef.current) setLoading(false);
      }
    })();
  }, [open, accessToken, trimmedTerm, scopedLocationId]);

  if (!canSearch) return null;

  function close() {
    setOpen(false);
  }

  function openClient(id: string) {
    close();
    navigate(`/crm/clients/${id}`);
  }

  // Hands the term to the Client Hub table, whose q/page/location state lives
  // in the URL — the resulting link is shareable and lands on the same
  // results. The palette's location scope travels along so "all N results"
  // means the same N on the destination page.
  function viewAllResults() {
    close();
    const params = new URLSearchParams({ q: trimmedTerm });
    if (scopedLocationId) params.set('location', scopedLocationId);
    navigate(`/crm?${params.toString()}`);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // Guard on term length so Enter can never act on results that belong to
      // an earlier, longer term after the user backspaced below the minimum.
      if (trimmedTerm.length < MIN_TERM_LENGTH) return;
      const active = results[activeIndex] ?? results[0];
      if (active) openClient(active.id);
      else if (total > 0) viewAllResults();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search clients (Ctrl+K)"
        className="flex h-8 items-center gap-2 rounded-pill border border-white/10 px-3 text-[13px] text-white/70 transition-colors hover:bg-white/[0.07]"
      >
        <SearchIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:block">Search clients</span>
        <kbd className="hidden rounded border border-white/15 px-1.5 py-0.5 text-[10px] font-medium text-white/40 md:block">
          Ctrl K
        </kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
          role="dialog"
          aria-modal="true"
          aria-label="Search clients"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div className="w-full max-w-xl overflow-hidden rounded-card-lg border border-border bg-surface shadow-modal">
            <div className="flex items-center gap-3 border-b border-border px-4">
              <SearchIcon className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                ref={inputRef}
                autoFocus
                type="text"
                value={term}
                placeholder="Search clients by name, phone, email, or Q code…"
                onChange={(event) => setTerm(event.target.value)}
                onKeyDown={onInputKeyDown}
                aria-label="Search clients"
                className="h-12 w-full bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-muted"
              />
              {scopedLocationName ? (
                <span className="hidden shrink-0 rounded-pill border border-border bg-surface-alt px-2.5 py-1 text-[11px] font-medium text-text-secondary sm:block">
                  {scopedLocationName}
                </span>
              ) : null}
              <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                Esc
              </kbd>
            </div>

            <div className="max-h-[50vh] overflow-y-auto">
              {trimmedTerm.length < MIN_TERM_LENGTH ? (
                <PaletteHint text={`Type at least ${MIN_TERM_LENGTH} characters to search.`} />
              ) : error ? (
                <PaletteHint text={error} tone="danger" />
              ) : results.length === 0 && !loading ? (
                <PaletteHint text="No clients match this search." />
              ) : (
                <ul role="listbox" aria-label="Client results">
                  {results.map((client, index) => (
                    <li key={client.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => openClient(client.id)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors',
                          index === activeIndex ? 'bg-surface-alt' : 'hover:bg-surface-alt',
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-text-primary">
                            {client.displayName}
                          </span>
                          <span className="block truncate text-[12px] text-text-secondary">
                            Q code {client.clientCode}
                            {client.phone ? ` · ${client.phone}` : ''}
                            {client.email ? ` · ${client.email}` : ''}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] font-medium text-text-muted">
                          Open ↵
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {trimmedTerm.length >= MIN_TERM_LENGTH && total > results.length ? (
              <button
                type="button"
                onClick={viewAllResults}
                className="flex w-full items-center justify-between border-t border-border px-4 py-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-surface-alt"
              >
                <span>
                  View all {total} results in Client Hub
                </span>
                <span aria-hidden>→</span>
              </button>
            ) : null}
            {loading ? (
              <div className="border-t border-border px-4 py-1.5 text-[11px] text-text-muted">
                Searching…
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function PaletteHint({ text, tone = 'default' }: { text: string; tone?: 'default' | 'danger' }) {
  return (
    <p
      className={cn(
        'px-4 py-6 text-center text-[13px]',
        tone === 'danger' ? 'text-danger' : 'text-text-secondary',
      )}
    >
      {text}
    </p>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.5 13.5 3.5 3.5" />
    </svg>
  );
}
