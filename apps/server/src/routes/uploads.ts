/**
 * POST /uploads — proof photos (SPEC 2.2).
 *
 * One multipart file per request, images only, at most `LIMITS.UPLOAD_MAX_BYTES`
 * (enforced by @fastify/multipart in src/app.ts, which throws
 * `FST_REQ_FILE_TOO_LARGE` → 413 `file_too_large`). The stored name is random and the
 * extension comes from the declared mimetype, never from the client's filename, so a
 * "photo.php" cannot become a file with that name on disk. The declared mimetype is
 * not trusted for the content: the bytes must start like a JPG, PNG or WEBP (the
 * header is sniffed, the picture behind it is never decoded), and what is stored is
 * them without EXIF/GPS and the other metadata blocks (services/images.ts),
 * stripped by what they really are. The response URL is the path under the static
 * `/uploads/` mount, relative to the server.
 *
 * The photos share a disk with the database, the step syncs and the daily backup,
 * and anybody who reaches the server can open accounts: two fresh ones from one
 * address stored 600 MB in 3.3 s, and once the disk was full every friend's step
 * sync failed with 500. So an hour's photos are capped per account AND per client,
 * a day's for the whole server, and nothing is stored while the disk is nearly
 * full (507 `disk_full`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError, badRequest, tooMany } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { sniffImage, stripMetadata } from '../services/images.js';
import { AttemptLimiter, clientKey, retryAfterText } from '../services/throttle.js';

/** Accepted image mimetypes → the extension we store them under. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Per-account ceiling on uploads. Nothing in the game needs more than a handful
 * of proof photos an hour; without a cap one account could fill the data volume
 * with a loop (a photo no entry shows is deleted only after a week, by the
 * scheduler's daily sweep in services/photos.ts). The same ceiling holds per
 * client (`clientKey`: an IPv4 address or an IPv6 /64), since a second account
 * is one registration away.
 */
