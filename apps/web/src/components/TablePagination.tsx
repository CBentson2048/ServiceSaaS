import type { CrmClientsPagination } from '@sheer/domain';

/**
 * Server-side table pager: visible row range + total, a windowed set of page
 * buttons with ellipses, and a rows-per-page select. Extracted from the CRM
 * Client Hub so every server-paginated table (clients, bills, …) shares one
 * control instead of re-implementing it.
 */
export function TablePagination({
  pagination,
  pageSize,
  pageSizeOptions,
  disabled,
  onChange,
  onPageSizeChange,
}: {
  pagination: CrmClientsPagination;
  pageSize: number;
  pageSizeOptions: readonly number[];
  disabled: boolean;
  onChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { page, total, pageCount } = pagination;
  // Use the server-echoed page size for the visible range so it always matches
  // the rows actually rendered, even for the brief moment after the size changes.
  const effectivePageSize = pagination.pageSize;
  const firstRow = (page - 1) * effectivePageSize + 1;
  const lastRow = Math.min(page * effectivePageSize, total);
  const pages = pageWindow(page, pageCount);

  return (
    <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <span>Rows per page</span>
          <select
            value={pageSize}
            disabled={disabled}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="Rows per page"
            className="h-8 rounded-input-lg border border-border-strong bg-surface px-2 text-[13px] font-medium text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[12px] text-text-secondary">
          Showing <span className="font-medium text-text-primary">{firstRow}</span>–
          <span className="font-medium text-text-primary">{lastRow}</span> of{' '}
          <span className="font-medium text-text-primary">{total}</span>
        </p>
      </div>
      <nav className="flex items-center gap-1" aria-label="Pagination">
        <PageButton
          label="Previous"
          disabled={disabled || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          ‹
        </PageButton>
        {pages.map((entry, index) =>
          entry === 'ellipsis' ? (
            <span key={`gap-${index}`} className="px-1.5 text-[13px] text-text-muted" aria-hidden>
              …
            </span>
          ) : (
            <PageButton
              key={entry}
              label={`Page ${entry}`}
              active={entry === page}
              disabled={disabled}
              onClick={() => onChange(entry)}
            >
              {entry}
            </PageButton>
          ),
        )}
        <PageButton
          label="Next"
          disabled={disabled || page >= pageCount}
          onClick={() => onChange(page + 1)}
        >
          ›
        </PageButton>
      </nav>
    </div>
  );
}

function PageButton({
  children,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-input-lg border px-2.5 text-[13px] font-medium transition ${
        active
          ? 'border-primary bg-primary text-text-on-primary'
          : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

// A compact page list: always shows first & last, the current page and its
// neighbours, and 'ellipsis' markers for the gaps in between.
function pageWindow(current: number, pageCount: number): Array<number | 'ellipsis'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const pages = new Set<number>([1, pageCount, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const result: Array<number | 'ellipsis'> = [];
  let previous = 0;
  for (const p of sorted) {
    if (p - previous > 1) result.push('ellipsis');
    result.push(p);
    previous = p;
  }
  return result;
}
