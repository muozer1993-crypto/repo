/**
 * Proof photos without what the phone wrote into them (src/services/images.ts):
 * what the bytes are, whatever the client said, and each format walked by hand,
 * the metadata blocks left out and every byte of the picture kept. Plus the pass
 * at every start over the photos stored before any of this.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrubUploadDir, sniffImage, stripMetadata } from '../src/services/images.js';
import { GPS_MARKER, JPEG_1X1, JPEG_WITH_GPS } from './helpers.js';

/** A real 1×1 PNG: signature, IHDR, IDAT, IEND. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4UaEBAAN0AWnL+tDXAAAAAElFTkSuQmCC',
  'base64',
);

/** A real 1×1 lossy WebP in the extended format: VP8X (EXIF flag on), VP8, and an EXIF chunk naming the camera "KOYDUM". */
const WEBP_WITH_EXIF = Buffer.from(
  'UklGRnYAAABXRUJQVlA4WAoAAAAIAAAAAAAAAAAAVlA4IC4AAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+pNf/TSPGkeNI+Yt/84ljqd3aAAAARVhJRiIAAABNTQAqAAAACAABAQ8AAgAAAAcAAAAaAAAAAEtPWURVTQAA',
  'base64',
);

/** The same picture in the simple format: VP8 and nothing else. */
const WEBP_SIMPLE = Buffer.from(
  'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+pNf/TSPGkeNI+Yt/84ljqd3aAAAA',
  'base64',
);

/** A JPEG marker segment: FF, the marker, the length (which counts itself), the payload. */
function segment(marker: number, payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/** `JPEG_1X1` with these segments between its SOI and the rest. */
function jpegWith(...segments: Buffer[]): Buffer {
  return Buffer.concat([JPEG_1X1.subarray(0, 2), ...segments, JPEG_1X1.subarray(2)]);
}

/** A PNG chunk with a real CRC. */
function pngChunk(type: string, data: Buffer | string): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), typeof data === 'string' ? Buffer.from(data, 'latin1') : data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG_1X1's chunks: [IHDR, IDAT, IEND], each with its length and CRC. */
function pngChunks(): Buffer[] {
  const chunks: Buffer[] = [];
  for (let at = 8; at < PNG_1X1.length; ) {
    const end = at + 12 + PNG_1X1.readUInt32BE(at);
    chunks.push(PNG_1X1.subarray(at, end));
    at = end;
  }
  return chunks;
}

/** The fourccs of a WebP's chunks, walked the way a decoder would; throws when the sizes do not add up. */
function webpChunks(buf: Buffer): string[] {
  expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
  const found: string[] = [];
  let at = 12;
  while (at < buf.length) {
    const size = buf.readUInt32LE(at + 4);
    found.push(buf.toString('latin1', at, at + 4));
    at += 8 + size + (size % 2);
  }
  expect(at).toBe(buf.length);
  return found;
}

