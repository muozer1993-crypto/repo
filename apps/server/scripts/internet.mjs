#!/usr/bin/env node
/**
 * npm run internet — the KOYDUM server, reachable from anywhere, in one command.
 *
 * Starts a Cloudflare "quick tunnel" (free, no account, no domain) in front of
 * the local server, reads the https://….trycloudflare.com address it prints,
 * and starts the server with that address as PUBLIC_URL. The app then puts that
 * address into every invite link it shares, so a friend in another city taps
 * the link and lands on this server — nobody types an IP, nobody opens a port.
 *
 * Needs `cloudflared` on the PATH (Windows: winget install --id Cloudflare.cloudflared).
 * A new tunnel means a new address and a new link for everyone, so this script
 * keeps the one it has: a crashed server is restarted behind the same tunnel, and
 * the server keeps serving the home Wi-Fi while a dropped tunnel is reopened.
 * Ctrl+C stops both.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnv } from './env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);

// the server's .env first: the tunnel must point at the PORT the server will use
loadDotEnv(path.join(serverRoot, '.env'));

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10) || 4000;
const CLOUDFLARED = process.env.CLOUDFLARED || 'cloudflared';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_TIMEOUT_MS = Number.parseInt(process.env.TUNNEL_TIMEOUT_MS ?? '60000', 10) || 60000;
// tsx as a loader in the server's own process, not the tsx CLI: the CLI is a
// wrapper around a second node process, and on Windows killing the wrapper left
// that one running on the port
const TSX = pathToFileURL(require.resolve('tsx')).href;

/** Waits before restarting a crashed server: the 1st, the 2nd, and every later crash. */
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000];
/** This many crashes inside the window is a bug restarting will not fix. */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 10 * 60_000;
/** Reopening a dropped tunnel backs off from 5 s to a minute and never gives up: the internet comes back. */
const TUNNEL_RETRY_FIRST_MS = 5_000;
const TUNNEL_RETRY_MAX_MS = 60_000;
/** The server waits up to 10 s for a push flush in flight (services/scheduler.ts); killed only after that. */
const SHUTDOWN_GRACE_MS = 15_000;

let server = null; // null between a crash and its restart
let tunnel = null; // the cloudflared whose address is in use
let publicUrl = null;
let stopping = false;
const tunnels = new Set(); // every cloudflared started, including attempts still waiting for an address
const replaced = new WeakSet(); // servers stopped on purpose for a new address: not a crash
const timers = new Set();
const crashes = [];

function later(ms, fn) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
}

function kill(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * Asks the server to close itself over IPC. A signal would do on Linux, but on
 * Windows child.kill() is TerminateProcess: no waiting for the push flush, no
 * database close.
 */
function askToStop(child) {
  const force = setTimeout(() => kill(child, 'SIGKILL'), SHUTDOWN_GRACE_MS);
  child.once('exit', () => clearTimeout(force));
  if (child.connected) {
    child.send({ type: 'shutdown' }, (error) => {
      if (error) kill(child, 'SIGTERM');
    });
  } else {
    kill(child, 'SIGTERM');
  }
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  // whichever way the process ends from here, it ends with this code
  process.exitCode = code;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const child of tunnels) kill(child, 'SIGINT');
  if (!server) {
    process.exit(code);
    return;
  }
  server.once('exit', () => process.exit(code));
  askToStop(server);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
// the console window closed (Windows sends it too), and Ctrl+Break on Windows
process.on('SIGHUP', () => stopAll(0));
if (process.platform === 'win32') process.on('SIGBREAK', () => stopAll(0));

function installHelp() {
  console.error(`
✗ cloudflared bulunamadı. Bir kere kur, sonra tekrar çalıştır:

  Windows (PowerShell):  winget install --id Cloudflare.cloudflared
                         (kurduktan sonra PowerShell'i kapatıp yeniden aç)
  macOS:                 brew install cloudflared
  Linux:                 https://github.com/cloudflare/cloudflared/releases
`);
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    const child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tunnels.add(child);
    let found = false;
    let tail = '';
    const timer = setTimeout(() => {
      if (found) return;
      // the next attempt starts its own; this one must not linger and grab an address later
      kill(child, 'SIGKILL');
      reject(new Error(`Tünel ${Math.round(TUNNEL_TIMEOUT_MS / 1000)} saniyede açılmadı.\n${tail.slice(-800)}`));
    }, TUNNEL_TIMEOUT_MS);
    const read = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      const match = URL_RE.exec(text) ?? URL_RE.exec(tail);
      if (match && !found) {
        found = true;
        clearTimeout(timer);
        resolve({ child, url: match[0] });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (error) => {
      clearTimeout(timer);
      if (error && error.code === 'ENOENT') {
        installHelp();
        reject(Object.assign(new Error('cloudflared yok'), { quiet: true }));
      } else {
        reject(error);
      }
    });
    child.on('exit', (code) => {
      tunnels.delete(child);
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`cloudflared kapandı (kod ${code}).\n${tail.slice(-800)}`));
      } else if (!stopping && child === tunnel) {
        tunnelLost();
      }
    });
  });
}

