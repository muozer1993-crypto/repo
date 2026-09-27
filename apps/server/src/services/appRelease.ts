/**
 * The Android build friends should install, when the operator published one.
 *
 * Two ways to publish, the first wins:
 *   1. `npm run apk:yayinla -- <file.apk>` copies the APK to `<appDir>/koydum.apk`
 *      and writes `<appDir>/latest.json` ({ version, notes?, publishedAt }). The
 *      server then serves it itself at `/koydum.apk`, so the invite page can
 *      offer a download that works wherever the server is reachable.
 *   2. APP_DOWNLOAD_URL (+ APP_LATEST_VERSION): a build hosted somewhere else,
 *      e.g. the expo.dev build page.
 *
 * Read on every call: publishing a new APK must not need a server restart, and
 * one stat plus a tiny JSON read is nothing next to a request.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';

export const APK_FILE = 'koydum.apk';
export const RELEASE_FILE = 'latest.json';

export interface AppRelease {
  /** "1.1.0", or null when the operator did not say */
  version: string | null;
  /** absolute URL a phone can open */
  downloadUrl: string;
  notes: string | null;
  /** bytes, when the server hosts the file itself */
  size: number | null;
  /** true when `/koydum.apk` is served from this server */
  hosted: boolean;
}

const VERSION_RE = /^\d{1,4}(\.\d{1,4}){0,3}$/;

export function apkPath(config: Pick<Config, 'appDir'>): string {
  return path.join(path.resolve(config.appDir), APK_FILE);
}

function readMeta(config: Pick<Config, 'appDir'>): { version: string | null; notes: string | null } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.resolve(config.appDir), RELEASE_FILE), 'utf8')) as {
      version?: unknown;
      notes?: unknown;
    };
    const version = typeof raw.version === 'string' && VERSION_RE.test(raw.version.trim()) ? raw.version.trim() : null;
    const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim().slice(0, 500) : null;
    return { version, notes };
  } catch {
    return { version: null, notes: null };
  }
}

export function currentRelease(
  config: Pick<Config, 'appDir' | 'appDownloadUrl' | 'appLatestVersion'>,
  origin: string,
): AppRelease | null {
  try {
    const stat = fs.statSync(apkPath(config));
    if (stat.isFile() && stat.size > 0) {
      const meta = readMeta(config);
      return {
        version: meta.version,
        downloadUrl: `${origin}/${APK_FILE}`,
        notes: meta.notes,
        size: stat.size,
        hosted: true,
      };
    }
  } catch {
    // no hosted file; fall through to the external link
  }
  if (config.appDownloadUrl && /^https?:\/\//i.test(config.appDownloadUrl)) {
    const version = config.appLatestVersion && VERSION_RE.test(config.appLatestVersion) ? config.appLatestVersion : null;
    return { version, downloadUrl: config.appDownloadUrl, notes: null, size: null, hosted: false };
  }
  return null;
}