describe('sniffImage', () => {
  it('goes by the bytes', () => {
    expect(sniffImage(JPEG_1X1)).toBe('jpg');
    expect(sniffImage(PNG_1X1)).toBe('png');
    expect(sniffImage(WEBP_WITH_EXIF)).toBe('webp');
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('stripMetadata: JPEG', () => {
  it('drops the Exif APP1 with the GPS in it and keeps the picture, byte for byte', () => {
    const clean = stripMetadata(JPEG_WITH_GPS, 'jpg')!;
    expect(clean.includes('Exif')).toBe(false);
    expect(clean.includes(GPS_MARKER)).toBe(false);
    expect(clean.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(clean.subarray(-2).toString('hex')).toBe('ffd9');
    // the JFIF APP0 stays where it was
    expect(clean.subarray(2, 4).toString('hex')).toBe('ffe0');
    expect(clean.toString('latin1', 6, 10)).toBe('JFIF');
    expect(clean).toEqual(JPEG_1X1);
  });

  it('drops XMP, IPTC and comments, keeps the ICC profile and the fill bytes', () => {
    const icc = segment(0xe2, 'ICC_PROFILE\0\x01\x01profil');
    const filled = Buffer.concat([Buffer.from([0xff, 0xff]), segment(0xee, 'Adobe\0renk').subarray(1)]);
    const dirty = jpegWith(
      segment(0xe1, `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS_MARKER}</x:xmpmeta>`),
      icc,
      segment(0xed, `Photoshop 3.0\0${GPS_MARKER}`),
      filled,
      segment(0xfe, `kanit ${GPS_MARKER}`),
    );
    const clean = stripMetadata(dirty, 'jpg')!;
    expect(clean.includes(GPS_MARKER)).toBe(false);
    expect(clean).toEqual(jpegWith(icc, filled));
  });

  it('copies everything from the first scan on as it came, even bytes that look like a marker', () => {
    const trailer = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0sonrasi', 'latin1')]);
    const clean = stripMetadata(Buffer.concat([JPEG_WITH_GPS, trailer]), 'jpg')!;
    expect(clean).toEqual(Buffer.concat([JPEG_1X1, trailer]));
  });

  it('refuses a file that does not read like a JPEG up to its first scan', () => {
    // a segment whose length runs past the end
    expect(stripMetadata(JPEG_WITH_GPS.subarray(0, 40), 'jpg')).toBeNull();
    // a length shorter than the length field itself
    expect(stripMetadata(jpegWith(Buffer.from([0xff, 0xe1, 0x00, 0x01])), 'jpg')).toBeNull();
    // a byte where a marker should be
    expect(stripMetadata(jpegWith(Buffer.from([0x12, 0x34])), 'jpg')).toBeNull();
    // tables and an end, but no scan: no picture
    expect(stripMetadata(Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'), 'jpg')).toBeNull();
    // cut inside the fill bytes
    expect(stripMetadata(Buffer.from('ffd8ffffff', 'hex'), 'jpg')).toBeNull();
  });
});

describe('stripMetadata: PNG', () => {
  it('drops eXIf, the text chunks and tIME and keeps IHDR, IDAT and IEND untouched', () => {
    const [ihdr, idat, iend] = pngChunks();
    const dirty = Buffer.concat([
      PNG_1X1.subarray(0, 8),
      ihdr,
      pngChunk('eXIf', Buffer.concat([Buffer.from('4d4d002a00000008', 'hex'), Buffer.from(GPS_MARKER, 'latin1')])),
      pngChunk('tEXt', `Comment\0${GPS_MARKER}`),
      pngChunk('iTXt', `XML:com.adobe.xmp\0\0\0\0\0${GPS_MARKER}`),
      pngChunk('zTXt', Buffer.concat([Buffer.from('Raw profile type exif\0\0', 'latin1'), zlib.deflateSync(GPS_MARKER)])),
      idat,
      pngChunk('tIME', Buffer.from('07ea0b0f0c0000', 'hex')),
      iend,
    ]);
    const clean = stripMetadata(dirty, 'png')!;
    expect(clean.includes(GPS_MARKER)).toBe(false);
    expect(clean).toEqual(PNG_1X1);
  });

  it('gives back a PNG cut short as it came', () => {
    const truncated = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect(stripMetadata(truncated, 'png')).toEqual(truncated);
    const cutInIdat = PNG_1X1.subarray(0, 45);
    expect(stripMetadata(cutInIdat, 'png')).toEqual(cutInIdat);
  });
});

describe('stripMetadata: WebP', () => {
  it('drops the EXIF chunk, clears its flag in VP8X and rewrites the RIFF size', () => {
    expect(webpChunks(WEBP_WITH_EXIF)).toEqual(['VP8X', 'VP8 ', 'EXIF']);
    const clean = stripMetadata(WEBP_WITH_EXIF, 'webp')!;
    expect(webpChunks(clean)).toEqual(['VP8X', 'VP8 ']);
    expect(clean.includes('KOYDUM')).toBe(false);
    expect(clean[20] & 0x08).toBe(0);
    // the picture itself, unchanged
    expect(clean.subarray(30)).toEqual(WEBP_SIMPLE.subarray(12));
  });

  it('drops an odd-sized XMP chunk with its padding byte', () => {
    const xmp = Buffer.concat([Buffer.from('XMP ', 'latin1'), Buffer.from([7, 0, 0, 0]), Buffer.from('<x:gps>'), Buffer.from([0])]);
    const vp8x = Buffer.from(WEBP_WITH_EXIF.subarray(12, 30));
    vp8x[8] = 0x04;
    const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, xmp, WEBP_SIMPLE.subarray(12)]);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    const dirty = Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body]);
    expect(webpChunks(dirty)).toEqual(['VP8X', 'XMP ', 'VP8 ']);

    const clean = stripMetadata(dirty, 'webp')!;
    expect(webpChunks(clean)).toEqual(['VP8X', 'VP8 ']);
    expect(clean[20]).toBe(0);
  });

  it('leaves a simple WebP as it is and refuses one whose sizes do not add up', () => {
    expect(stripMetadata(WEBP_SIMPLE, 'webp')).toEqual(WEBP_SIMPLE);
    // the RIFF says it is longer than the file
    expect(stripMetadata(WEBP_SIMPLE.subarray(0, 40), 'webp')).toBeNull();
    // a chunk longer than the RIFF around it
    const overlong = Buffer.from(WEBP_SIMPLE);
    overlong.writeUInt32LE(0x1000, 16);
    expect(stripMetadata(overlong, 'webp')).toBeNull();
  });
});

describe('scrubUploadDir', () => {
  let dir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function folder(files: Record<string, Buffer>): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-scrub-'));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
  }

  const read = (name: string): Buffer => fs.readFileSync(path.join(dir!, name));

  it('cleans the photo with GPS in it and leaves the clean one byte-identical', async () => {
    const uploads = folder({ 'konumlu.jpg': JPEG_WITH_GPS, 'temiz.png': PNG_1X1 });
    expect(await scrubUploadDir(uploads)).toEqual({ checked: 2, cleaned: 1, failed: 0 });
    expect(read('konumlu.jpg')).toEqual(JPEG_1X1);
    expect(read('temiz.png')).toEqual(PNG_1X1);
    expect(fs.readdirSync(uploads).sort()).toEqual(['konumlu.jpg', 'temiz.png']);

    // the next start finds nothing to do
    expect(await scrubUploadDir(uploads)).toEqual({ checked: 2, cleaned: 0, failed: 0 });
  });

  it('never touches what it cannot read as an image', async () => {
    const broken = JPEG_WITH_GPS.subarray(0, 40);
    const uploads = folder({ 'yazi.jpg': Buffer.from('koydum'), 'bozuk.jpg': broken, 'not.txt': JPEG_WITH_GPS });
    expect(await scrubUploadDir(uploads)).toEqual({ checked: 2, cleaned: 0, failed: 0 });
    expect(read('yazi.jpg').toString()).toBe('koydum');
    expect(read('bozuk.jpg')).toEqual(broken);
    expect(read('not.txt')).toEqual(JPEG_WITH_GPS);
  });

  it('reads past the head of a big photo only when the head cannot settle it', async () => {
    // a scan bigger than the head the pass reads first
    const scan = Buffer.alloc(200 * 1024, 0x5a);
    const bigClean = Buffer.concat([JPEG_1X1.subarray(0, -2), scan, JPEG_1X1.subarray(-2)]);
    const bigWithGps = Buffer.concat([JPEG_WITH_GPS.subarray(0, -2), scan, JPEG_WITH_GPS.subarray(-2)]);
    // GPS behind 70 KB of ICC profile: the first scan is past the head
    const icc = Buffer.concat([0, 1].map(() => segment(0xe2, Buffer.alloc(35_000, 0x11))));
    const lateGps = jpegWith(icc, segment(0xe1, `Exif\0\0${GPS_MARKER}`));
    const uploads = folder({ 'buyuk-temiz.jpg': bigClean, 'buyuk-konumlu.jpg': bigWithGps, 'gec.jpg': lateGps });

    const readFile = vi.spyOn(fs.promises, 'readFile');
    expect(await scrubUploadDir(uploads)).toEqual({ checked: 3, cleaned: 2, failed: 0 });
    expect(readFile.mock.calls.map(([file]) => path.basename(String(file))).sort()).toEqual(['buyuk-konumlu.jpg', 'gec.jpg']);
    expect(read('buyuk-temiz.jpg')).toEqual(bigClean);
    expect(read('buyuk-konumlu.jpg')).toEqual(Buffer.concat([JPEG_1X1.subarray(0, -2), scan, JPEG_1X1.subarray(-2)]));
    expect(read('gec.jpg')).toEqual(jpegWith(icc));
  });

  it('leaves the photo as it was when the rewrite fails, and no temp file behind', async () => {
    const uploads = folder({ 'konumlu.jpg': JPEG_WITH_GPS });
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    expect(await scrubUploadDir(uploads)).toEqual({ checked: 1, cleaned: 0, failed: 1 });
    expect(read('konumlu.jpg')).toEqual(JPEG_WITH_GPS);
    expect(fs.readdirSync(uploads)).toEqual(['konumlu.jpg']);

    // and the next start does it
    expect(await scrubUploadDir(uploads)).toEqual({ checked: 1, cleaned: 1, failed: 0 });
    expect(read('konumlu.jpg')).toEqual(JPEG_1X1);
  });

  it('has nothing to do in a folder that does not exist yet', async () => {
    expect(await scrubUploadDir(path.join(os.tmpdir(), 'koydum-yok', 'uploads'))).toEqual({ checked: 0, cleaned: 0, failed: 0 });
  });
});
