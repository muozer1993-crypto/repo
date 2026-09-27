/**
 * Proof photos come back from the server as a path (`/uploads/x.jpg`), which
 * each phone resolves against the address IT uses for the server.
 *
 * Older servers (and any started without PUBLIC_URL) answered with an absolute
 * `http://localhost:4000/uploads/...` — right for the laptop, wrong for every
 * phone, which would ask itself for the picture. Those stored rows are rebased
 * here too, so the old photos show up again without touching the database.
 */
const LOOPBACK_UPLOAD = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/uploads\/.*)$/i;

export function resolveServerUrl(url: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const loopback = LOOPBACK_UPLOAD.exec(url);
  if (loopback) return `${base}${loopback[1]}`;
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('file:')) return url;
  return `${base}/${url.replace(/^\/+/, '')}`;
}

/** "http://192.168.1.20:4000" → true: a link only people on the same network can open. */
export function isLocalNetworkUrl(url: string): boolean {
  const host = url.replace(/^https?:\/\//i, '').split(/[/:]/)[0] ?? '';
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** "1.10.0" > "1.9.2"; missing parts count as 0; anything unparsable compares as equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10));
  const pb = b.split('.').map((part) => Number.parseInt(part, 10));
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
