#!/usr/bin/env node
/**
 * Puts an Android build where the KOYDUM server serves it, so the invite page
 * can offer "Uygulamayı indir" and older installs learn a new version exists.
 *
 *   npm run apk:yayinla -- <dosya.apk> [--surum 1.1.0] [--not "Ekran süresi geldi"]
 *
 * The version is read from inside the APK: the versionName in its manifest,
 * which is what the phone reports as its own version. Not apps/mobile/app.json:
 * the checkout is often a version ahead of the build friends run, and a 1.1.0
 * file published as 1.1.1 shows "Yeni sürüm var" on every 1.1.0 phone, which
 * installing that same file never clears. --surum is for an APK whose version
 * cannot be read; when it can, --surum must agree with it.
 *
 * The file lands in `<DATA_DIR>/app/koydum.apk` (APP_DIR overrides), next to a
 * `latest.json`; the running server picks both up on the next request, no
 * restart needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
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

// android:versionName's resource id, for a manifest whose attribute names were stripped
const VERSION_NAME_ID = 0x0101021c;

/** The strings of an Android binary-XML string pool chunk, UTF-8 or UTF-16. */
function stringPool(chunk) {
  const headerSize = chunk.readUInt16LE(2);
  const count = chunk.readUInt32LE(8);
  const utf8 = (chunk.readUInt32LE(16) & 0x100) !== 0;
  const start = chunk.readUInt32LE(20);
  const list = [];
  for (let i = 0; i < count; i += 1) {
    let at = start + chunk.readUInt32LE(headerSize + i * 4);
    let length;
    if (utf8) {
      // the length in UTF-16 units comes first; the byte length after it is the one to read
      at += chunk[at] & 0x80 ? 2 : 1;
      if (chunk[at] & 0x80) {
        length = ((chunk[at] & 0x7f) << 8) | chunk[at + 1];
        at += 2;
      } else {
        length = chunk[at];
        at += 1;
      }
      list.push(chunk.toString('utf8', at, at + length));
    } else {
      length = chunk.readUInt16LE(at);
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | chunk.readUInt16LE(at + 2);
        at += 4;
      } else at += 2;
      list.push(chunk.toString('utf16le', at, at + length * 2));
    }
  }
  return list;
}

/** android:versionName on the first element (<manifest>) of a binary AndroidManifest.xml. */
function manifestVersion(xml) {
  if (xml.readUInt16LE(0) !== 0x0003) return null;
  let strings = [];
  const ids = [];
  for (let at = xml.readUInt16LE(2); at + 8 <= xml.length; ) {
    const type = xml.readUInt16LE(at);
    const headerSize = xml.readUInt16LE(at + 2);
    const size = xml.readUInt32LE(at + 4);
    if (size < 8) return null;
    if (type === 0x0001) strings = stringPool(xml.subarray(at, at + size));
    else if (type === 0x0180) for (let p = at + headerSize; p + 4 <= at + size; p += 4) ids.push(xml.readUInt32LE(p));
    else if (type === 0x0102) {
      const ext = at + headerSize;
      const attrSize = xml.readUInt16LE(ext + 10);
      for (let i = 0; i < xml.readUInt16LE(ext + 12); i += 1) {
        const attr = ext + xml.readUInt16LE(ext + 8) + i * attrSize;
        const name = xml.readUInt32LE(attr + 4);
        if (ids[name] === undefined ? strings[name] !== 'versionName' : ids[name] !== VERSION_NAME_ID) continue;
        // the literal text, else a typed string; a resource reference we cannot follow
        const raw = xml.readUInt32LE(attr + 8);
        const value = raw !== 0xffffffff ? strings[raw] : xml[attr + 15] === 0x03 ? strings[xml.readUInt32LE(attr + 16)] : null;
        return typeof value === 'string' && value ? value : null;
      }
      return null;
    }
    at += size;
  }
  return null;
}

/**
 * The version the APK itself carries, or null when it cannot be read. An APK is
 * a zip: find AndroidManifest.xml through the central directory, inflate it
 * with node:zlib and read Android's binary XML. No zip64: an APK is far below 4 GB.
 */
function apkVersion(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
    };
    // the end-of-central-directory record: 22 bytes plus a comment of up to 64 KB
    const size = fs.fstatSync(fd).size;
    const tail = read(Math.max(0, size - 65_557), Math.min(size, 65_557));
    let end = tail.length - 22;
    while (end >= 0 && !(tail.readUInt32LE(end) === 0x06054b50 && tail.readUInt16LE(end + 20) === tail.length - end - 22)) end -= 1;
    if (end < 0) return null;
    const entries = tail.readUInt16LE(end + 10);
    const dir = read(tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 12));
    for (let at = 0, i = 0; i < entries && dir.readUInt32LE(at) === 0x02014b50; i += 1) {
      const nameLength = dir.readUInt16LE(at + 28);
      if (dir.toString('utf8', at + 46, at + 46 + nameLength) === 'AndroidManifest.xml') {
        const method = dir.readUInt16LE(at + 10);
        const offset = dir.readUInt32LE(at + 42);
        const local = read(offset, 30);
        const data = read(offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), dir.readUInt32LE(at + 20));
        if (method === 0) return manifestVersion(data);
        if (method === 8) return manifestVersion(zlib.inflateRawSync(data));
        return null;
      }
      at += 46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
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

const inside = apkVersion(source);
if (version && inside && version !== inside) {
  fail(
    `Bu APK'nın sürümü ${inside}, sen --surum ${version} yazdın. Doğru dosya mı?\n` +
      `  ${version} derlemesini expo.dev'den indir. Bu dosyayı yayınlayacaksan --surum yazma, sürümü APK'dan okurum.`,
  );
}
if (!version && !inside) {
  fail(
    "Bu APK'nın sürümünü içinden okuyamadım. expo.dev'deki derleme sayfasında yazan sürümü sen ver:\n" +
      `  npm run apk:yayinla -- ${/\s/.test(file) ? `"${file}"` : file} --surum 1.1.0`,
  );
}
version = version || inside;
if (!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(version)) fail(`Sürüm "${version}" olmaz, 1.1.0 gibi yaz.`);

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

// The checkout's app.json never decides the version; it only explains a
// surprise: a version bumped ahead of any build, or an old file downloaded by mistake.
let checkout = null;
try {
  checkout = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'mobile', 'app.json'), 'utf8'))?.expo?.version ?? null;
} catch {
  checkout = null;
}

const mb = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);
console.log(`\n✓ Yayında: ${target} (${mb} MB), sürüm ${version}`);
if (!inside) console.log(`  • Sürümü APK'nın içinden okuyamadım, senin yazdığın ${version} ile yayınladım.`);
else if (checkout && checkout !== inside) console.log(`  • app.json ${checkout} diyor ama bu APK ${inside}; ${inside} olarak yayınladım.`);
console.log('  Sunucu açıkken arkadaşların indirme bağlantısını davet sayfasında görür: http://<sunucu>/indir\n');
