/**
 * Proof photos on their way to the disk: only real images, and nothing the phone
 * wrote about where and when they were taken.
 *
 * An Android camera shot keeps its GPS: expo-image-picker re-encodes the photo and
 * then copies the EXIF over, location included, into a file the camera wrote for
 * the app, where Android's own location redaction never applies. A çelınc's
 * players are friends of its creator, not always of each other, and anybody with
 * the URL can open a photo: a "water glass at home" proof would hand a
 * friend-of-a-friend the kitchen's coordinates. The APKs already on phones keep
 * sending such files, so the server strips them.
 *
 * It walks the container by hand, with no image library: the pixels are never
 * decoded or re-encoded, only the metadata blocks around them are left out. When
 * a JPEG or WebP does not read the way its format says, the answer is null and
 * the upload is refused; a photo stored half-understood could be a broken one, or
 * one that still says where somebody lives. (A PNG cut short goes as it came: past
 * the cut there is no chunk left to drop.)
 */
import fs from 'node:fs';
import path from 'node:path';

export type ImageKind = 'jpg' | 'png' | 'webp';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the bytes are, whatever the client declared. */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * The same image without its EXIF/GPS, XMP, IPTC and text blocks, or null when
 * the file is broken in a way that makes "the same image" a guess.
 */
export function stripMetadata(buf: Buffer, kind: ImageKind): Buffer | null {
  if (kind === 'jpg') return stripJpeg(buf);
  if (kind === 'png') return stripPng(buf);
  return stripWebp(buf);
}

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
/** APP1 (Exif, where the GPS is, and XMP), APP13 (Photoshop's IPTC) and COM. */
const JPEG_DROPPED = new Set([0xe1, 0xed, 0xfe]);

/**
 * Segments up to the first scan are copied one by one, the dropped ones left out;
 * APP0, the ICC profile in APP2, Adobe's APP14 and every table stay. From SOS on
 * the file is copied as it is: the scan data is the picture, and nothing in it
 * is metadata.
 */
function stripJpeg(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== JPEG_SOI) return null;
  const kept: Buffer[] = [buf.subarray(0, 2)];
  let at = 2;
  while (at < buf.length) {
    if (buf[at] !== 0xff) return null;
    // a marker may be preceded by any number of 0xFF fill bytes; they go along with it
    let code = at + 1;
    while (code < buf.length && buf[code] === 0xff) code += 1;
    if (code >= buf.length) return null;
    const marker = buf[code];
    if (marker === JPEG_SOS) {
      kept.push(buf.subarray(at));
      return Buffer.concat(kept);
    }
    // RST0-7 and TEM stand alone, without a length
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.push(buf.subarray(at, code + 1));
      at = code + 1;
      continue;
    }
    // an end, a second start or a stuffed byte before any scan: no picture to keep
    if (marker === JPEG_EOI || marker === JPEG_SOI || marker === 0x00) return null;
    if (code + 3 > buf.length) return null;
    const end = code + 1 + buf.readUInt16BE(code + 1);
    if (end < code + 3 || end > buf.length) return null;
    if (!JPEG_DROPPED.has(marker)) kept.push(buf.subarray(at, end));
    at = end;
  }
  return null;
}

/** eXIf is EXIF itself; the text chunks hold whatever an app wrote, GPS included; tIME is when. */
const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/**
 * Whole chunks are copied or left out, so every kept chunk keeps its own CRC.
 * A chunk whose length runs past the end goes out with the rest of the file as
 * it came: there is no chunk after it to drop, and the bytes stay the client's.
 */
function stripPng(buf: Buffer): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const kept: Buffer[] = [buf.subarray(0, 8)];
  let at = 8;
  while (at + 8 <= buf.length) {
    const end = at + 12 + buf.readUInt32BE(at);
    if (end > buf.length) break;
    const type = buf.toString('latin1', at + 4, at + 8);
    if (!PNG_DROPPED.has(type)) kept.push(buf.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  kept.push(buf.subarray(at));
  return Buffer.concat(kept);
}

/** VP8X's flags for "there is an EXIF chunk" and "there is an XMP chunk". */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/**
 * A RIFF file: 'RIFF', the size of what follows, 'WEBP', then chunks padded to
 * an even length. EXIF and XMP chunks are left out, VP8X stops announcing them,
 * and the RIFF size is written for what is left. Anything past the RIFF's own
 * end is not part of the image and is not kept.
 */
function stripWebp(buf: Buffer): Buffer | null {
  if (sniffImage(buf) !== 'webp') return null;
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd < 12 || riffEnd > buf.length) return null;
  const kept: Buffer[] = [];
  let at = 12;
  while (at < riffEnd) {
    if (at + 8 > riffEnd) return null;
    const fourcc = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    if (end > riffEnd) return null;
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      let chunk = buf.subarray(at, end);
      if (fourcc === 'VP8X') {
        if (size < 10) return null;
        chunk = Buffer.from(chunk);
        chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      }
      kept.push(chunk);
    }
    at = end;
  }
  const header = Buffer.from(buf.subarray(0, 12));
  const body = Buffer.concat(kept);
  header.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([header, body]);
}

export interface ScrubResult {
  /** image files looked at */
  checked: number;
  /** files that carried metadata and were rewritten without it */
  cleaned: number;
  /** files that could not be read or rewritten; left as they were, tried again at the next start */
  failed: number;
}

const SCRUBBED = /\.(jpe?g|png|webp)$/i;

/**
 * A phone's JPEG has every block before its first scan in the first few KB. The
 * pass runs at every start, so a clean JPEG costs this much reading, not the
 * whole photo.
 */
const JPEG_HEAD_BYTES = 64 * 1024;

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(head, 0, bytes, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * One pass over the uploads folder for the photos stored before the server
 * stripped them. Each one is rewritten only when stripping changed it, and only
 * through a temp file renamed over it, so a crash or a full disk leaves either
 * the old file or the clean one, never half of one. The temp name carries the
 * pid: a second server started by mistake in the same folder never writes into
 * this one's temp file. A file that is not an image, or not one the walker
 * understands, is left exactly as it is: nothing here ever deletes a photo.
 */
export async function scrubUploadDir(dir: string): Promise<ScrubResult> {
  const result: ScrubResult = { checked: 0, cleaned: 0, failed: 0 };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    // no photo was ever uploaded, or no folder to hold one (app.ts already said so)
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return result;
    throw err;
  }
  for (const name of names) {
    if (!SCRUBBED.test(name)) continue;
    const file = path.join(dir, name);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      if (!(await fs.promises.lstat(file)).isFile()) continue;
      result.checked += 1;
      const head = await readHead(file, JPEG_HEAD_BYTES);
      const kind = sniffImage(head);
      if (!kind) continue;
      // From a JPEG's first scan on the walker copies everything as it is, so a
      // head that holds that scan and nothing to drop stands for the whole file.
      // A PNG or WebP may carry its text after the pixels: those are read whole.
      const whole = head.length < JPEG_HEAD_BYTES;
      if (kind === 'jpg' && !whole && stripMetadata(head, kind)?.equals(head)) continue;
      const original = whole ? head : await fs.promises.readFile(file);
      const clean = stripMetadata(original, kind);
      if (!clean || clean.equals(original)) continue;
      await fs.promises.writeFile(temp, clean, { flush: true });
      await fs.promises.rename(temp, file);
      result.cleaned += 1;
    } catch {
      result.failed += 1;
      // only ever our own temp file; the photo itself was not touched
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return result;
}
