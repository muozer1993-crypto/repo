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
 * keeps the one it has: a crashed server is restarted behind the same tunnel (a
 * server that keeps crashing is retried every few minutes, never given up on), the
 * server keeps serving the home Wi-Fi while a dropped tunnel is reopened, and the
 * owner updates the code without closing the window: `y` + Enter starts the
 * server again from the new code, `dur` + Enter stops it for an `npm install`.
 * No tunnel at the start (no internet, or Cloudflare handing out none) is the
 * same as a dropped one: the server starts for the home Wi-Fi and the tunnel is
 * retried until its address can be printed. Ctrl+C stops both.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnv } from './env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);

// the server's .env first: the tunnel must point at the PORT the server will use
loadDotEnv(path.join(serverRoot, '.env'));

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10) || 4000;
const CLOUDFLARED = process.env.CLOUDFLARED || 'cloudflared';
/**
 * The tunnel's address, printed bare in a box. Offline, cloudflared prints the
 * endpoint it failed to reach, https://api.trycloudflare.com/tunnel, which this
 * must not take for one: the window would hand the group an address that answers
 * every invite link with 405.
 */
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?![\w.\/-])/i;
const TUNNEL_TIMEOUT_MS = Number.parseInt(process.env.TUNNEL_TIMEOUT_MS ?? '60000', 10) || 60000;
// tsx as a loader in the server's own process, not the tsx CLI: the CLI is a
// wrapper around a second node process, and on Windows killing the wrapper left
// that one running on the port
const TSX = pathToFileURL(require.resolve('tsx')).href;

/** Waits before restarting a crashed server: the 1st, the 2nd, and every later crash. */
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000];
/** This many crashes inside the window is a bug restarting will not fix soon. */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 10 * 60_000;
/**
 * After that, or after a start that cannot work until the owner acts, the server
 * waits this long between tries; the tunnel and its address stay. The variable is
 * for the tests.
 */
const PAUSE_MS = Number.parseInt(process.env.KOYDUM_CRASH_PAUSE_MS ?? '300000', 10) || 300_000;
/**
 * The server's exit code for "an npm install or npm rebuild away from working"
 * (NEEDS_OWNER_EXIT_CODE in src/listenError.ts, which a .mjs cannot import). It
 * printed what to do; a retry within seconds would fail the same way.
 */
const NEEDS_OWNER_EXIT_CODE = 3;
/** Reopening a dropped tunnel backs off from 5 s to a minute and never gives up: the internet comes back. */
const TUNNEL_RETRY_FIRST_MS = 5_000;
const TUNNEL_RETRY_MAX_MS = 60_000;
/** The server waits up to 10 s for a push flush in flight (services/scheduler.ts); killed only after that. */
const SHUTDOWN_GRACE_MS = 15_000;

let server = null; // null between a crash and its restart, and while paused or held
let tunnel = null; // the cloudflared whose address is in use
let publicUrl = null;
let stopping = false;
let restartTimer = null; // the restart after a crash or a pause; y + Enter starts the server sooner
let held = false; // `dur` + Enter: no server until y + Enter, so npm install can replace its files
const tunnels = new Set(); // every cloudflared started, including attempts still waiting for an address
const replaced = new WeakSet(); // servers stopped on purpose (a new address, y, dur): not a crash
const timers = new Set();
const crashes = [];

function later(ms, fn) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
  return timer;
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
    // none before it (no internet at the start): the group hears of this one for the first time
    const firstAddress = publicUrl === null;
    publicUrl = next.url;
    restartServer();
    printBanner(!firstAddress);
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
      // No tunnel yet: spawn would pass null on as the string "null", which the
      // server takes for an address it was given. Empty means the address each
      // phone came in on, which is right on the home Wi-Fi.
      PUBLIC_URL: publicUrl ?? '',
      // cloudflared connects from this machine; its X-Forwarded-For is the real visitor
      TRUST_PROXY: process.env.TRUST_PROXY ?? 'loopback',
    },
  });
  server = child;
  console.log(`• Sunucu açılıyor (sunucu pid ${child.pid})...`);
  child.on('exit', (code, signal) => {
    if (server === child) server = null;
    if (stopping || replaced.has(child)) return;
    // it printed what to do (npm install, npm rebuild); a start in a second would fail the same way
    if (code === NEEDS_OWNER_EXIT_CODE) {
      pause();
      return;
    }
    serverCrashed(code !== null ? `kod ${code}` : signal);
  });
}

