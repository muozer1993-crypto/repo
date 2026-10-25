import { useState } from 'react';

/**
 * The spinner for a pull-to-refresh, shown from the pull until `run` settles
 * and at no other time.
 *
 * react-query's `isRefetching` is true for every background fetch as well: the
 * 45 s and 60 s polls, a push that invalidates a list, each step sync. Bound
 * to a RefreshControl, it dropped the spinner in by itself every 45 s and the
 * app looked stuck.
 */
export function usePullRefresh(run: () => unknown): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    void Promise.resolve()
      .then(run)
      // a failed fetch shows on the screen itself; the spinner only has to stop
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };
  return { refreshing, onRefresh };
}
