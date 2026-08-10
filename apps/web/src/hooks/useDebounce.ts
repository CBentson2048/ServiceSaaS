import { useEffect, useState } from 'react';

/**
 * Returns `value` once it has been stable for `delayMs`. Used to hold back
 * per-keystroke work (search requests, URL updates) until typing pauses.
 */
export function useDebounce<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
