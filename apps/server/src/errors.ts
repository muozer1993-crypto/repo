/**
 * API errors.
 *
 * Every failure the client can see is rendered as `{ error: { code, message, issues? } }`
 * with a Turkish `message` and a stable English `code` the app switches on.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues?: unknown;

  constructor(status: number, code: string, message: string, issues?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (issues !== undefined) this.issues = issues;
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError || (err instanceof Error && err.name === 'HttpError' && 'code' in err && 'status' in err);
}

/**
 * Error factories. They RETURN the error, so call sites read `throw badRequest(...)`.
 * The message is Turkish and user facing; the code is the machine contract.
 */
export const badRequest = (code = 'bad_request', message = 'İstek geçersiz.', issues?: unknown): HttpError =>
  new HttpError(400, code, message, issues);

export const unauthorized = (code = 'unauthorized', message = 'Giriş yapman gerekiyor.'): HttpError =>
  new HttpError(401, code, message);

export const forbidden = (code = 'forbidden', message = 'Bunu yapma yetkin yok.'): HttpError => new HttpError(403, code, message);

export const notFound = (code = 'not_found', message = 'Bulunamadı.'): HttpError => new HttpError(404, code, message);

export const conflict = (code = 'conflict', message = 'Bu işlem zaten yapılmış.'): HttpError => new HttpError(409, code, message);

export const tooMany = (code = 'too_many_requests', message = 'Çok hızlısın, biraz bekle.'): HttpError =>
  new HttpError(429, code, message);

// ---------------------------------------------------------------------------
// zod
// ---------------------------------------------------------------------------

interface ZodLikeError extends Error {
  issues: unknown[];
}

/** Duck typed so a second zod copy in the tree cannot break `instanceof`. */
export function isZodError(err: unknown): err is ZodLikeError {
  return err instanceof Error && err.name === 'ZodError' && Array.isArray((err as { issues?: unknown }).issues);
}

/**
 * Parses a request body with a zod schema, letting the ZodError bubble up to the
 * error handler (which renders 400 `validation` with the issue list).
 *
 * Structurally typed on `parse` so both call styles work:
 *   `parseBody(RegisterBodySchema, request.body)`            // inferred
 *   `parseBody<RegisterBody>(RegisterBodySchema, request.body)` // explicit
 */
export function parseBody<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

/** Same as `parseBody` for query strings (kept separate for readable call sites). */
export function parseQuery<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

// ---------------------------------------------------------------------------
// Fastify error handler
// ---------------------------------------------------------------------------

export interface ErrorBody {
  error: { code: string; message: string; issues?: unknown };
}

const FASTIFY_MESSAGES: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'empty_body', message: 'İstek gövdesi boş.' },
  FST_ERR_CTP_INVALID_JSON: { status: 400, code: 'invalid_json', message: 'Geçersiz JSON gönderdin.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'invalid_media_type', message: 'Bu içerik tipi desteklenmiyor.' },
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'body_too_large', message: 'Gönderdiğin veri çok büyük.' },
  FST_REQ_FILE_TOO_LARGE: { status: 413, code: 'file_too_large', message: 'Dosya çok büyük (en fazla 5 MB).' },
  FST_PARTS_LIMIT: { status: 400, code: 'too_many_parts', message: 'Çok fazla dosya gönderdin.' },
  FST_INVALID_MULTIPART_CONTENT_TYPE: { status: 400, code: 'invalid_multipart', message: 'Dosya yüklemek için multipart form gerekli.' },
};

/** `app.setErrorHandler(errorHandler)` — the single renderer for every failure. */
export function errorHandler(error: Error, request: FastifyRequest, reply: FastifyReply): void {
  if (isZodError(error)) {
    const body: ErrorBody = {
      error: { code: 'validation', message: 'Gönderdiğin bilgiler geçersiz.', issues: error.issues },
    };
    void reply.code(400).send(body);
    return;
  }

  if (isHttpError(error)) {
    const body: ErrorBody = { error: { code: error.code, message: error.message } };
    if (error.issues !== undefined) body.error.issues = error.issues;
    void reply.code(error.status).send(body);
    return;
  }

  const fastifyCode = (error as { code?: string }).code;
  const known = fastifyCode ? FASTIFY_MESSAGES[fastifyCode] : undefined;
  if (known) {
    void reply.code(known.status).send({ error: { code: known.code, message: known.message } } satisfies ErrorBody);
    return;
  }

  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    void reply
      .code(statusCode)
      .send({ error: { code: fastifyCode ?? 'bad_request', message: 'İstek işlenemedi.' } } satisfies ErrorBody);
    return;
  }

  request.log.error({ err: error }, 'unhandled error');
  void reply
    .code(500)
    .send({ error: { code: 'internal', message: 'Sunucuda bir şeyler ters gitti. Birazdan tekrar dene.' } } satisfies ErrorBody);
}

/** `app.setNotFoundHandler(notFoundHandler)`. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send({ error: { code: 'not_found', message: 'Böyle bir uç yok.' } } satisfies ErrorBody);
}
