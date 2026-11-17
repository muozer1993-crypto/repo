/**
 * `npm run apk:yayinla` labels the APK with the version inside it, the one the
 * phone reports, never with apps/mobile/app.json: the checkout runs ahead of the
 * build friends have, and a 1.1.0 file published as 1.1.1 would show
 * "Yeni sürüm var" on every 1.1.0 phone for good. The APKs here are built by
 * hand, a few hundred bytes each: a zip around Android's binary XML manifest.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const serverRoot = path.resolve(__dirname, '..');
const script = path.join(serverRoot, 'scripts', 'publish-apk.mjs');
const checkoutVersion = (
  JSON.parse(fs.readFileSync(path.resolve(serverRoot, '..', 'mobile', 'app.json'), 'utf8')) as { expo: { version: string } }
).expo.version;
// far below any app.json this project will have, so "not from app.json" is real
const INSIDE = '0.9.3';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-apk-'));
  dirs.push(dir);
  return dir;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeUInt32LE(value >>> 0, i * 4));
  return buffer;
}

function chunk(type: number, headerSize: number, body: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(headerSize), u32(8 + body.length), body]);
}

/**
 * `<manifest xmlns:android=… package="com.koydum.app" android:versionName=…>` in
 * Android's binary XML, as aapt2 writes it: a string pool (UTF-16, or UTF-8),
 * the attribute resource-id map, then the namespace and element chunks.
 * `reference` makes the version a `@string/…` reference instead of text.
 */
function manifest(versionName: string, { utf8 = false, reference = false } = {}): Buffer {
  const strings = ['versionName', 'android', 'http://schemas.android.com/apk/res/android', 'manifest', 'package', 'com.koydum.app', versionName];
  const encoded = strings.map((text) =>
    utf8
      ? Buffer.concat([Buffer.from([text.length, Buffer.byteLength(text)]), Buffer.from(text, 'utf8'), Buffer.from([0])])
      : Buffer.concat([u16(text.length), Buffer.from(text, 'utf16le'), u16(0)]),
  );
  const offsets: number[] = [];
  let data = Buffer.alloc(0);
  for (const text of encoded) {
    offsets.push(data.length);
    data = Buffer.concat([data, text]);
  }
  data = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const pool = chunk(
    0x0001,
    28,
    Buffer.concat([u32(strings.length, 0, utf8 ? 0x100 : 0, 28 + strings.length * 4, 0), u32(...offsets), data]),
  );
  const resourceMap = chunk(0x0180, 8, u32(0x0101021c)); // string 0 is android:versionName
  const node = u32(1, 0xffffffff); // line number, no comment
  const typed = (dataType: number, value: number) => Buffer.concat([u16(8), Buffer.from([0, dataType]), u32(value)]);
  const attributes = Buffer.concat([
    reference ? Buffer.concat([u32(2, 0, 0xffffffff), typed(0x01, 0x7f0e0001)]) : Buffer.concat([u32(2, 0, 6), typed(0x03, 6)]),
    Buffer.concat([u32(0xffffffff, 4, 5), typed(0x03, 5)]),
  ]);
  const start = chunk(
    0x0102,
    16,
    Buffer.concat([node, u32(0xffffffff, 3), u16(20), u16(20), u16(2), u16(0), u16(0), u16(0), attributes]),
  );
  const body = Buffer.concat([
    pool,
    resourceMap,
    chunk(0x0100, 16, Buffer.concat([node, u32(1, 2)])),
    start,
    chunk(0x0103, 16, Buffer.concat([node, u32(0xffffffff, 3)])),
    chunk(0x0101, 16, Buffer.concat([node, u32(1, 2)])),
  ]);
  return chunk(0x0003, 8, body);
}

