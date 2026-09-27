/**
 * `apps/server/.env` — the settings file the README tells the owner to create.
 *
 * Read by the entry points only (index.ts, cli/yonet.ts), never by loadConfig or
 * buildApp, so a test run stays hermetic whatever sits in the owner's folder.
 * scripts/env.mjs is the same parser for the plain-Node scripts; keep the two alike.
 *
 * Node's own process.loadEnvFile is not used: it keeps a UTF-8 BOM as part of the
 * first key, so a file saved by Notepad would silently lose its first line (PORT,
 * in .env.example). PowerShell 5's `>` and Out-File write UTF-16, handled too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `<apps/server>/.env`, whatever the current directory is. */
export const DEFAULT_ENV_FILE = path.join(serverRoot, '.env');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function decode(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** KEY=value lines; `#` comments, `export ` prefixes and quotes the way dotenv files write them. */
export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      // an unquoted value ends where a comment starts: `PORT=4001 # evdeki`
      value = value.replace(/\s+#.*$/, '');
    }
    values[key] = value;
  }
  return values;
}

/**
 * Copies the file's values into process.env. A variable that is already set wins
 * (Docker, `$env:PORT=...`, npm run internet's PUBLIC_URL), so the file is the
 * owner's defaults, never an override. A missing file is fine: everything has a
 * default. Returns the keys it set.
 */
export function loadDotEnv(file: string = DEFAULT_ENV_FILE): string[] {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(decode(buffer)))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    set.push(key);
  }
  return set;
}
