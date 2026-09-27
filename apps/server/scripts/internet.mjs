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
 * The address changes every time the tunnel starts; Ctrl+C stops both.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10) || 4000;
const CLOUDFLARED = process.env.CLOUDFLARED || 'cloudflared';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_TIMEOUT_MS = Number.parseInt(process.env.TUNNEL_TIMEOUT_MS ?? '60000', 10) || 60000;

const children = new Set();
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  // if nothing keeps the process alive the timer below never fires; the exit
  // code must survive a natural exit too
  process.exitCode = code;
  for (const child of children) {
    try {
      child.kill('SIGINT');
    } catch {
      // already gone
    }
  }
  // give the server a moment to close the database cleanly
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

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
    children.add(child);
    let found = false;
    let tail = '';
    const timer = setTimeout(() => {
      if (!found) reject(new Error(`Tünel ${Math.round(TUNNEL_TIMEOUT_MS / 1000)} saniyede açılmadı.\n${tail.slice(-800)}`));
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
      children.delete(child);
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`cloudflared kapandı (kod ${code}).\n${tail.slice(-800)}`));
      } else if (!stopping) {
        console.error('\n✗ Tünel kapandı, sunucu da kapatılıyor.');
        stopAll(1);
      }
    });
  });
}

function startServer(publicUrl) {
  const tsxCli = require.resolve('tsx/cli');
  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_URL: publicUrl,
      // cloudflared connects from this machine; its X-Forwarded-For is the real visitor
      TRUST_PROXY: process.env.TRUST_PROXY ?? 'loopback',
    },
  });
  children.add(child);
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`\n✗ Sunucu kapandı (kod ${code}), tünel de kapatılıyor.`);
      stopAll(code ?? 1);
    }
  });
  return child;
}

async function main() {
  console.log(`• Tünel açılıyor (cloudflared → http://localhost:${PORT})...`);
  let tunnel;
  try {
    tunnel = await startTunnel();
  } catch (error) {
    if (!error.quiet) console.error(`\n✗ ${error.message}`);
    stopAll(1);
    return;
  }
  startServer(tunnel.url);
  console.log(`
────────────────────────────────────────────────────────────
  ✓ KOYDUM internette:  ${tunnel.url}

  • Kankalar > Paylaş artık bu adresle bağlantı gönderir; başka
    şehirdeki kankan dokununca uygulama bu sunucuya bağlanır.
  • Kendi telefonun evdeki Wi-Fi'da kalabilir, aynı sunucudur.
  • Bu pencere açık kaldıkça çalışır. Ctrl+C ile kapanır.
  • Adres her açılışta değişir; kapatıp açarsan yeni bağlantı
    paylaş. Kankan dokunup "Yeni adrese geç"e basar, çıkış yapmaz.
    (Uygulaması eski sürümse bir kere yeniden giriş yapar.)
────────────────────────────────────────────────────────────
`);
}

main();
