/**
 * POST /uploads — proof photos (SPEC 2.2).
 *
 * One multipart file per request, images only, at most `LIMITS.UPLOAD_MAX_BYTES`
 * (enforced by @fastify/multipart in src/app.ts, which throws
 * `FST_REQ_FILE_TOO_LARGE` → 413 `file_too_large`). The stored name is random and the
 * extension comes from the declared mimetype, never from the client's filename, so a
 * "photo.php" cannot become a file with that name on disk. The declared mimetype is
 * not trusted for the content: the bytes must be a JPG, PNG or WEBP, and what is
 * stored is them without EXIF/GPS and the other metadata blocks (services/images.ts),
 * stripped by what they really are. The response URL is the path under the static
 * `/uploads/` mount, relative to the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { badRequest, tooMany } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { sniffImage, stripMetadata } from '../services/images.js';
import { AttemptLimiter } from '../services/throttle.js';

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
 * scheduler's daily sweep in services/photos.ts).
 */
export const UPLOADS_PER_USER = { max: 60, windowMs: 60 * 60 * 1000 } as const;

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const uploadDir = path.resolve(app.config.uploadDir);
  const perUser = new AttemptLimiter(UPLOADS_PER_USER.max, UPLOADS_PER_USER.windowMs);

  app.post('/uploads', { preHandler: app.authenticate }, async (request, reply) => {
    const { row } = requireUser(request);
    const now = app.now();
    const wait = perUser.retryAfterMs(row.id, now);
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60_000));
      throw tooMany('upload_limit', `Bu saatlik fotoğraf hakkın doldu. ${minutes} dakika sonra tekrar dene.`);
    }

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

    const filename = `${randomUUID()}.${extension}`;
    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(path.join(uploadDir, filename), clean);
    perUser.record(row.id, now);

    // Relative on purpose: the phones resolve it against the address THEY use
    // for this server. An absolute URL built from PUBLIC_URL's default
    // (localhost) pointed every phone at itself, and the photo never loaded.
    return reply.code(201).send({ url: `/uploads/${filename}` });
  });
}
