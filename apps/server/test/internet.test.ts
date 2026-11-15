/**
 * `npm run internet` with a stand-in cloudflared: the script must read the
 * tunnel address, start the server with it as PUBLIC_URL (so /health reports
 * it and the app shares links with it), keep that address through a server
 * crash, through a run of crashes and through a start that waits for npm install,
 * start the server from new code on y + Enter, reopen a dropped tunnel without
 * taking the server down, and take both down on Ctrl+C.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listenErrorMessage, startupErrorMessage } from '../src/listenError.js';

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

/** A stand-in cloudflared that stays up with https://tunel-<n>.trycloudflare.com, n counting the tunnels opened. */
function tunnelPerAddress(dir: string): string {
  return stub(
    dir,
    [
      `n=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
      'n=$((n+1))',
      `echo $n > "${dir}/count"`,
      'echo "2026 INF |  https://tunel-$n.trycloudflare.com  |" 1>&2',
      'exec sleep 600',
    ].join('\n'),
  );
}

interface Run {
  /** Everything it printed so far. */
  output: () => string;
  /** The pids of every server it started, in order. */
  pids: () => number[];
  /** A line typed into its window; needs `keyboard`. */
  type: (line: string) => void;
}

/**
 * Runs `npm run internet` against the stub. Without `keyboard` its stdin is closed,
 * as when nobody can type into it.
 */
function runScript(port: number, fake: string, dir: string, options: { keyboard?: boolean; env?: NodeJS.ProcessEnv } = {}): Run {
  let output = '';
  child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      PORT: String(port),
      CLOUDFLARED: fake,
      DATA_DIR: path.join(dir, 'data'),
      LOG_LEVEL: 'warn',
      PUBLIC_URL: '',
      ...options.env,
    },
    stdio: [options.keyboard ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => (output += d.toString()));
  child.stderr?.on('data', (d) => (output += d.toString()));
  return {
    output: () => output,
    pids: () => [...output.matchAll(/sunucu pid (\d+)/g)].map((m) => Number(m[1])),
    type: (line) => child!.stdin!.write(`${line}\n`),
  };
}

/** Whether nothing answers on the port: the server is down, not just slow. */
async function portClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    return false;
  } catch {
    return true;
  }
}

/**
 * A `node --import` preload that makes `fastify` a package npm install never
 * fetched, as long as `flag` exists: the start a `git pull` with a new dependency
 * leaves behind.
 */
function withoutFastify(dir: string, flag: string): string {
  fs.writeFileSync(
    path.join(dir, 'hooks.mjs'),
    [
      "import fs from 'node:fs';",
      'export async function resolve(specifier, context, next) {',
      `  if (specifier === 'fastify' && fs.existsSync(${JSON.stringify(flag)})) {`,
      "    const error = new Error(`Cannot find package 'fastify' imported from ${context.parentURL}`);",
      "    throw Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' });",
      '  }',
      '  return next(specifier, context);',
      '}',
    ].join('\n'),
  );
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, "import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n");
  return `--import=${pathToFileURL(preload).href}`;
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

/**
 * The supervisor tests need a POSIX shell: the stand-in cloudflared is a
 * `#!/bin/sh` script, which Windows cannot run (the script would only say
 * "cloudflared yok"), and Ctrl+C is a SIGINT, which Windows turns into a kill
 * that no handler sees. On the owner's PC `npm test` skips them rather than
 * hang for minutes and fail, which would read as a broken server.
 */
const onPosix = it.skipIf(process.platform === 'win32');

describe('npm run internet', () => {
  onPosix('starts the server with the tunnel address and stops both on Ctrl+C', async () => {
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

  onPosix('restarts a crashed server behind the same address', async () => {
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

  onPosix('starts the server from the new code on y + Enter and stops it on dur, behind the same tunnel', async () => {
    const dir = tempDir();
    const fake = tunnelPerAddress(dir);
    const port = await freePort();
    const run = runScript(port, fake, dir, { keyboard: true });
    const url = 'https://tunel-1.trycloudflare.com';
    await waitFor(async () => ((await publicUrlOf(port)) === url ? true : null));
    expect(run.output()).toContain("Kodu güncelledin mi (git pull, npm install)? Burada y yazıp\n    Enter'a bas");

    run.type('y');
    await waitFor(async () => (run.pids().length === 2 && (await publicUrlOf(port)) === url ? true : null));
    expect(run.pids()[1]).not.toBe(run.pids()[0]);
    expect(run.output()).toContain(`• Sunucu yeni kodla yeniden açılıyor, adres aynı: ${url}`);
    // a restart the owner asked for is not a crash
    expect(run.output()).not.toContain('Sunucu düştü');

    // dur: the server goes (npm install may replace its files) and nothing brings it back on its own
    run.type('DUR');
    await waitFor(async () => (run.output().includes('Sunucu durdu, tünel açık, adres aynı.') ? true : null), 20_000);
    expect(await portClosed(port)).toBe(true);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(run.pids()).toHaveLength(2);
    expect(child!.exitCode).toBeNull();

    run.type('naber');
    await waitFor(async () => (run.output().includes('dur yazarsan durur') ? true : null), 5_000);

    run.type(' y ');
    await waitFor(async () => ((await publicUrlOf(port)) === url ? true : null));
    expect(run.pids()).toHaveLength(3);
    // one cloudflared all along: a second would have printed tunel-2
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf8').trim()).toBe('1');

    expect(await ctrlC()).toBe(0);
  }, 60_000);

  onPosix('keeps the tunnel after five crashes in a row and starts again on y + Enter', async () => {
    const dir = tempDir();
    const fake = tunnelPerAddress(dir);
    // a file where the data folder goes: openDb cannot create the folder, every start fails
    fs.writeFileSync(path.join(dir, 'data'), '');
    const port = await freePort();
    // the pause outlasts the test: only y + Enter can bring the server back in time
    const run = runScript(port, fake, dir, { keyboard: true, env: { KOYDUM_CRASH_PAUSE_MS: '600000' } });
    const url = 'https://tunel-1.trycloudflare.com';

    // 1 + 5 + 15 + 15 s between the five starts
    await waitFor(async () => (run.output().includes('Tüneli açık tutuyorum') ? true : null), 75_000);
    expect(run.output()).toContain(`Tüneli açık tutuyorum, adres aynı: ${url}`);
    expect(run.output()).toContain("10 dakikada bir yeniden deneyeceğim; düzelttiysen burada y yazıp Enter'a bas.");
    expect(run.pids()).toHaveLength(5);
    // the script and its cloudflared are still up
    expect(child!.exitCode).toBeNull();

    fs.rmSync(path.join(dir, 'data'));
    run.type('y');
    await waitFor(async () => ((await publicUrlOf(port)) === url ? true : null));
    expect(run.pids()).toHaveLength(6);
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf8').trim()).toBe('1');

    expect(await ctrlC()).toBe(0);
  }, 100_000);

  onPosix('waits for y + Enter instead of crashing when a package is missing', async () => {
    const dir = tempDir();
    const fake = tunnelPerAddress(dir);
    const flag = path.join(dir, 'fastify-missing');
    fs.writeFileSync(flag, '');
    const port = await freePort();
    const run = runScript(port, fake, dir, {
      keyboard: true,
      env: { NODE_OPTIONS: withoutFastify(dir, flag), KOYDUM_CRASH_PAUSE_MS: '600000' },
    });

    await waitFor(async () => (run.output().includes('Bir paket eksik (fastify)') ? true : null), 20_000);
    // not a crash: no restart a second later that would fail the same way
    await new Promise((r) => setTimeout(r, 2_000));
    expect(run.output()).not.toContain('Sunucu düştü');
    expect(run.pids()).toHaveLength(1);
    expect(child!.exitCode).toBeNull();

    // npm install brought the package
    fs.rmSync(flag);
    run.type('y');
    await waitFor(async () => ((await publicUrlOf(port)) === 'https://tunel-1.trycloudflare.com' ? true : null));
    expect(run.pids()).toHaveLength(2);

    expect(await ctrlC()).toBe(0);
  }, 60_000);

  onPosix('keeps the server up while a dropped tunnel is reopened, then serves the new address', async () => {
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

  it('says in Turkish that a package is missing, without a stack, and exits for the owner to act', async () => {
    const dir = tempDir();
    const flag = path.join(dir, 'fastify-missing');
    fs.writeFileSync(flag, '');
    let output = '';
    child = spawn(process.execPath, ['--import', tsx, 'src/index.ts'], {
      cwd: serverRoot,
      env: { ...process.env, NODE_OPTIONS: withoutFastify(dir, flag), DATA_DIR: path.join(dir, 'data'), LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    const code = await new Promise<number | null>((resolve) => child!.on('exit', (c) => resolve(c)));

    expect(code).toBe(3);
    expect(output).toContain('✗ Bir paket eksik (fastify), git pull yeni bir paket getirmiş olabilir: kök klasörde npm install çalıştır');
    expect(output).not.toMatch(/\n\s+at /);
    expect(output).not.toContain('Cannot find package');
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

  it('gives the start-up failures the owner can fix a Turkish line and an exit code', () => {
    const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', port: 4000 });
    // a busy port is retried: it works once the other window is closed
    expect(startupErrorMessage(busy)).toEqual({ text: listenErrorMessage(busy), code: 1 });

    const esm = Object.assign(new Error("Cannot find package '@fastify/cors' imported from C:\\koydum\\apps\\server\\src\\app.ts"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(startupErrorMessage(esm)).toEqual({
      text: "✗ Bir paket eksik (@fastify/cors), git pull yeni bir paket getirmiş olabilir: kök klasörde npm install çalıştır, sonra sunucuyu yeniden aç. npm run internet açıksa kapatma: bu pencerede y yazıp Enter'a bas, adres değişmez.",
      code: 3,
    });
    const cjs = Object.assign(new Error("Cannot find module 'bindings'\nRequire stack:\n- /koydum/node_modules/better-sqlite3/lib/database.js"), {
      code: 'MODULE_NOT_FOUND',
    });
    expect(startupErrorMessage(cjs)?.text).toContain('Bir paket eksik (bindings)');
    // a half-finished install: a file missing inside a package
    const partial = Object.assign(new Error("Cannot find module '/koydum/node_modules/fastify/lib/route.js' imported from /koydum/node_modules/fastify/fastify.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(startupErrorMessage(partial)?.text).toContain('Bir paket eksik (fastify)');
    // one of the server's own files: npm install does not bring it back, the stack says which import broke
    const ours = Object.assign(new Error("Cannot find module '/koydum/apps/server/src/yok.js' imported from /koydum/apps/server/src/app.ts"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(startupErrorMessage(ours)).toBeNull();

    const version = new Error(
      "The module '\\\\?\\C:\\koydum\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.",
    );
    expect(startupErrorMessage(version)).toEqual({
      text: "✗ better-sqlite3 bu Node.js sürümüyle açılmıyor (Node.js güncellenince olur): kök klasörde npm rebuild better-sqlite3 çalıştır, sonra sunucuyu yeniden aç. npm run internet açıksa kapatma: bu pencerede y yazıp Enter'a bas, adres değişmez.",
      code: 3,
    });
    const dlopen = Object.assign(new Error('\\\\?\\C:\\koydum\\better_sqlite3.node is not a valid Win32 application.'), { code: 'ERR_DLOPEN_FAILED' });
    expect(startupErrorMessage(dlopen)?.code).toBe(3);

    expect(startupErrorMessage(new Error('boom'))).toBeNull();
    expect(startupErrorMessage(null)).toBeNull();
  });
});