/** cloudflared gave up (the home connection dropped, usually). The server stays: the Wi-Fi still reaches it. */
function tunnelLost() {
  tunnel = null;
  console.error('\n✗ Tünel koptu (internet gitmiş olabilir), tekrar deniyorum...');
  console.error("  Sunucu açık, evdeki Wi-Fi'dan bağlananlar etkilenmez.");
  reopenTunnel(TUNNEL_RETRY_FIRST_MS);
}

function reopenTunnel(delay) {
  later(delay, async () => {
    let next;
    try {
      next = await startTunnel();
    } catch {
      if (stopping) return;
      const wait = Math.min(delay * 2, TUNNEL_RETRY_MAX_MS);
      console.error(`  Tünel hâlâ açılmadı, ${Math.round(wait / 1000)} saniye sonra yine deniyorum.`);
      reopenTunnel(wait);
      return;
    }
    if (stopping) {
      kill(next.child, 'SIGINT');
      return;
    }
    tunnel = next.child;
    if (next.url === publicUrl) {
      console.log(`\n✓ Tünel geri geldi, adres aynı: ${publicUrl}`);
      return;
    }
    publicUrl = next.url;
    restartServer();
    printBanner(true);
  });
}

function startServer() {
  const child = spawn(process.execPath, ['--import', TSX, 'src/index.ts'], {
    cwd: serverRoot,
    // the fourth channel is IPC: how askToStop reaches the server on every platform
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_URL: publicUrl,
      // cloudflared connects from this machine; its X-Forwarded-For is the real visitor
      TRUST_PROXY: process.env.TRUST_PROXY ?? 'loopback',
    },
  });
  server = child;
  console.log(`• Sunucu açılıyor (sunucu pid ${child.pid})...`);
  child.on('exit', (code, signal) => {
    if (server === child) server = null;
    if (stopping || replaced.has(child)) return;
    serverCrashed(code !== null ? `kod ${code}` : signal);
  });
}

function serverCrashed(how) {
  const now = Date.now();
  crashes.push(now);
  while (now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
  if (crashes.length >= CRASH_LIMIT) {
    console.error(`\n✗ Sunucu 10 dakikada ${CRASH_LIMIT} kere düştü, bırakıyorum. Sebebi yukarıdaki hatada yazıyor.`);
    stopAll(1);
    return;
  }
  const delay = RESTART_DELAYS_MS[Math.min(crashes.length, RESTART_DELAYS_MS.length) - 1];
  console.error(`\n✗ Sunucu düştü (${how}), yeniden açıyorum. Adres aynı, kimseye yeni bağlantı atma.`);
  later(delay, startServer);
}

/** The server reads PUBLIC_URL once at start; a new address needs a new process. */
function restartServer() {
  const old = server;
  // between a crash and its restart, or already on its way out: the next start reads the new address
  if (!old || replaced.has(old)) return;
  replaced.add(old);
  old.once('exit', () => {
    if (!stopping) startServer();
  });
  askToStop(old);
}

function printBanner(changed = false) {
  const first = changed
    ? '  • Yeni adres: Kankalar > Paylaş ile gruba tekrar at.'
    : `  • Kankalar > Paylaş artık bu adresle bağlantı gönderir; başka
    şehirdeki kankan dokununca uygulama bu sunucuya bağlanır.`;
  console.log(`
────────────────────────────────────────────────────────────
  ✓ KOYDUM internette:  ${publicUrl}

${first}
  • Kendi telefonun evdeki Wi-Fi'da kalabilir, aynı sunucudur.
  • Bu pencere açık kaldıkça çalışır. Ctrl+C ile kapanır. Sunucu
    düşerse yeniden açılır, adres aynı kalır.
  • Adres, pencereyi kapatıp açınca ya da internet kopup tünel
    yeniden kurulunca değişir; yenisi burada yazar. Paylaş'la
    gönderince kankan dokunup "Yeni adrese geç"e basar, çıkış
    yapmaz. (Uygulaması eski sürümse bağlantının açtığı sayfadan
    yeni sürümü kursun.)
────────────────────────────────────────────────────────────
`);
}

async function main() {
  console.log(`• Tünel açılıyor (cloudflared → http://localhost:${PORT})...`);
  let first;
  try {
    first = await startTunnel();
  } catch (error) {
    if (!error.quiet) console.error(`\n✗ ${error.message}`);
    stopAll(1);
    return;
  }
  if (stopping) return;
  tunnel = first.child;
  publicUrl = first.url;
  startServer();
  printBanner();
}

main();
