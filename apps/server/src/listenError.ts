/**
 * The start-up failure the owner actually runs into: a second window (a forgotten
 * `npm run server` behind `npm run internet`) already holds the port. Node's own
 * report is an English stack trace; this is one line that says what to do.
 * Kept out of index.ts so a test can import it without booting a server.
 */
export function listenErrorMessage(err: unknown): string | null {
  const failure = err as { code?: unknown; port?: unknown } | null;
  if (failure?.code !== 'EADDRINUSE') return null;
  const port = typeof failure.port === 'number' ? `${failure.port} portu` : 'Port';
  return `✗ ${port} dolu: başka bir pencerede KOYDUM sunucusu açık kalmış. Onu kapat ya da .env'de PORT'u değiştir.`;
}
