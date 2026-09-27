/**
 * Invite links: the page a shared link opens, the JSON the app reads, the APK
 * download and the "latest version" the app compares itself against.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, registerUser, type TestApp } from './helpers.js';

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
    expect(hostile.body).not.toContain('<script>');
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
    const boundary = 'koydumrel';
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="k.jpg"', 'Content-Type: image/jpeg', '', 'x'.repeat(32), `--${boundary}--`, ''].join('\r\n');
    const uploaded = await harness.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${ali.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(uploaded.statusCode).toBe(201);
    const url = uploaded.json<{ url: string }>().url;
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]+\.jpg$/);
    expect((await harness.app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });
});
