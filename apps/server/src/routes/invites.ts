/**
 * Invite links — how a friend who does not have the app yet gets into a game.
 *
 *   GET /davet/:code    the page a shared link opens: who invites you, a button
 *                       that opens KOYDUM (Android intent with a download
 *                       fallback), the APK when this server hosts one
 *   GET /indir          the same page without an inviter
 *   GET /invites/:code  JSON for the app: who owns this code (public fields)
 *   GET /koydum.apk     the published Android build, when there is one
 *
 * The open button carries this server's address (`server=`) so the app can
 * point itself at it — the friend never types an IP. The app asks before it
 * switches servers; see apps/mobile/src/app/davet/[code].tsx.
 *
 * Lookups are rate-limited per IP: a code is only six characters and the page
 * answers with a display name, so it must not be an enumeration oracle.
 */
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserRow } from '../db/index.js';
import { notFound, tooMany } from '../errors.js';
import { apkPath, currentRelease, type AppRelease } from '../services/appRelease.js';
import { publicOrigin } from '../services/origin.js';
import { AttemptLimiter } from '../services/throttle.js';

export const INVITE_LOOKUPS_PER_IP = { max: 120, windowMs: 10 * 60 * 1000 } as const;

const CODE_RE = /^[A-Za-z0-9]{4,12}$/;
const ANDROID_PACKAGE = 'com.koydum.app';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace('.', ',')} MB`;
}

interface PageInput {
  origin: string;
  code: string | null;
  inviter: Pick<UserRow, 'display_name' | 'avatar_emoji' | 'username'> | null;
  release: AppRelease | null;
  android: boolean;
  unknownCode: boolean;
}

/** Deep link into the app; on Android an intent URL so a missing app falls back to /indir. */
function openHref(input: PageInput): string {
  const path = input.code ? `davet/${encodeURIComponent(input.code.toUpperCase())}` : 'davet';
  const query = `server=${encodeURIComponent(input.origin)}`;
  if (!input.android) return `koydum://${path}?${query}`;
  const fallback = `${input.origin}/indir${input.code ? `?kod=${encodeURIComponent(input.code.toUpperCase())}` : ''}`;
  return `intent://${path}?${query}#Intent;scheme=koydum;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

function renderPage(input: PageInput): string {
  const name = input.inviter ? input.inviter.display_name : null;
  const title = input.unknownCode
    ? 'Bu davet bulunamadı'
    : name
      ? `${name} seni KOYDUM'a çağırıyor`
      : "KOYDUM'u indir";
  const lead = input.unknownCode
    ? 'Kod yanlış yazılmış ya da hesap silinmiş olabilir. Uygulamayı yine de indirip arkadaşını kullanıcı adıyla ekleyebilirsin.'
    : name
      ? 'Kanka olun, çelınc açın. Kim daha çok yürüdü, kim telefonu bıraktı, kim erken kalktı: kazanan koyar, kaybeden yer.'
      : 'Arkadaşlar arası çelınc uygulaması. Kazanan koyar, kaybeden yer.';
  const code = input.code ? input.code.toUpperCase() : null;
  const host = input.origin.replace(/^https?:\/\//, '');
  const release = input.release;
  const version = release?.version ? ` · sürüm ${release.version}` : '';
  const size = release?.size ? ` · ${formatSize(release.size)}` : '';
  const emoji = input.inviter?.avatar_emoji || '🍆';

  const download = release
    ? `<a class="btn secondary" href="${escapeHtml(release.downloadUrl)}">Uygulamayı indir (Android)${escapeHtml(version + size)}</a>`
    : `<p class="note">Uygulama sende yoksa seni davet edene yaz, APK'yı o göndersin.</p>`;

  const steps = code
    ? `<ol class="steps">
        <li>Uygulama telefonunda yoksa önce indirip kur. Android "bilinmeyen kaynak" diye sorarsa bir kere izin ver.</li>
        <li>Bu sayfaya geri dön, <b>KOYDUM'da aç</b>'a dokun.</li>
        <li>Kayıt ol. Kanka isteğin kendiliğinden gider.</li>
      </ol>`
    : `<ol class="steps">
        <li>Uygulamayı indirip kur. Android "bilinmeyen kaynak" diye sorarsa bir kere izin ver.</li>
        <li>Seni davet eden kişinin bağlantısına tekrar dokun ya da uygulamada kodunu yaz.</li>
      </ol>`;

  const open = input.unknownCode
    ? ''
    : `<a class="btn primary" href="${escapeHtml(openHref(input))}">KOYDUM'da aç</a>`;

  const manual = code
    ? `<div class="manual">
        <div><span>Sunucu</span><b>${escapeHtml(host)}</b></div>
        <div><span>Davet kodu</span><b class="code">${escapeHtml(code)}</b></div>
      </div>
      <p class="note">Düğme çalışmazsa uygulamada sunucu adresini ve kodu elle yazabilirsin.</p>`
    : '';

  const description = code && name ? `Davet kodu ${code}. Kanka olun, çelınc açın.` : 'Kazanan koyar, kaybeden yer.';

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#0B0B0F">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0B0B0F; color: #F5F5F7;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center; padding: 32px 18px; }
  main { width: 100%; max-width: 440px; display: flex; flex-direction: column; gap: 18px; }
  .brand { font-weight: 900; letter-spacing: 2px; color: #FF3D71; font-size: 14px; }
  .avatar { font-size: 64px; line-height: 1; }
  h1 { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 900; }
  p { margin: 0; color: #9A9AA5; }
  .btn { display: block; text-align: center; text-decoration: none; font-weight: 800;
    padding: 16px 18px; border-radius: 14px; font-size: 17px; }
  .primary { background: #FF3D71; color: #0B0B0F; }
  .secondary { background: #16161D; color: #F5F5F7; border: 1px solid #2A2A33; }
  .steps { margin: 0; padding: 16px 16px 16px 34px; background: #16161D; border-radius: 14px; color: #C9C9D1; }
  .steps li + li { margin-top: 8px; }
  .manual { display: flex; gap: 10px; }
  .manual div { flex: 1; background: #16161D; border-radius: 12px; padding: 10px 12px; min-width: 0; }
  .manual span { display: block; font-size: 12px; color: #9A9AA5; }
  .manual b { display: block; overflow-wrap: anywhere; }
  .code { color: #FFD400; letter-spacing: 3px; font-size: 20px; }
  .note { font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="brand">KOYDUM</div>
  <div class="avatar">${escapeHtml(emoji)}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(lead)}</p>
  ${open}
  ${download}
  ${steps}
  ${manual}
  <p class="note">iPhone sürümü şimdilik yok, KOYDUM'u Android telefona kurabilirsin.</p>
</main>
</body>
</html>`;
}

function isAndroid(request: FastifyRequest): boolean {
  return /android/i.test(String(request.headers['user-agent'] ?? ''));
}

export default async function inviteRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app;
  const lookups = new AttemptLimiter(INVITE_LOOKUPS_PER_IP.max, INVITE_LOOKUPS_PER_IP.windowMs);

  const throttle = (request: FastifyRequest): void => {
    const now = app.now();
    const wait = lookups.retryAfterMs(request.ip, now);
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60_000));
      throw tooMany('too_many_lookups', `Çok fazla davet denedin. ${minutes} dakika sonra tekrar dene.`);
    }
    lookups.record(request.ip, now);
  };

  const findInviter = (code: string): UserRow | undefined => {
    if (!CODE_RE.test(code)) return undefined;
    return db
      .prepare('SELECT * FROM users WHERE upper(invite_code) = ? AND deleted_at IS NULL')
      .get(code.trim().toUpperCase()) as UserRow | undefined;
  };

  const sendPage = (reply: FastifyReply, status: number, html: string): FastifyReply =>
    reply
      .code(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      // nothing on the page runs code or loads anything from elsewhere
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'")
      .send(html);

  app.get<{ Params: { code: string } }>('/invites/:code', async (request) => {
    throttle(request);
    const inviter = findInviter(request.params.code);
    if (!inviter) throw notFound('invite_not_found', 'Bu davet kodu geçersiz.');
    return {
      code: inviter.invite_code.toUpperCase(),
      inviter: { username: inviter.username, displayName: inviter.display_name, avatarEmoji: inviter.avatar_emoji },
    };
  });

  app.get<{ Params: { code: string } }>('/davet/:code', async (request, reply) => {
    throttle(request);
    const origin = publicOrigin(request, config);
    const inviter = findInviter(request.params.code);
    const release = currentRelease(config, origin);
    const code = inviter ? inviter.invite_code : null;
    return sendPage(
      reply,
      inviter ? 200 : 404,
      renderPage({ origin, code, inviter: inviter ?? null, release, android: isAndroid(request), unknownCode: !inviter }),
    );
  });

  app.get<{ Querystring: { kod?: string } }>('/indir', async (request, reply) => {
    const origin = publicOrigin(request, config);
    const raw = typeof request.query.kod === 'string' ? request.query.kod : '';
    // the code is only echoed back as a link, never looked up here
    const code = CODE_RE.test(raw) ? raw.toUpperCase() : null;
    return sendPage(
      reply,
      200,
      renderPage({ origin, code, inviter: null, release: currentRelease(config, origin), android: isAndroid(request), unknownCode: false }),
    );
  });

  // browsers ask every page's host for one; the invite page lives here now
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).header('cache-control', 'max-age=86400').send());

  app.get('/koydum.apk', async (request, reply) => {
    const file = apkPath(config);
    let size: number;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) throw new Error('empty');
      size = stat.size;
    } catch {
      throw notFound('apk_not_found', 'Bu sunucuda yüklenmiş bir uygulama yok.');
    }
    const release = currentRelease(config, publicOrigin(request, config));
    const name = release?.version ? `koydum-${release.version}.apk` : 'koydum.apk';
    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-length', String(size))
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-cache')
      .send(fs.createReadStream(file));
  });
}
