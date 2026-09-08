import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Where the KOYDUM server lives. Order of preference:
 *   1. a URL the user typed in the app (persisted, see store/auth)
 *   2. EXPO_PUBLIC_KOYDUM_API_URL from the environment at build time
 *   3. the host that served the JS bundle in development (so a phone on the
 *      same Wi-Fi reaches the laptop without anyone typing an IP address)
 *   4. http://localhost:4000
 */
export const DEFAULT_PORT = 4000;

export function guessServerUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_KOYDUM_API_URL;
  if (fromEnv) return stripTrailingSlash(fromEnv);

  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
    const { protocol, hostname, port } = window.location;
    // when the web build is served by the API itself, use the same origin
    if (port === String(DEFAULT_PORT)) return stripTrailingSlash(window.location.origin);
    return `${protocol}//${hostname}:${DEFAULT_PORT}`;
  }

  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host) return `http://${host}:${DEFAULT_PORT}`;
  }

  return `http://localhost:${DEFAULT_PORT}`;
}

export function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Accepts "192.168.1.20", "192.168.1.20:4000", "https://x.dev" and normalises them. */
export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    if (!url.port && url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
      // bare LAN IPs almost always mean the default port
      if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) url.port = String(DEFAULT_PORT);
    }
    return stripTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

export const APP_NAME = 'KOYDUM';