function serverCrashed(how) {
  const now = Date.now();
  crashes.push(now);
  while (now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
  if (crashes.length >= CRASH_LIMIT) {
    // Not stopAll: closing the tunnel costs everyone the address, and what usually
    // causes this (a forgotten window on the port, a package missing after a pull)
    // is fixed in a minute.
    console.error(`\n✗ Sunucu 10 dakikada ${CRASH_LIMIT} kere düştü, sebebi yukarıdaki hatada.`);
    console.error(publicUrl ? `  Tüneli açık tutuyorum, adres aynı: ${publicUrl}` : `  ${NO_TUNNEL_YET}`);
    console.error(
      `  ${Math.max(1, Math.round(PAUSE_MS / 60_000))} dakikada bir yeniden deneyeceğim; düzelttiysen burada y yazıp Enter'a bas.`,
    );
    pause();
    return;
  }
  const delay = RESTART_DELAYS_MS[Math.min(crashes.length, RESTART_DELAYS_MS.length) - 1];
  console.error(
    publicUrl
      ? `\n✗ Sunucu düştü (${how}), yeniden açıyorum. Adres aynı, kimseye yeni bağlantı atma.`
      : `\n✗ Sunucu düştü (${how}), yeniden açıyorum.`,
  );
  restartTimer = later(delay, startServer);
}

/** No server for a while, the tunnel kept: the next try starts a fresh count of crashes. */
function pause() {
  crashes.length = 0;
  restartTimer = later(PAUSE_MS, startServer);
}

/** Drops a restart that is waiting: y + Enter starts the server now, `dur` + Enter not at all. */
function cancelRestart() {
  if (restartTimer === null) return;
  clearTimeout(restartTimer);
  timers.delete(restartTimer);
  restartTimer = null;
}

/** Said wherever the address would be while there is none: never "null", never an old guess. */
const NO_TUNNEL_YET = 'Tünel henüz açılmadı, açılınca adres burada yazar.';

function heldLine() {
  return publicUrl
    ? "• Sunucu durdu, tünel açık, adres aynı. npm install bitince burada y yazıp Enter'a bas."
    : "• Sunucu durdu. npm install bitince burada y yazıp Enter'a bas.";
}

/**
 * The server reads PUBLIC_URL and its code once at start; a new address or new code
 * needs a new process. After `dur` + Enter the old one goes and none follows.
 */
function restartServer() {
  const old = server;
  // between a crash and its restart, or already on its way out: the next start reads the new address
  if (!old || replaced.has(old)) return;
  replaced.add(old);
  old.once('exit', () => {
    if (stopping) return;
    // `held` as it is now, not when this began: y + Enter while it was closing undoes `dur`
    if (held) console.log(heldLine());
    else startServer();
  });
  askToStop(old);
}

/**
 * A line the owner typed into this window. `y` after a git pull + npm install
 * starts the server from the new code behind the same tunnel, so nobody needs a
 * new link; `dur` stops it for an npm install that must replace a file the running
 * server holds open (better-sqlite3's .node, on Windows).
 */
function onCommand(line) {
  if (stopping) return;
  // Turkish keyboard or not, caps lock or not: YENİDEN, YENIDEN and yeniden are the same word
  const command = line.trim().toLocaleLowerCase('tr').replaceAll('ı', 'i');
  if (command === '') return;
  if (command === 'y' || command === 'yeniden') {
    cancelRestart();
    crashes.length = 0;
    held = false;
    if (server) {
      console.log(
        publicUrl ? `• Sunucu yeni kodla yeniden açılıyor, adres aynı: ${publicUrl}` : `• Sunucu yeni kodla yeniden açılıyor. ${NO_TUNNEL_YET}`,
      );
      restartServer();
    } else {
      startServer();
    }
  } else if (command === 'dur') {
    held = true;
    if (server) {
      console.log(publicUrl ? '• Sunucu kapanıyor, tünel açık kalıyor...' : '• Sunucu kapanıyor...');
      restartServer();
    } else {
      cancelRestart();
      console.log(heldLine());
    }
  } else {
    console.log("  Burada y yazıp Enter'a basarsan sunucu yeni kodla açılır, dur yazarsan durur (npm install için).");
    console.log('  İkisinde de tünel ve adres kalır. Kapatmak için Ctrl+C.');
  }
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
  • Kodu güncelledin mi (git pull, npm install)? Burada y yazıp
    Enter'a bas: sunucu yeni kodla açılır, adres değişmez.
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
  let first = null;
  try {
    first = await startTunnel();
  } catch (error) {
    // cloudflared is not installed: nothing changes until the owner installs it
    if (error.quiet) {
      stopAll(1);
      return;
    }
    if (stopping) return;
    // Usually no internet, or Cloudflare's limit on quick tunnels: both pass. Closing
    // the window here left the friends at home without a server too.
    console.error(`\n✗ ${error.message.trimEnd()}`);
    console.error('\n✗ Tünel açılamadı: internet yok ya da Cloudflare şu an tünel vermiyor.');
    console.error("  Sunucuyu yine de açıyorum, evdeki Wi-Fi'dan bağlananlar oynayabilir.");
    console.error('  Tüneli açılana kadar deniyorum, adres o zaman burada yazar.');
  }
  if (stopping) return;
  if (first) {
    tunnel = first.child;
    publicUrl = first.url;
    startServer();
    printBanner();
  } else {
    startServer();
    reopenTunnel(TUNNEL_RETRY_FIRST_MS);
  }
  // Lines, with no output and terminal: false, so stdin never goes raw and Ctrl+C
  // still reaches this process as SIGINT. A stdin that ends (the tests' 'ignore')
  // just means no commands. Only once a server was started: y before that would
  // start a second one.
  readline.createInterface({ input: process.stdin, terminal: false }).on('line', onCommand);
}

main();