interface Entry {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

/**
 * A zip the way an APK is laid out. The local headers carry an extra field the
 * central directory does not (zipalign's padding), so the reader must skip the
 * local one. CRCs stay 0: the script never checks them.
 */
function apk(entries: Entry[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const padding = Buffer.alloc(3);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0, body.length, entry.data.length),
      u16(name.length), u16(padding.length),
      name, padding, body,
    ]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
        u32(0, body.length, entry.data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0, offset),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length, offset),
    u16(Buffer.byteLength(comment)), Buffer.from(comment),
  ]);
  return Buffer.concat([...locals, central, end]);
}

const dex: Entry = { name: 'classes.dex', data: Buffer.from('dex\n035\0 not really') };

function publish(file: Buffer, ...args: string[]) {
  const root = tempDir();
  const source = path.join(root, 'build-123.apk');
  fs.writeFileSync(source, file);
  const appDir = path.join(root, 'app'); // the script makes it, only once it is going to publish
  const run = spawnSync(process.execPath, [script, source, ...args], {
    env: { ...process.env, APP_DIR: appDir },
    encoding: 'utf8',
  });
  const latest = path.join(appDir, 'latest.json');
  return {
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    appDir,
    version: fs.existsSync(latest) ? (JSON.parse(fs.readFileSync(latest, 'utf8')) as { version: string }).version : null,
    copied: fs.existsSync(path.join(appDir, 'koydum.apk')) ? fs.readFileSync(path.join(appDir, 'koydum.apk')) : null,
  };
}

describe('npm run apk:yayinla', () => {
  it('labels the file with the version inside it, not the one in app.json', () => {
    expect(checkoutVersion).not.toBe(INSIDE);
    const file = apk([dex, { name: 'AndroidManifest.xml', data: manifest(INSIDE) }]);
    const result = publish(file);
    expect(result.status).toBe(0);
    expect(result.version).toBe(INSIDE);
    expect(result.copied?.equals(file)).toBe(true);
    expect(result.output).toContain(`sürüm ${INSIDE}`);
    expect(result.output).toContain(`app.json ${checkoutVersion} diyor ama bu APK ${INSIDE}; ${INSIDE} olarak yayınladım.`);
  });

  it('reads a deflated manifest with a UTF-8 string pool behind a zip comment', () => {
    const file = apk(
      [dex, { name: 'AndroidManifest.xml', data: manifest(INSIDE, { utf8: true }), deflate: true }, { name: 'assets/app.config', data: Buffer.from('{}') }],
      'koydum',
    );
    expect(publish(file)).toMatchObject({ status: 0, version: INSIDE });
  });

  it('stops when --surum says another version than the file, and publishes when they agree', () => {
    const file = apk([dex, { name: 'AndroidManifest.xml', data: manifest(INSIDE), deflate: true }]);
    const wrong = publish(file, '--surum', '1.1.1');
    expect(wrong.status).toBe(1);
    expect(wrong.output).toContain(`Bu APK'nın sürümü ${INSIDE}, sen --surum 1.1.1 yazdın. Doğru dosya mı?`);
    expect(fs.existsSync(wrong.appDir)).toBe(false);

    expect(publish(file, '--surum', INSIDE)).toMatchObject({ status: 0, version: INSIDE });
  });

  it('asks for --surum when the version cannot be read, never falling back to app.json', () => {
    for (const file of [
      apk([dex, { name: 'AndroidManifest.xml', data: manifest(INSIDE, { reference: true }) }]),
      apk([dex]),
      Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 1)]),
    ]) {
      const unread = publish(file);
      expect(unread.status).toBe(1);
      expect(unread.output).toContain("Bu APK'nın sürümünü içinden okuyamadım.");
      expect(unread.output).toContain('--surum 1.1.0');
      expect(fs.existsSync(unread.appDir)).toBe(false);

      const given = publish(file, '--surum', '1.3.0');
      expect(given).toMatchObject({ status: 0, version: '1.3.0' });
      expect(given.output).toContain('senin yazdığın 1.3.0 ile yayınladım');
    }
  });
});
