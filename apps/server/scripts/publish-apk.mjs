#!/usr/bin/env node
/**
 * Puts an Android build where the KOYDUM server serves it, so the invite page
 * can offer "Uygulamayı indir" and older installs learn a new version exists.
 *
 *   npm run apk:yayinla -- <dosya.apk> [--surum 1.1.0] [--not "Ekran süresi geldi"]
 *
 * The version defaults to `expo.version` in apps/mobile/app.json — the build you
 * just made from this checkout. The file lands in `<DATA_DIR>/app/koydum.apk`
 * (APP_DIR overrides), next to a `latest.json`; the running server picks both up
 * on the next request, no restart needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');

// a DATA_DIR or APP_DIR in the server's .env must put the APK where the server looks
loadDotEnv(path.join(serverRoot, '.env'));

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
let file = null;
let version = null;
let notes = null;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--surum' || arg === '--version') version = args[++i] ?? null;
  else if (arg === '--not' || arg === '--notes') notes = args[++i] ?? null;
  else if (!file) file = arg;
}

if (!file) {
  fail('APK dosyasını ver:  npm run apk:yayinla -- C:\\Users\\sen\\Downloads\\koydum.apk');
}
const source = path.resolve(process.cwd(), file);
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`Dosya yok: ${source}`);
if (!/\.apk$/i.test(source)) fail('Dosya .apk ile bitmeli. (Play için olan .aab burada işe yaramaz.)');
const head = Buffer.alloc(2);
const fd = fs.openSync(source, 'r');
fs.readSync(fd, head, 0, 2, 0);
fs.closeSync(fd);
if (head.toString('latin1') !== 'PK') fail('Bu dosya bir APK gibi görünmüyor.');

if (!version) {
  try {
    const appJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'mobile', 'app.json'), 'utf8'));
    version = appJson?.expo?.version ?? null;
  } catch {
    version = null;
  }
}
if (version && !/^\d{1,4}(\.\d{1,4}){0,3}$/.test(version)) fail(`Sürüm "${version}" olmaz, 1.1.0 gibi yaz.`);

const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim() ? path.resolve(serverRoot, process.env.DATA_DIR.trim()) : path.join(serverRoot, 'data');
const appDir = process.env.APP_DIR && process.env.APP_DIR.trim() ? path.resolve(serverRoot, process.env.APP_DIR.trim()) : path.join(dataDir, 'app');
fs.mkdirSync(appDir, { recursive: true });

// copy then rename, so a download that starts mid-copy never gets half a file
const target = path.join(appDir, 'koydum.apk');
const temp = `${target}.tmp`;
fs.copyFileSync(source, temp);
fs.renameSync(temp, target);
fs.writeFileSync(
  path.join(appDir, 'latest.json'),
  `${JSON.stringify({ version, notes, publishedAt: new Date().toISOString() }, null, 2)}\n`,
);

const mb = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);
console.log(`\n✓ Yayında: ${target} (${mb} MB)${version ? `, sürüm ${version}` : ''}`);
console.log('  Sunucu açıkken arkadaşların indirme bağlantısını davet sayfasında görür: http://<sunucu>/indir\n');
