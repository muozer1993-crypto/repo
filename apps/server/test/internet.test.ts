/**
 * `npm run internet` with a stand-in cloudflared: the script must read the
 * tunnel address, start the server with it as PUBLIC_URL (so /health reports
 * it and the app shares links with it), keep that address through a server
 * crash, reopen a dropped tunnel without taking the server down, and take both
 * down on Ctrl+C.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listenErrorMessage } from '../src/listenError.js';

const serverRoot = path.resolve(__dirname, '..');
const script = path.join(serverRoot, 'scripts', 'internet.mjs');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
let child: ChildProcess | null = null;
const dirs: string[] = [];
const servers: net.Server[] = [];

afterEach(() => {
  // SIGKILL leaves the IPC channel broken, and the server shuts itself down on that
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = null;
  for (const srv of servers.splice(0)) srv.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function stub(dir: string, body: string): string {
  const file = path.join(dir, 'cloudflared');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

async function waitFor<T>(check: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timed out');
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-internet-'));
  dirs.push(dir);
  return dir;
}

/** Runs `npm run internet` against the stub; `output()` is everything it printed so far. */
function runScript(port: number, fake: string, dir: string): { output: () => string } {
  let output = '';
  child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), CLOUDFLARED: fake, DATA_DIR: path.join(dir, 'data'), LOG_LEVEL: 'warn', PUBLIC_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => (output += d.toString()));
  child.stderr?.on('data', (d) => (output += d.toString()));
  return { output: () => output };
}

async function publicUrlOf(port: number): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return res.ok ? ((await res.json()) as { publicUrl: string | null }).publicUrl : null;
}

async function ctrlC(): Promise<number | null> {
  const exited = new Promise<number | null>((resolve) => child!.on('exit', (code) => resolve(code)));
  child!.kill('SIGINT');
  return exited;
}

describe('npm run internet', () => {
  it('starts the server with the tunnel address and stops both on Ctrl+C', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-internet-'));
    dirs.push(dir);
    // cloudflared prints the address on stderr inside a box, then keeps running
    const fake = stub(dir, `echo "2026 INF |  https://tatli-koydum-deneme.trycloudflare.com  |" 1>&2\nexec sleep 600`);
    const port = await freePort();
    let output = '';
    child = spawn(process.execPath, [script], {
      env: { ...process.env, PORT: String(port), CLOUDFLARED: fake, DATA_DIR: path.join(dir, 'data'), LOG_LEVEL: 'warn', PUBLIC_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));

    const health = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok ? ((await res.json()) as { publicUrl: string | null }) : null;
    });
    expect(health.publicUrl).toBe('https://tatli-koydum-deneme.trycloudflare.com');
    expect(output).toContain('KOYDUM internette:  https://tatli-koydum-deneme.trycloudflare.com');

    const exited = new Promise<number | null>((resolve) => child!.on('exit', (code) => resolve(code)));
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    // the port is free again: the server really went down
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`);
        return null;
      } catch {
        return true;
      }
    }, 10_000);
  }, 60_000);

  it('restarts a crashed server behind the same address', async () => {
    const dir = tempDir();
    const fake = stub(dir, `echo "2026 INF |  https://ayni-adres-kalsin.trycloudflare.com  |" 1>&2\nexec sleep 600`);
    const port = await freePort();
    const run = runScript(port, fake, dir);

    const url = 'https://ayni-adres-kalsin.trycloudflare.com';
    await waitFor(async () => ((await publicUrlOf(port)) === url ? true : null));
    const pid = Number(/sunucu pid (\d+)/.exec(run.output())?.[1]);
    expect(pid).toBeGreaterThan(0);

    process.kill(pid, 'SIGKILL');
    await waitFor(async () => (run.output().includes('yeniden açıyorum') ? true : null), 10_000);
    expect(run.output()).toContain('Adres aynı, kimseye yeni bağlantı atma.');

    // a new process, the same tunnel, the same address
    await waitFor(async () => ((await publicUrlOf(port)) === url ? true : null));
    const pids = [...run.output().matchAll(/sunucu pid (\d+)/g)].map((m) => Number(m[1]));
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(pid);

    expect(await ctrlC()).toBe(0);
  }, 60_000);

  it('keeps the server up while a dropped tunnel is reopened, then serves the new address', async () => {
    const dir = tempDir();
    // The first cloudflared dies once the test drops it (the home internet went);
    // every later one prints a fresh address and stays up.
    const fake = stub(
      dir,
      [
        `n=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
        'n=$((n+1))',
        `echo $n > "${dir}/count"`,
        'echo "2026 INF |  https://tunel-$n.trycloudflare.com  |" 1>&2',
        `if [ "$n" = 1 ]; then while [ ! -f "${dir}/drop" ]; do sleep 0.1; done; exit 1; fi`,
        'exec sleep 600',
      ].join('\n'),
    );
    const port = await freePort();
    const run = runScript(port, fake, dir);

    await waitFor(async () => ((await publicUrlOf(port)) === 'https://tunel-1.trycloudflare.com' ? true : null));
    fs.writeFileSync(path.join(dir, 'drop'), '');
    await waitFor(async () => (run.output().includes('Tünel koptu') ? true : null), 10_000);
    // the Wi-Fi at home still reaches the server while the tunnel is down
    expect(await publicUrlOf(port)).toBe('https://tunel-1.trycloudflare.com');

    await waitFor(async () => ((await publicUrlOf(port)) === 'https://tunel-2.trycloudflare.com' ? true : null), 40_000);
    expect(run.output()).toContain('KOYDUM internette:  https://tunel-2.trycloudflare.com');
    expect(run.output()).toContain('Yeni adres: Kankalar > Paylaş ile gruba tekrar at.');
    // a planned restart for the new address is not a crash
    expect(run.output()).not.toContain('Sunucu düştü');

    expect(await ctrlC()).toBe(0);
  }, 60_000);

  it('explains how to install cloudflared when it is missing', async () => {
    const port = await freePort();
    let output = '';
    child = spawn(process.execPath, [script], {
      env: { ...process.env, PORT: String(port), CLOUDFLARED: '/nonexistent/cloudflared' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    const code = await new Promise<number | null>((resolve) => child!.on('exit', (c) => resolve(c)));
    expect(code).toBe(1);
    expect(output).toContain('winget install --id Cloudflare.cloudflared');
  }, 30_000);
});

describe('the server entry', () => {
  it('says in one Turkish line that another window holds the port, without a stack', async () => {
    const dir = tempDir();
    const port = await freePort();
    const taken = net.createServer();
    servers.push(taken);
    await new Promise<void>((resolve) => taken.listen(port, '127.0.0.1', resolve));

    let output = '';
    child = spawn(process.execPath, ['--import', tsx, 'src/index.ts'], {
      cwd: serverRoot,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    const code = await new Promise<number | null>((resolve) => child!.on('exit', (c) => resolve(c)));

    expect(code).toBe(1);
    expect(output).toContain(`✗ ${port} portu dolu: başka bir pencerede KOYDUM sunucusu açık kalmış.`);
    expect(output).not.toMatch(/\n\s+at /);
  }, 30_000);

  it('turns only a busy port into the Turkish line', () => {
    const busy = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:4000'), {
      code: 'EADDRINUSE',
      port: 4000,
    });
    expect(listenErrorMessage(busy)).toBe(
      "✗ 4000 portu dolu: başka bir pencerede KOYDUM sunucusu açık kalmış. Onu kapat ya da .env'de PORT'u değiştir.",
    );
    expect(listenErrorMessage(new Error('boom'))).toBeNull();
    expect(listenErrorMessage(null)).toBeNull();
  });
});
