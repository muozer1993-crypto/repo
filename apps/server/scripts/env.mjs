/**
 * `apps/server/.env` for the plain-Node scripts (internet.mjs, publish-apk.mjs),
 * which cannot import the TypeScript sources. The same parser as src/env.ts;
 * keep the two alike. Why not Node's process.loadEnvFile: see there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseDotEnv(text) {
  const values = {};
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
      value = value.replace(/\s+#.*$/, '');
    }
    values[key] = value;
  }
  return values;
}

/** Fills process.env from the file; a variable that is already set wins. */
export function loadDotEnv(file = path.join(serverRoot, '.env')) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return [];
  }
  const set = [];
  for (const [key, value] of Object.entries(parseDotEnv(decode(buffer)))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    set.push(key);
  }
  return set;
}