export const UPLOADS_PER_USER = { max: 60, windowMs: 60 * 60 * 1000 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The day's bytes are kept a minute at a time, so a flood of tiny files cannot grow the list past 1,440. */
const SLOT_MS = 60 * 1000;
/** The owner's window hears about a full disk or a spent day once an hour, not once a photo. */
const OWNER_WARN_EVERY_MS = 60 * 60 * 1000;

/**
 * Free bytes for us on the disk under `dir`, or null when the system will not
 * say (the check is then skipped, never a reason to refuse).
 */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    // a folder deleted while the server runs is made again, so its disk can be asked
    await fs.promises.mkdir(dir, { recursive: true });
    const stats = await fs.promises.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const uploadDir = path.resolve(app.config.uploadDir);
  const perUser = new AttemptLimiter(UPLOADS_PER_USER.max, UPLOADS_PER_USER.windowMs);
  const perClient = new AttemptLimiter(UPLOADS_PER_USER.max, UPLOADS_PER_USER.windowMs);

  // Bytes stored over the last day, oldest first. The per-account and per-client
  // caps add up across accounts and addresses (a rented /48 holds 65,536 /64s);
  // this is the one that does not.
  const stored: { at: number; bytes: number }[] = [];
  const storedToday = (at: number): number => {
    while (stored.length > 0 && at - (stored[0]?.at ?? at) >= DAY_MS) stored.shift();
    return stored.reduce((sum, slot) => sum + slot.bytes, 0);
  };
  /** How long until `bytes` more fit in the day; 0 when they fit now. */
  const budgetWaitMs = (bytes: number, at: number): number => {
    let over = storedToday(at) + bytes - app.config.uploadDailyBudgetBytes;
    if (over <= 0) return 0;
    for (const slot of stored) {
      over -= slot.bytes;
      if (over <= 0) return Math.max(1, slot.at + DAY_MS - at);
    }
    return DAY_MS;
  };
  /** Counts `bytes` before the write, so photos written side by side cannot all slip under the budget. */
  const reserve = (bytes: number, at: number): { bytes: number } => {
    const last = stored[stored.length - 1];
    if (last && at - last.at < SLOT_MS) {
      last.bytes += bytes;
      return last;
    }
    const slot = { at, bytes };
    stored.push(slot);
    return slot;
  };

  let diskWarnedAt = Number.NEGATIVE_INFINITY;
  let budgetWarnedAt = Number.NEGATIVE_INFINITY;

  /** The 507 a friend reads; the owner reads why in the server window. */
  const diskFull = (at: number, fields: Record<string, unknown>): HttpError => {
    if (at - diskWarnedAt >= OWNER_WARN_EVERY_MS) {
      diskWarnedAt = at;
      app.log.warn({ ...fields, uploadDir }, 'disk almost full, uploads refused');
    }
    return new HttpError(
      507,
      'disk_full',
      'Sunucunun diski dolmak üzere, şimdilik fotoğraf alınmıyor. Sunucuyu açan kankana haber ver.',
    );
  };

  app.post('/uploads', { preHandler: app.authenticate }, async (request, reply) => {
    const { row } = requireUser(request);
    const now = app.now();
    const at = now.getTime();
    const client = clientKey(request.ip);
    const wait = perUser.retryAfterMs(row.id, now);
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60_000));
      throw tooMany('upload_limit', `Bu saatlik fotoğraf hakkın doldu. ${minutes} dakika sonra tekrar dene.`);
    }
    // not "your" photos: somebody else on the same Wi-Fi may have sent them
    const clientWait = perClient.retryAfterMs(client, now);
    if (clientWait > 0) {
      throw tooMany('upload_limit', `Bu ağdan bir saatte çok fazla fotoğraf yüklendi. ${retryAfterText(clientWait)}`);
    }

    // Counted before the first await: the checks above and these two lines run
    // in one go, so a burst sent side by side cannot all pass them while the
    // first bodies are still coming in (150 at once all got 201 against the 60).
    // Given back below when nothing is stored: a refused photo costs no hour.
    perUser.record(row.id, now);
    perClient.record(client, now);
    let filename: string;
    try {
      if (!request.isMultipart()) {
        throw badRequest('invalid_multipart', 'Dosya yüklemek için multipart form gerekli.');
      }

      const part = await request.file();
      if (!part) throw badRequest('file_required', 'Bir dosya seçmelisin.');

      const mimetype = part.mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
      const extension = EXTENSIONS[mimetype];
      if (!extension) {
        // Drain the stream so the connection is not left hanging on a rejected file.
        part.file.resume();
        throw badRequest('invalid_file_type', 'Sadece JPG, PNG ya da WEBP fotoğraf yükleyebilirsin.');
      }

      // Before the body is read. What is left on a nearly full disk belongs to the
      // database: a step sync on a full one fails with "database or disk is full".
      const free = await freeBytes(uploadDir);
      if (free !== null && free < app.config.uploadMinFreeBytes) {
        part.file.resume();
        throw diskFull(at, { freeMb: Math.floor(free / (1024 * 1024)) });
      }

      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        throw badRequest('file_too_large', 'Dosya çok büyük (en fazla 5 MB).');
      }
      if (buffer.length === 0) throw badRequest('file_required', 'Boş dosya gönderdin.');

      // the APKs on phones send camera shots with their GPS in them: the metadata goes, the picture stays
      const kind = sniffImage(buffer);
      if (!kind) throw badRequest('invalid_file_type', 'Sadece JPG, PNG ya da WEBP fotoğraf yükleyebilirsin.');
      const clean = stripMetadata(buffer, kind);
      if (!clean) throw badRequest('invalid_file_type', 'Bu fotoğraf bozuk görünüyor, başka bir tane seç.');

      const budgetWait = budgetWaitMs(clean.length, at);
      if (budgetWait > 0) {
        if (at - budgetWarnedAt >= OWNER_WARN_EVERY_MS) {
          budgetWarnedAt = at;
          app.log.warn({ mb: Math.round(storedToday(at) / (1024 * 1024)) }, 'daily upload budget used up');
        }
        throw tooMany('upload_limit', `Sunucu bugün çok fazla fotoğraf aldı. ${retryAfterText(budgetWait)}`);
      }

      filename = `${randomUUID()}.${extension}`;
      const target = path.join(uploadDir, filename);
      const slot = reserve(clean.length, at);
      try {
        await fs.promises.mkdir(uploadDir, { recursive: true });
        await fs.promises.writeFile(target, clean);
      } catch (err) {
        slot.bytes -= clean.length;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC' || code === 'EDQUOT') {
          // writeFile leaves behind whatever it got down before the disk ran out
          await fs.promises.unlink(target).catch(() => undefined);
          throw diskFull(at, { err });
        }
        throw err;
      }
    } catch (err) {
      perUser.unrecord(row.id, now);
      perClient.unrecord(client, now);
      throw err;
    }

    // Relative on purpose: the phones resolve it against the address THEY use
    // for this server. An absolute URL built from PUBLIC_URL's default
    // (localhost) pointed every phone at itself, and the photo never loaded.
    return reply.code(201).send({ url: `/uploads/${filename}` });
  });
}
