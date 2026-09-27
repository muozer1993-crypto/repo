/**
 * apps/server/.env, the file the README tells the owner to create. It is read by
 * the entry points (the server, npm run yonet, the scripts), so a PORT typed there
 * has to reach loadConfig; and it has to survive how Windows saves files: Notepad's
 * BOM and CRLF, PowerShell 5's UTF-16.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadDotEnv, parseDotEnv } from '../src/env.js';

const KEYS = ['PORT', 'LOG_LEVEL', 'HOST', 'KOYDUM_TEST_QUOTED', 'KOYDUM_TEST_SINGLE', 'KOYDUM_TEST_EMPTY'];
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A file the way Notepad saves it: BOM up front, CRLF line ends. */
const NOTEPAD =
  '﻿PORT=4123\r\n' +
  '# evdeki bilgisayar\r\n' +
  '\r\n' +
  'LOG_LEVEL="warn"   # kısa olsun\r\n' +
  "KOYDUM_TEST_SINGLE='tek tırnak # değil yorum'\r\n" +
  'export KOYDUM_TEST_QUOTED="a b"\r\n' +
  'KOYDUM_TEST_EMPTY=\r\n' +
  'bu satır bozuk\r\n';

function envFile(content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-env-'));
  dirs.push(dir);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  return file;
}

function clear(): void {
  for (const key of KEYS) delete process.env[key];
}

describe('loadDotEnv', () => {
  it('feeds PORT and LOG_LEVEL from a Notepad-saved file into loadConfig', () => {
    clear();
    const set = loadDotEnv(envFile(NOTEPAD));

    const config = loadConfig({ dataDir: ':memory:' });
    expect(config.port).toBe(4123);
    expect(config.logLevel).toBe('warn');
    expect(process.env.KOYDUM_TEST_SINGLE).toBe('tek tırnak # değil yorum');
    expect(process.env.KOYDUM_TEST_QUOTED).toBe('a b');
    expect(process.env.KOYDUM_TEST_EMPTY).toBe('');
    expect(set).toEqual(['PORT', 'LOG_LEVEL', 'KOYDUM_TEST_SINGLE', 'KOYDUM_TEST_QUOTED', 'KOYDUM_TEST_EMPTY']);
  });

  it('never overrides a variable that is already set', () => {
    clear();
    process.env.PORT = '5000';
    loadDotEnv(envFile(NOTEPAD));
    expect(loadConfig({ dataDir: ':memory:' }).port).toBe(5000);
    expect(process.env.LOG_LEVEL).toBe('warn');
  });

  it("reads PowerShell 5's UTF-16 output", () => {
    clear();
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('PORT=4555\r\nHOST=127.0.0.1\r\n', 'utf16le')]);
    loadDotEnv(envFile(utf16));
    expect(process.env.PORT).toBe('4555');
    expect(process.env.HOST).toBe('127.0.0.1');
  });

  it('is fine without a file: everything has a default', () => {
    clear();
    expect(loadDotEnv(path.join(os.tmpdir(), 'koydum-yok', '.env'))).toEqual([]);
    expect(process.env.PORT).toBeUndefined();
  });

  it('parses the same way in the plain-Node scripts (scripts/env.mjs)', () => {
    const file = envFile(NOTEPAD);
    const script = pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'env.mjs')).href;
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: '5000' };
    for (const key of KEYS.slice(1)) delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(script)});
         const parsed = m.parseDotEnv(${JSON.stringify(NOTEPAD)});
         m.loadDotEnv(${JSON.stringify(file)});
         console.log(JSON.stringify({ parsed, PORT: process.env.PORT, LOG_LEVEL: process.env.LOG_LEVEL }));`,
      ],
      { env, encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    const out = JSON.parse(result.stdout) as { parsed: Record<string, string>; PORT: string; LOG_LEVEL: string };
    expect(out.parsed).toEqual(parseDotEnv(NOTEPAD));
    expect(out).toMatchObject({ PORT: '5000', LOG_LEVEL: 'warn' });
  });
});
