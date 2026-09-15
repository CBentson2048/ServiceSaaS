import { useEffect, useRef, useState } from 'react';

export interface PagedDetail<Row> {
  notStarted: boolean;
  rows: Row[];
  nextCursor: string | null;
}

/**
 * `'reloading'`: the cursor belongs to dates the filter no longer names; a fresh
 * first page is on its way as a new `initial`.
 */
export type LoadMoreResult<Row> = PagedDetail<Row> | 'reloading' | null;

/**
 * A report's detail list: Load more appends the next page; a new first page
 * starts again; a page that began before a reset never appends; one action
 * button (Load more / Loading… / Retry) keeps keyboard focus, and focus moves to
 * the list when that button goes away.
 */
export function usePagedDetail<Row>(initial: PagedDetail<Row>, loadMore: (cursor: string) => Promise<LoadMoreResult<Row>>) {
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const generation = useRef(0);
  const actionRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const focusList = useRef(false);
  const focusAfterReload = useRef(false);

  useEffect(() => {
    generation.current += 1;
    focusList.current = focusAfterReload.current;
    focusAfterReload.current = false;
    setRows(initial.rows);
    setCursor(initial.nextCursor);
    setState('idle');
  }, [initial]);

  useEffect(() => {
    if (focusList.current) {
      focusList.current = false;
      sectionRef.current?.focus({ preventScroll: true });
    }
  }, [rows]);

  const more = () => {
    if (cursor === null || state === 'loading') return;
    const started = generation.current;
    setState('loading');
    loadMore(cursor).then(
      (page) => {
        if (generation.current !== started) return;
        if (page === 'reloading') {
          focusAfterReload.current = document.activeElement === actionRef.current;
          return;
        }
        if (!page) {
          setState('error');
          return;
        }
        if (page.nextCursor === null && document.activeElement === actionRef.current) focusList.current = true;
        setRows((current) => [...current, ...page.rows]);
        setCursor(page.nextCursor);
        setState('idle');
      },
      () => {
        if (generation.current === started) setState('error');
      },
    );
  };

  return { rows, cursor, state, more, actionRef, sectionRef };
}
