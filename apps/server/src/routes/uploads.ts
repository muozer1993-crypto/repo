/**
 * POST /uploads — proof photos (SPEC 2.2).
 *
 * One multipart file per request, images only, at most `LIMITS.UPLOAD_MAX_BYTES`
 * (enforced by @fastify/multipart in src/app.ts, which throws
 * `FST_REQ_FILE_TOO_LARGE` → 413 `file_too_large`). The stored name is random and the
 * extension comes from the declared mimetype, never from the client's filename, so a
 * "photo.php" cannot become a file with that name on disk. The response URL points at
 * the static `/uploads/` mount.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors.js';
import { requireUser } from '../plugins/auth.js';

/** Accepted image mimetypes → the extension we store them under. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const uploadDir = path.resolve(app.config.uploadDir);

  app.post('/uploads', { preHandler: app.authenticate }, async (request, reply) => {
    requireUser(request);

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

    const filename = `${randomUUID()}.${extension}`;
    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(path.join(uploadDir, filename), buffer);

    return reply.code(201).send({ url: `${app.config.publicUrl}/uploads/${filename}` });
  });
}
