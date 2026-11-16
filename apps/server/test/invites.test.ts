/**
 * Invite links: the page a shared link opens, the JSON the app reads, the APK
 * download and the "latest version" the app compares itself against.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JPEG_WITH_GPS, makeApp, multipart, registerUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;
const dirs: string[] = [];

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempAppDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koydum-appdir-'));
  dirs.push(dir);
  return dir;
}

function publish(appDir: string, version: string | null, bytes = 2048): void {
  fs.writeFileSync(path.join(appDir, 'koydum.apk'), Buffer.concat([Buffer.from('PK'), Buffer.alloc(bytes - 2, 7)]));
  if (version) fs.writeFileSync(path.join(appDir, 'latest.json'), JSON.stringify({ version, notes: 'Ekran süresi geldi' }));
}

async function appWith(appDir: string, extra: Record<string, unknown> = {}): Promise<TestApp> {
  // publicUrl left unset on purpose: the phone-facing links must come from the request
  return makeApp({ config: { appDir, publicUrl: undefined, publicUrlExplicit: false, ...extra } });
}

describe('GET /davet/:code', () => {
  it('names the inviter, opens the app with this server, and offers the hosted APK', async () => {
    const appDir = tempAppDir();
    publish(appDir, '1.1.0');
    harness = await appWith(appDir);
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali <b>' });

    const page = await harness.app.inject({
      method: 'GET',
      url: `/davet/${ali.me.inviteCode.toLowerCase()}`,
      headers: { host: '192.168.1.142:4000', 'user-agent': 'Mozilla/5.0 (Linux; Android 14)' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const html = page.body;
    // escaped, never raw
    expect(html).toContain('Ali &lt;b&gt; seni KOYDUM&#39;a çağırıyor');
    expect(html).not.toContain('Ali <b>');
    // WhatsApp preview
    expect(html).toContain('property="og:title"');
    // Android gets an intent URL with a download fallback and this server's address
    expect(html).toContain(`intent://davet/${ali.me.inviteCode}?server=${encodeURIComponent('http://192.168.1.142:4000')}`);
    expect(html).toContain('package=com.koydum.app');
    expect(html).toContain(encodeURIComponent(`http://192.168.1.142:4000/indir?kod=${ali.me.inviteCode}`));
    // the APK is on this server
    expect(html).toContain('http://192.168.1.142:4000/koydum.apk');
    expect(html).toContain('sürüm 1.1.0');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('gives other browsers a plain koydum:// link and uses PUBLIC_URL when it is set', async () => {
    const appDir = tempAppDir();
    harness = await makeApp({ config: { appDir, publicUrl: 'https://koydum.example.com' } });
    const ali = await registerUser(harness.app, 'ali');
    const page = await harness.app.inject({
      method: 'GET',
      url: `/davet/${ali.me.inviteCode}`,
      headers: { host: 'evil.example', 'user-agent': 'Mozilla/5.0 (iPhone)' },
    });
    expect(page.body).toContain(`koydum://davet/${ali.me.inviteCode}?server=${encodeURIComponent('https://koydum.example.com')}`);
    expect(page.body).not.toContain('evil.example');
    // nothing published: say whom to ask instead of a dead button
    expect(page.body).toContain("APK'yı o göndersin");
  });

  it('answers an unknown code with a 404 page that still leads to the download', async () => {
    const appDir = tempAppDir();
    publish(appDir, '1.1.0');
    harness = await appWith(appDir);
    const page = await harness.app.inject({ method: 'GET', url: '/davet/ZZZZZZ', headers: { host: 'x.test' } });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('Bu davet bulunamadı');
    expect(page.body).toContain('http://x.test/koydum.apk');
    expect(page.body).not.toContain("KOYDUM'da aç");
  });

  it('builds links from a forwarded https origin behind a tunnel, and ignores a garbage Host', async () => {
    harness = await appWith(tempAppDir());
    const ali = await registerUser(harness.app, 'ali');
    const tunneled = await harness.app.inject({
      method: 'GET',
      url: `/davet/${ali.me.inviteCode}`,
      headers: { host: 'abc.trycloudflare.com', 'x-forwarded-proto': 'https' },
    });
    expect(tunneled.body).toContain(encodeURIComponent('https://abc.trycloudflare.com'));

    const hostile = await harness.app.inject({
      method: 'GET',
      url: `/davet/${ali.me.inviteCode}`,
      headers: { host: 'a"><script>x</script>' },
    });
    // the page's own copy script is there; the Host's never is
    expect(hostile.body).not.toContain('<script>x');
  });

  it('hands the link over for pasting, for a friend who opened the app from the installer', async () => {
    const appDir = tempAppDir();
    publish(appDir, '1.1.0');
    harness = await appWith(appDir);
    const ali = await registerUser(harness.app, 'ali');
    const page = await harness.app.inject({
      method: 'GET',
      url: `/davet/${ali.me.inviteCode.toLowerCase()}`,
      headers: { host: 'abc.trycloudflare.com', 'x-forwarded-proto': 'https', 'user-agent': 'Android' },
    });
    expect(page.body).toContain("Yükleyicideki <b>Aç</b>'a bastıysan: bu bağlantıyı kopyala, uygulamada yapıştır.");
    expect(page.body).toContain(`value="https://abc.trycloudflare.com/davet/${ali.me.inviteCode}"`);
    expect(page.body).toContain('Bağlantıyı kopyala');

    // the strict CSP lets exactly this script run, and nothing inline besides
    const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toHaveLength(1);
    const hash = createHash('sha256').update(scripts[0]!).digest('base64');
    const csp = String(page.headers['content-security-policy']);
    const scriptSrc = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'));
    expect(scriptSrc).toBe(`script-src 'sha256-${hash}'`);
    expect(csp).toContain("default-src 'none'");

    // the download fallback hands over the same link, and a bare /indir the server alone
    const fallback = await harness.app.inject({ method: 'GET', url: `/indir?kod=${ali.me.inviteCode}`, headers: { host: 'x.test' } });
    expect(fallback.body).toContain(`value="http://x.test/davet/${ali.me.inviteCode}"`);
    const bare = await harness.app.inject({ method: 'GET', url: '/indir', headers: { host: 'x.test' } });
    expect(bare.body).toContain('value="http://x.test/indir"');
  });

  it('hands only the address to paste when the APK on offer is older than 1.1.0, or unknown', async () => {
    const appDir = tempAppDir();
    publish(appDir, '1.0.4');
    harness = await appWith(appDir);
    const ali = await registerUser(harness.app, 'ali');
    const headers = { host: 'abc.trycloudflare.com', 'x-forwarded-proto': 'https' };
    const old = await harness.app.inject({ method: 'GET', url: `/davet/${ali.me.inviteCode}`, headers });
    // 1.0 would keep /davet/CODE as part of the server address
    expect(old.body).toContain('value="https://abc.trycloudflare.com"');
    expect(old.body).not.toContain(`value="https://abc.trycloudflare.com/davet/`);
    expect(old.body).toContain('<b>Sunucu · değiştir</b>');
    expect(old.body).not.toContain('bu bağlantıyı kopyala');

    fs.rmSync(path.join(appDir, 'latest.json'));
    const unknown = await harness.app.inject({ method: 'GET', url: `/davet/${ali.me.inviteCode}`, headers });
    expect(unknown.body).toContain('value="https://abc.trycloudflare.com"');
    expect(unknown.body).toContain('Adresi kopyala');
  });

  it('helps past the download and install warnings without a script of its own', async () => {
    const appDir = tempAppDir();
    publish(appDir, '1.1.0');
    harness = await appWith(appDir);
    const ali = await registerUser(harness.app, 'ali');
    const page = await harness.app.inject({
      method: 'GET',
      url: `/davet/${ali.me.inviteCode}`,
      headers: { host: 'x.test', 'user-agent': 'Mozilla/5.0 (Linux; Android 14)' },
    });
    expect(page.body).toContain('<summary>Kurulmuyor mu?</summary>');
    expect(page.body).toContain('<b>Yine de indir</b>');
    expect(page.body).toContain('<b>Yine de yükle</b>');
    expect(page.body).toContain('Uygulama yüklenmedi');
    // and past the usage access Android 15 greys out for an app from a link
    expect(page.body).toContain('"Kısıtlanmış ayar"');
    expect(page.body).toContain('KOYDUM → sağ üstteki ⋮ → <b>Kısıtlanmış ayarlara izin ver</b>');

    // a <details> needs no code: the policy is the one it was, the copy script's hash alone
    const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toHaveLength(1);
    const hash = createHash('sha256').update(scripts[0]!).digest('base64');
    expect(page.headers['content-security-policy']).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'sha256-${hash}'`,
    );

    // whoever came without an inviter installs the same APK
    const bare = await harness.app.inject({ method: 'GET', url: '/indir', headers: { host: 'x.test' } });
    expect(bare.body).toContain('Kurulmuyor mu?');
    expect(bare.body).toContain('"Kısıtlanmış ayar"');
  });

  it("goes on in the inviter's register under their name", async () => {
    harness = await appWith(tempAppDir());
    const leadOf = async (inviteCode: string): Promise<string> => {
      const page = await harness!.app.inject({ method: 'GET', url: `/davet/${inviteCode}`, headers: { host: 'x.test' } });
      return /<h1>[\s\S]*?<\/h1>\s*<p>([^<]*)<\/p>/.exec(page.body)?.[1] ?? '';
    };

    const nazik = await registerUser(harness.app, 'nazik', { vulgarityMax: 1 });
    const polite = await leadOf(nazik.me.inviteCode);
    expect(polite).toContain('kazanan belli olur, kaybeden rövanş ister.');
    expect(polite).not.toMatch(/koy|yer\b|🍆/);

    // level 2 is everybody's default, and the app's own: "koydu, yedik"
    const orta = await registerUser(harness.app, 'orta');
    expect(await leadOf(orta.me.inviteCode)).toContain('kazanan koyar, kaybeden yer.');

    const kaba = await registerUser(harness.app, 'kaba', { vulgarityMax: 3 });
    expect(await leadOf(kaba.me.inviteCode)).toContain('kazanan saplar, kaybeden yer 🍆');

    // without an inviter the page has nobody's register but the app's
    const bare = await harness.app.inject({ method: 'GET', url: '/indir', headers: { host: 'x.test' } });
    expect(bare.body).toContain('Arkadaşlar arası çelınc uygulaması. Kazanan koyar, kaybeden yer.');
  });
});

describe('the review round', () => {
  it('offers no open button on /indir without a code, and keeps it with one', async () => {
    harness = await appWith(tempAppDir());
    const bare = await harness.app.inject({ method: 'GET', url: '/indir', headers: { host: 'x.test', 'user-agent': 'Android' } });
    expect(bare.body).not.toContain('koydum://');
    expect(bare.body).not.toContain('intent://');
    const withCode = await harness.app.inject({ method: 'GET', url: '/indir?kod=abc234', headers: { host: 'x.test', 'user-agent': 'Android' } });
    expect(withCode.body).toContain('intent://davet/ABC234');
  });

  it('treats a localhost PUBLIC_URL as no public address at all', async () => {
    harness = await makeApp({ config: { appDir: tempAppDir(), publicUrl: 'http://localhost:4000' } });
    const ali = await registerUser(harness.app, 'ali');
    const page = await harness.app.inject({ method: 'GET', url: `/davet/${ali.me.inviteCode}`, headers: { host: '192.168.1.142:4000' } });
    expect(page.body).toContain(encodeURIComponent('http://192.168.1.142:4000'));
    expect(page.body).not.toContain(encodeURIComponent('http://localhost:4000'));
  });

  it('counts lookups per real client behind a tunnel on this machine, not one shared bucket', async () => {
    harness = await appWith(tempAppDir());
    const from = (ip: string) =>
      harness!.app.inject({ method: 'GET', url: '/invites/ZZZZZZ', headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 120; i += 1) await from('203.0.113.7');
    expect((await from('203.0.113.7')).statusCode).toBe(429);
    // somebody else coming through the same tunnel is unaffected
    expect((await from('198.51.100.9')).statusCode).toBe(404);
  });

  it('counts an IPv6 client as its whole /64, so fresh addresses buy no fresh lookups', async () => {
    harness = await appWith(tempAppDir());
    const from = (ip: string) =>
      harness!.app.inject({ method: 'GET', url: '/invites/ZZZZZZ', headers: { 'x-forwarded-for': ip } });
    for (let i = 1; i <= 120; i += 1) await from(`2001:db8:5:6::${i.toString(16)}`);
    expect((await from('2001:db8:5:6:ffff::1')).statusCode).toBe(429);
    expect((await from('2001:db8:5:7::1')).statusCode).toBe(404);
  });
});

describe('GET /invites/:code', () => {
  it('returns the public face of the code owner, case-insensitively', async () => {
    harness = await appWith(tempAppDir());
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const found = await harness.app.inject({ method: 'GET', url: `/invites/${ali.me.inviteCode.toLowerCase()}` });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({
      code: ali.me.inviteCode,
      inviter: { username: 'ali', displayName: 'Ali', avatarEmoji: ali.me.avatarEmoji },
    });
    const missing = await harness.app.inject({ method: 'GET', url: '/invites/ZZZZZZ' });
    expect(missing.statusCode).toBe(404);
  });

  it('is rate-limited per address so codes cannot be enumerated', async () => {
    harness = await appWith(tempAppDir());
    let last = 0;
    for (let i = 0; i < 121; i += 1) {
      last = (await harness.app.inject({ method: 'GET', url: `/invites/AAAA${String(i).padStart(2, '0')}` })).statusCode;
    }
    expect(last).toBe(429);
    harness.advance(11 * 60_000);
    expect((await harness.app.inject({ method: 'GET', url: '/invites/AAAAAA' })).statusCode).toBe(404);
  });
});

describe('the published build', () => {
  it('is downloadable with the right headers and reported by /health', async () => {
    const appDir = tempAppDir();
    publish(appDir, '1.1.0', 4096);
    harness = await appWith(appDir);

    const apk = await harness.app.inject({ method: 'GET', url: '/koydum.apk' });
    expect(apk.statusCode).toBe(200);
    expect(apk.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(apk.headers['content-disposition']).toContain('koydum-1.1.0.apk');
    expect(apk.rawPayload.length).toBe(4096);

    const health = await harness.app.inject({ method: 'GET', url: '/health', headers: { host: '10.0.0.5:4000' } });
    // no PUBLIC_URL: nothing better to share than the address the phone already uses
    expect(health.json<{ publicUrl: string | null }>().publicUrl).toBeNull();
    expect(health.json<{ app: unknown }>().app).toEqual({
      latestVersion: '1.1.0',
      downloadUrl: 'http://10.0.0.5:4000/koydum.apk',
      notes: 'Ekran süresi geldi',
    });
  });

  it('resumes a broken download from where it stopped, and starts over once a new build is up', async () => {
    const appDir = tempAppDir();
    publish(appDir, '1.1.0', 4096);
    // every byte different from its neighbours, so a wrong slice cannot pass
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    fs.writeFileSync(path.join(appDir, 'koydum.apk'), bytes);
    harness = await appWith(appDir);

    const full = await harness.app.inject({ method: 'GET', url: '/koydum.apk' });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-length']).toBe('4096');
    expect(full.headers['cache-control']).toBe('no-cache');
    const lastModified = String(full.headers['last-modified']);
    const etag = String(full.headers.etag);
    expect(Date.parse(lastModified)).not.toBeNaN();
    expect(etag).not.toBe('undefined');

    const part = await harness.app.inject({ method: 'GET', url: '/koydum.apk', headers: { range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/4096');
    expect(part.headers['content-length']).toBe('100');
    expect(part.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(part.headers['content-disposition']).toContain('koydum-1.1.0.apk');
    expect(part.rawPayload.equals(bytes.subarray(100, 200))).toBe(true);

    // "Devam et" from the middle to the end
    const rest = await harness.app.inject({ method: 'GET', url: '/koydum.apk', headers: { range: 'bytes=4000-' } });
    expect(rest.statusCode).toBe(206);
    expect(rest.headers['content-range']).toBe('bytes 4000-4095/4096');
    expect(rest.rawPayload.equals(bytes.subarray(4000))).toBe(true);

    const past = await harness.app.inject({ method: 'GET', url: '/koydum.apk', headers: { range: 'bytes=5000-' } });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe('bytes */4096');

    // Chrome resumes with the validator it got: the same build answers the range...
    for (const ifRange of [lastModified, etag]) {
      const resumed = await harness.app.inject({
        method: 'GET',
        url: '/koydum.apk',
        headers: { range: 'bytes=100-199', 'if-range': ifRange },
      });
      expect(resumed.statusCode).toBe(206);
      expect(resumed.rawPayload.equals(bytes.subarray(100, 200))).toBe(true);
    }
    // ...a build that changed since then is sent whole
    const changed = await harness.app.inject({
      method: 'GET',
      url: '/koydum.apk',
      headers: { range: 'bytes=100-199', 'if-range': 'Mon, 01 Jan 2001 00:00:00 GMT' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.rawPayload.equals(bytes)).toBe(true);

    const head = await harness.app.inject({ method: 'HEAD', url: '/koydum.apk' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('4096');
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(head.rawPayload.length).toBe(0);
  });

  it('answers a missing build with apk_not_found, and boots even when APP_DIR is unusable', async () => {
    const appDir = tempAppDir();
    harness = await appWith(appDir);
    const missing = await harness.app.inject({ method: 'GET', url: '/koydum.apk' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('apk_not_found');
    await harness.close();

    // a file where the directory should be, and a directory that is not there
    const blocker = path.join(appDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    for (const broken of [blocker, path.join(appDir, 'yok', 'app')]) {
      harness = await appWith(broken);
      expect((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const apk = await harness.app.inject({ method: 'GET', url: '/koydum.apk' });
      expect(apk.statusCode).toBe(404);
      expect(apk.json<{ error: { code: string } }>().error.code).toBe('apk_not_found');
      await harness.close();
      harness = null;
    }
  });

  it('falls back to APP_DOWNLOAD_URL, and says nothing when there is no build at all', async () => {
    harness = await appWith(tempAppDir(), {
      appDownloadUrl: 'https://expo.dev/accounts/x/projects/koydum/builds/abc',
      appLatestVersion: '1.2.0',
    });
    expect((await harness.app.inject({ method: 'GET', url: '/health' })).json<{ app: unknown }>().app).toEqual({
      latestVersion: '1.2.0',
      downloadUrl: 'https://expo.dev/accounts/x/projects/koydum/builds/abc',
      notes: null,
    });
    expect((await harness.app.inject({ method: 'GET', url: '/koydum.apk' })).statusCode).toBe(404);
    await harness.close();

    harness = await appWith(tempAppDir());
    expect((await harness.app.inject({ method: 'GET', url: '/health' })).json<{ app: unknown }>().app).toBeNull();
  });

  it('npm run apk:yayinla puts the file and its version where the server looks', () => {
    const appDir = tempAppDir();
    const source = path.join(appDir, 'build-123.apk');
    fs.writeFileSync(source, Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 1)]));
    const script = path.resolve(__dirname, '..', 'scripts', 'publish-apk.mjs');
    execFileSync(process.execPath, [script, source, '--surum', '1.3.0', '--not', 'deneme'], {
      env: { ...process.env, APP_DIR: appDir },
      stdio: 'pipe',
    });
    expect(fs.statSync(path.join(appDir, 'koydum.apk')).size).toBe(102);
    expect(JSON.parse(fs.readFileSync(path.join(appDir, 'latest.json'), 'utf8'))).toMatchObject({ version: '1.3.0', notes: 'deneme' });

    const notApk = path.join(appDir, 'x.apk');
    fs.writeFileSync(notApk, 'hello');
    expect(() =>
      execFileSync(process.execPath, [script, notApk], { env: { ...process.env, APP_DIR: appDir }, stdio: 'pipe' }),
    ).toThrow();
  });
});

describe('POST /uploads', () => {
  it('answers with a path the phone resolves against its own server address', async () => {
    harness = await appWith(tempAppDir());
    const ali = await registerUser(harness.app, 'ali');
    const form = multipart({ filename: 'k.jpg', contentType: 'image/jpeg', content: JPEG_WITH_GPS });
    const uploaded = await harness.app.inject({
      method: 'POST',
      url: '/uploads',
      payload: form.payload,
      headers: { ...form.headers, authorization: `Bearer ${ali.token}` },
    });
    expect(uploaded.statusCode).toBe(201);
    const url = uploaded.json<{ url: string }>().url;
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]+\.jpg$/);
    expect((await harness.app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });
});
