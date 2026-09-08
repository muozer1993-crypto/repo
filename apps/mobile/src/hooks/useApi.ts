import { useMemo } from 'react';

import type { ApiClient } from '@/lib/api';
import { useAuth } from '@/store/auth';

/** A client bound to the current server URL and token. */
export function useApi(): ApiClient {
  const serverUrl = useAuth((s) => s.serverUrl);
  const token = useAuth((s) => s.token);
  const makeClient = useAuth((s) => s.client);
  return useMemo(() => makeClient(), [serverUrl, token, makeClient]);
}
