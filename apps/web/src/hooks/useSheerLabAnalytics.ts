import { useEffect, useState } from 'react';
import type { SheerLabAnalyticsRange, SheerLabAnalyticsResponse } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import { getSheerLabAnalytics } from '../auth/api';
import { resolveCustomWindow, type CustomRange } from '../components/dashboard/RangeTabs';

export interface UseSheerLabAnalyticsResult {
  data: SheerLabAnalyticsResponse | null;
  isLoading: boolean;
  error: Error | null;
}

export function useSheerLabAnalytics(
  range: SheerLabAnalyticsRange,
  custom?: CustomRange,
): UseSheerLabAnalyticsResult {
  const { session, user } = useAuth();
  const [data, setData] = useState<SheerLabAnalyticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const customFrom = custom?.from;
  const customTo = custom?.to;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!session?.accessToken || !user || (user.role !== 'owner' && user.role !== 'manager')) {
        setData(null);
        return;
      }

      const window = range === 'custom' ? resolveCustomWindow({ from: customFrom ?? '', to: customTo ?? '' }) : null;
      if (range === 'custom' && !window) {
        // Wait for both custom dates before fetching.
        setData(null);
        setIsLoading(false);
        setError(null);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const response = await getSheerLabAnalytics(
          session.accessToken,
          window ? { range, from: window.from, to: window.to } : { range },
        );
        if (!cancelled) setData(response);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error('Unable to load Sheer Lab analytics'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [range, customFrom, customTo, session?.accessToken, user]);

  return { data, isLoading, error };
}
