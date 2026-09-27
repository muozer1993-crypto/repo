import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/store/auth';

/**
 * Is the KOYDUM server reachable right now?
 *
 * There is no NetInfo dependency here on purpose: what matters to the user is
 * not "is there Wi-Fi" but "can this phone talk to my friends' server", which
 * is exactly what a /health probe answers. We only declare the app offline
 * after two consecutive failures so a single dropped packet does not flash a
 * banner at the user.
 */

const HEALTHY_INTERVAL_MS = 60_000;
const UNHEALTHY_INTERVAL_MS = 8_000;
const FAILURES_BEFORE_OFFLINE = 2;
/**
 * A lift ride or a dropped Wi-Fi is over well before this. A laptop that went
 * to sleep, or a tunnel restarted under a new address, is not: past this point
 * the banner stops saying "wait" and says the address may have moved.
 */
const LONG_OFFLINE_MS = 2 * 60_000;

export interface ConnectionState {
  online: boolean;
  /** null until the first probe finishes */
  checked: boolean;
  lastOkAt: number | null;
  /** unreachable for LONG_OFFLINE_MS in a row */
  longOffline: boolean;
  retry: () => void;
}

export function useConnection(): ConnectionState {
  const serverUrl = useAuth((s) => s.serverUrl);
  const token = useAuth((s) => s.token);
  const [online, setOnline] = useState(true);
  const [checked, setChecked] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [longOffline, setLongOffline] = useState(false);
  const failures = useRef(0);
  // when the current run of failures began; a success ends the run
  const failingSince = useRef<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // A foreground event that lands while a probe is awaiting `fetch` has no
    // pending timeout to clear, so without this generation stamp the old chain
    // would keep rescheduling itself next to the new one and double the rate.
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const probe = async (gen: number) => {
      let ok = false;
      try {
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), 6000);
        const response = await fetch(`${serverUrl}/health`, { signal: controller.signal });
        clearTimeout(abort);
        ok = response.ok;
      } catch {
        ok = false;
      }
      if (cancelled || gen !== generation) return;

      if (ok) {
        failures.current = 0;
        failingSince.current = null;
        setOnline(true);
        setLongOffline(false);
        setLastOkAt(Date.now());
      } else {
        failures.current += 1;
        failingSince.current ??= Date.now();
        if (failures.current >= FAILURES_BEFORE_OFFLINE) setOnline(false);
        if (Date.now() - failingSince.current >= LONG_OFFLINE_MS) setLongOffline(true);
      }
      setChecked(true);
      timer = setTimeout(() => void probe(gen), ok ? HEALTHY_INTERVAL_MS : UNHEALTHY_INTERVAL_MS);
    };

    const restart = () => {
      generation += 1;
      if (timer) clearTimeout(timer);
      void probe(generation);
    };

    restart();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') restart();
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [serverUrl, nonce, token]);

  return { online, checked, lastOkAt, longOffline, retry: () => setNonce((n) => n + 1) };
}
