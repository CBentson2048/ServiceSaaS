import { useEffect, useState } from 'react';
import type { SheerLabAnalyticsRange, SheerLabAnalyticsResponse } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import { getSheerLabAnalytics } from '../auth/api';

export interface UseSheerLabAnalyticsResult {
  data: SheerLabAnalyticsResponse | null;
  isLoading: boolean;
  error: Error | null;
}

export function useSheerLabAnalytics(range: SheerLabAnalyticsRange): UseSheerLabAnalyticsResult {
  const { session, user } = useAuth();
  const [data, setData] = useState<SheerLabAnalyticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!session?.accessToken || !user || (user.role !== 'owner' && user.role !== 'manager')) {
        setData(null);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const response = await getSheerLabAnalytics(session.accessToken, { range });
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
  }, [range, session?.accessToken, user]);

  return { data, isLoading, error };
}
