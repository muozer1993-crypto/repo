/**
 * The address a link handed to somebody else should use.
 *
 * With PUBLIC_URL set, that is the answer. Without it the configured value is
 * `http://localhost:4000`, which is only true on the server machine itself — a
 * friend's phone reaches it as `http://192.168.1.142:4000` or through a tunnel.
 * The request knows which address it came in on, so it is used instead.
 *
 * The Host and X-Forwarded-Proto headers are chosen by the requester, which is
 * fine here: the result only ever lands in a page or payload sent back to that
 * same requester. It is still validated, because it is written into HTML.
 */
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

const HOST_RE = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** A PUBLIC_URL of localhost (the old .env.example value) names no public address at all. */
export const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;

export function publicOrigin(request: FastifyRequest, config: Pick<Config, 'publicUrl' | 'publicUrlExplicit'>): string {
  if (config.publicUrlExplicit && !LOOPBACK_URL.test(config.publicUrl)) return config.publicUrl;
  const host = String(request.headers.host ?? '').trim();
  if (!HOST_RE.test(host)) return config.publicUrl;
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : request.protocol === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}
