/**
 * `npm run internet` with a stand-in cloudflared: the script must read the
 * tunnel address, start the server with it as PUBLIC_URL (so /health reports
 * it and the app shares links with it), and take both down on Ctrl+C.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '..', 'scripts', 'internet.mjs');
let child: ChildProcess | null = null;
const dirs: string[] = [];

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = null;
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
