/**
 * The start-up failures the owner actually runs into, each as one Turkish line that
 * says what to do instead of Node's English stack trace. Kept out of main.ts so
 * index.ts can report them even when main.ts itself cannot load (a package that
 * `npm install` never fetched), and so a test can import them without booting a
 * server.
 */

/**
 * The exit code of a start that fails the same way until the owner does something
 * (`npm install`, `npm rebuild`, another PORT). npm run internet (scripts/internet.mjs,
 * which cannot import this) does not count it as a crash: it keeps the tunnel and
 * waits for y + Enter (or its five-minute retry) instead of retrying within seconds.
 */
export const NEEDS_OWNER_EXIT_CODE = 3;

/** What both fixes end with: under npm run internet, a restart that keeps the address. */
const RESTART =
  "sonra sunucuyu yeniden aç. npm run internet açıksa kapatma: bu pencerede y yazıp Enter'a bas, adres değişmez.";

/**
 * A second window (a forgotten `npm run server` behind `npm run internet`) already
 * holds the port.
 */
export function listenErrorMessage(err: unknown): string | null {
  const failure = err as { code?: unknown; port?: unknown } | null;
  if (failure?.code !== 'EADDRINUSE') return null;
  const port = typeof failure.port === 'number' ? `${failure.port} portu` : 'Port';
  return `✗ ${port} dolu: başka bir pencerede KOYDUM sunucusu açık kalmış. Onu kapat ya da .env'de PORT'u değiştir.`;
}

/**
 * The package a module-not-found error is about, or null when what is missing is
 * one of the server's own files: npm install does not bring those back, and the
 * stack is what says which import broke.
 */
function missingPackage(message: string): string | null {
  const wanted = /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1];
  if (!wanted) return null;
  // a bare name ('fastify', '@fastify/cors', 'fastify/lib/x.js'): ESM's "Cannot find package", CJS's require
  const bare = /^(@[\w.-]+\/[\w.-]+|[\w-][\w.-]*)(?:\/[^:\\]*)?$/.exec(wanted);
  if (bare) return bare[1];
  // a file inside node_modules: a half-finished install
  return /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(wanted)?.[1]?.replace('\\', '/') ?? null;
}

/**
 * The line to print and the exit code for a start that failed, or null for a failure
 * that needs its stack. A busy port exits 1: npm run internet retries it, and the
 * retry works once the other window is closed.
 */
export function startupErrorMessage(err: unknown): { text: string; code: number } | null {
  const busy = listenErrorMessage(err);
  if (busy) return { text: busy, code: 1 };
  // A port the system will not give: on Windows one inside a range that WSL, Docker
  // Desktop or Hyper-V reserved at boot (4000 can be), on Linux one below 1024. No
  // retry gets it, and y cannot help either: npm run internet reads PORT once, so the
  // new port in .env takes a fresh npm run internet, and with it a new address.
  const denied = err as { code?: unknown; syscall?: unknown; port?: unknown } | null;
  if (denied?.code === 'EACCES' && denied.syscall === 'listen') {
    const port = typeof denied.port === 'number' ? `${denied.port} portunu` : 'Portu';
    return {
      text: `✗ ${port} açmaya izin yok (Windows'ta WSL, Docker ya da Hyper-V bu portu kendine ayırmış olabilir): apps/server/.env'e PORT=4100 gibi başka bir port yaz, sonra sunucuyu yeniden aç. npm run internet açıksa y yetmez: Ctrl+C'ye basıp npm run internet'i yeniden aç; adres değişir, Paylaş'la yenisini gönder.`,
      code: NEEDS_OWNER_EXIT_CODE,
    };
  }
  const failure = err as { code?: unknown; message?: unknown } | null;
  const message = typeof failure?.message === 'string' ? failure.message : '';
  if (failure?.code === 'ERR_MODULE_NOT_FOUND' || failure?.code === 'MODULE_NOT_FOUND') {
    const name = missingPackage(message);
    if (name === null) return null;
    return {
      text: `✗ Bir paket eksik (${name}), git pull yeni bir paket getirmiş olabilir: kök klasörde npm install çalıştır, ${RESTART}`,
      code: NEEDS_OWNER_EXIT_CODE,
    };
  }
  // better-sqlite3 is the server's one native module, built for the Node.js that ran npm install
  if (failure?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(message)) {
    return {
      text: `✗ better-sqlite3 bu Node.js sürümüyle açılmıyor (Node.js güncellenince olur): kök klasörde npm rebuild better-sqlite3 çalıştır, ${RESTART}`,
      code: NEEDS_OWNER_EXIT_CODE,
    };
  }
  return null;
}
