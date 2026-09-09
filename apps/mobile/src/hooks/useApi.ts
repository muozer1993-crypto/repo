import { useMemo } from 'react';

import type { ApiClient } from '@/lib/api';
import { useAuth } from '@/store/auth';

/** A client bound to the current server URL and token. */
export function useApi(): ApiClient {
  const serverUrl = useAuth((s) => s.serverUrl);
  const token = useAuth((s) => s.token);
  const makeClient = useAuth((s) => s.client);
  // `makeClient` is a stable zustand action that reads the CURRENT url and
  // token, so the two values below are listed only to rebuild the client when
  // either of them changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => makeClient(), [serverUrl, token, makeClient]);
}
