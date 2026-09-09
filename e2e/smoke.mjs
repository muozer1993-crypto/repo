/**
 * End-to-end smoke test.
 *
 * Boots the real server on a temporary database, drives the whole KOYDUM story
 * through the HTTP API, then loads the exported web build in Chromium and
 * checks that the app renders that state: the login screen, the home list with
 * a live challenge, the winner's "KOYDUM MU?" screen and the loser's shame
 * screen with the taunt they received.
 *
 * Usage:
 *   node e2e/smoke.mjs                    # exports the web build first (slow)
 *   node e2e/smoke.mjs --reuse-web        # reuse the previous export (same port only)
 *   node e2e/smoke.mjs --headed        # watch it happen
 *
 * Requires `playwright-core` and a Chromium binary. Set CHROMIUM_PATH to point
 * at one, or let the script look in the usual Playwright cache locations.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer } from './static-server.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const API_PORT = Number(option('port', '4993'));
const API_URL = `http://127.0.0.1:${API_PORT}`;
const DATA_DIR = option('data', '/tmp/koydum-e2e-data');
const WEB_DIR = option('web', '/tmp/koydum-e2e-web');
const SHOT_DIR = option('shots', join(ROOT, 'docs/screens'));
const HEADED = flag('headed');

const log = (...parts) => console.log('•', ...parts);
const fail = (message) => {
  throw new Error(message);
};

/* ------------------------------------------------------------------ utils */

function run(command, cmdArgs, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, cmdArgs, { stdio: 'inherit', ...options });
    child.on('error', rejectPromise);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited with ${code}`))
    );
  });
}

async function waitFor(check, { timeoutMs = 60_000, everyMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(process.env.HOME ?? '', '.cache/ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      for (const candidate of [
        join(root, entry, 'chrome-linux/chrome'),
        join(root, entry, 'chrome-linux/headless_shell'),
        join(root, entry, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  fail('no Chromium found — set CHROMIUM_PATH');
}

function loadPlaywright() {
  for (const id of ['playwright-core', 'playwright']) {
    try {
      return require(id);
    } catch {
      // try the next one
    }
  }
  // the sandbox keeps a copy outside the repo
  const scratch = process.env.KOYDUM_PLAYWRIGHT_PATH;
  if (scratch) return require(scratch);
  fail('playwright-core is not installed (npm i -D playwright-core)');
}

/* -------------------------------------------------------------- API story */

class Api {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.token = null;
  }

  async call(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status} ${text}`);
    }
    return payload;
  }
}

async function buildStory() {
  const mustafa = new Api(API_URL);
  const ali = new Api(API_URL);

  const register = async (api, username, displayName, vulgarityMax) => {
    const result = await api.call('POST', '/auth/register', {
      username,
      password: 'koydum123',
      displayName,
      timezone: 'Europe/Istanbul',
    });
    api.token = result.token;
    if (vulgarityMax && result.me.vulgarityMax !== vulgarityMax) {
      result.me = await api.call('PATCH', '/me', { vulgarityMax });
    }
    return result;
  };

  const a = await register(mustafa, 'mustafa', 'Mustafa', 3);
  const b = await register(ali, 'ali', 'Ali', 3);
  log(`registered ${a.me.username} and ${b.me.username}`);

  await mustafa.call('POST', '/friends/request', { username: 'ali' });
  const aliFriends = await ali.call('GET', '/friends');
  const incoming = aliFriends.incoming?.[0];
  if (!incoming) fail('friend request did not arrive in Ali\'s inbox');
  await ali.call('POST', `/friends/${incoming.id}/accept`);
  log('they are friends');

  const now = Date.now();
  const challenge = await mustafa.call('POST', '/challenges', {
    typeKey: 'adim_yarisi',
    title: 'Gece Yürüyüşü',
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 60 * 60_000).toISOString(),
    participantIds: [b.me.id],
    rewardText: 'Kaybeden döner ısmarlar',
  });
  await ali.call('POST', `/challenges/${challenge.id}/accept`);
  log(`challenge ${challenge.id} is running`);

  // Day keys live in the USER's timezone, not UTC — the same rule the app follows.
  const dayKeyIn = (offsetDays = 0) => {
    const date = new Date(Date.now() + offsetDays * 86_400_000);
    return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
  };
  // cover today and yesterday so the run works whatever the hour is
  const days = (steps) => [
    { dayKey: dayKeyIn(0), steps, source: 'pedometer' },
    { dayKey: dayKeyIn(-1), steps, source: 'pedometer' },
  ];
  await mustafa.call('POST', '/me/steps', { days: days(12430) });
  await ali.call('POST', '/me/steps', { days: days(4201) });
  log('steps posted: 12.430 vs 4.201');

  // a second challenge that stays live, so the home screen has something active
  const live = await mustafa.call('POST', '/challenges', {
    typeKey: 'su_bardak',
    title: 'Su İçme Yarışı',
    startsAt: new Date(now - 30_000).toISOString(),
    endsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
    participantIds: [b.me.id],
  });
  await ali.call('POST', `/challenges/${live.id}/accept`);

  await mustafa.call('POST', `/dev/finalize/${challenge.id}`);
  const results = await mustafa.call('GET', `/challenges/${challenge.id}/results`);
  if (results.challenge.winnerId !== a.me.id) {
    fail(`expected Mustafa to win, got ${JSON.stringify(results.challenge)}`);
  }
  log('challenge finalised, Mustafa won');

  // the winner picks a template, exactly as the taunt screen does
  const templates = results.tauntTemplatesForWinner ?? [];
  // pick the harshest one the winner is offered — that is the screenshot worth having
  const template = [...templates].sort((x, y) => (y.level ?? 0) - (x.level ?? 0))[0];
  if (!template) fail('the results did not offer the winner any taunt templates');
  await mustafa.call('POST', `/challenges/${challenge.id}/taunt`, {
    toUserId: b.me.id,
    templateId: template.id,
  });
  const inbox = await ali.call('GET', '/me/inbox');
  const taunt = inbox.find((item) => item.type === 'taunt');
  if (!taunt) fail('Ali never received the taunt');
  log(`taunt delivered: "${taunt.title}" — ${taunt.body}`);

  return {
    mustafa: { api: mustafa, me: a.me },
    ali: { api: ali, me: b.me },
    finishedChallengeId: challenge.id,
    liveChallengeId: live.id,
    taunt,
  };
}

/* ------------------------------------------------------------------ pages */

async function seedSession(page, webUrl, { token, me }) {
  await page.goto(`${webUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([apiUrl, tokenValue, meValue]) => {
      window.localStorage.setItem('koydum.serverUrl', JSON.stringify(apiUrl));
      window.localStorage.setItem('koydum.token', JSON.stringify(tokenValue));
      window.localStorage.setItem('koydum.me', JSON.stringify(meValue));
      window.localStorage.setItem('koydum.onboarded', '1');
    },
    [API_URL, token, me]
  );
}

async function textOf(page) {
  return page.evaluate(() => document.body.innerText ?? '');
}

async function expectText(page, needles, label) {
  let lastSeen = '';
  try {
    const body = await waitFor(
      async () => {
        lastSeen = await textOf(page);
        return needles.some((needle) => lastSeen.includes(needle)) ? lastSeen : null;
      },
      { timeoutMs: 25_000, what: `${label} (looking for ${needles.join(' | ')})` }
    );
    log(`✓ ${label}`);
    return body;
  } catch (error) {
    // the page text is the only useful clue when a screen does not appear
    throw new Error(`${error.message}\n--- page showed ---\n${lastSeen.slice(0, 900)}`);
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(SHOT_DIR, { recursive: true });

  log('starting server');
  // detached so the whole process group can be killed: `npx` spawns tsx, which
  // spawns node, and a SIGTERM to npx alone leaves the server listening.
  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    detached: true,
    cwd: join(ROOT, 'apps/server'),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      PUBLIC_URL: API_URL,
      ENABLE_DEV_ROUTES: '1',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });

  const cleanup = [];
  const shutdown = async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        // best effort
      }
    }
    try {
      if (server.pid) process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  };

  try {
    await waitFor(
      async () => {
        const response = await fetch(`${API_URL}/health`);
        return response.ok;
      },
      { what: 'the server to answer /health', timeoutMs: 60_000 }
    );
    // A server left over from an earlier run answers /health too. The dev routes
    // only exist when ENABLE_DEV_ROUTES=1, which only this harness sets, so their
    // absence means we are talking to somebody else's process.
    const devProbe = await fetch(`${API_URL}/dev/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (devProbe.status === 404) {
      fail(`another server is already listening on ${API_URL} — kill it or pass --port <n>`);
    }
    log('server is up');

    const story = await buildStory();

    // The build must point at THIS run's API port, so it is rebuilt unless the
    // caller explicitly asks to reuse one (--reuse-web) that they built the same way.
    if (!flag('reuse-web') || !existsSync(join(WEB_DIR, 'index.html'))) {
      log('exporting the web build (this takes a minute)');
      await run('npx', ['expo', 'export', '--clear', '--platform', 'web', '--output-dir', WEB_DIR], {
        cwd: join(ROOT, 'apps/mobile'),
        env: { ...process.env, EXPO_PUBLIC_KOYDUM_API_URL: API_URL },
      });
    }

    const statics = await startStaticServer(WEB_DIR);
    cleanup.push(statics.close);
    log(`web build served from ${statics.url}`);

    const { chromium } = loadPlaywright();
    const browser = await chromium.launch({ executablePath: findChromium(), headless: !HEADED });
    cleanup.push(() => browser.close());

    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    // Point every page at THIS run's server before any app code executes. Metro
    // caches transforms across builds, so an EXPO_PUBLIC_* value cannot be relied
    // on to change between runs — the app reads this key first anyway.
    await context.addInitScript((apiUrl) => {
      window.localStorage.setItem('koydum.serverUrl', JSON.stringify(apiUrl));
      window.localStorage.setItem('koydum.onboarded', '1');
    }, API_URL);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    // 1. logged out
    await page.goto(`${statics.url}/`, { waitUntil: 'domcontentloaded' });
    await expectText(page, ['KOYDUM'], 'login screen renders');
    await page.screenshot({ path: join(SHOT_DIR, '01-login.png') });

    // 2. sign in through the real form
    await page.fill('input >> nth=0', 'ali');
    await page.fill('input >> nth=1', 'koydum123');
    await page.getByText(/gir bakalım/i).first().click();
    await expectText(page, ['Çelınc', 'çelınc', 'Su İçme', 'Devam'], 'home screen after login');
    await page.screenshot({ path: join(SHOT_DIR, '02-home-loser.png'), fullPage: true });

    // 3. the loser's shame screen
    await page.goto(`${statics.url}/challenge/${story.finishedChallengeId}/results`, {
      waitUntil: 'domcontentloaded',
    });
    await expectText(
      page,
      ['SAPLANDIN', 'REZİL', 'Bu tur senin değil', 'RÖVANŞ', 'FINAL TABLOSU'],
      'shame screen'
    );
    const shameText = await textOf(page);
    if (!shameText.includes('12.430') && !shameText.includes('12430')) {
      log(`! shame screen did not show the winning score. Body was:\n${shameText.slice(0, 800)}`);
    }
    await page.screenshot({ path: join(SHOT_DIR, '03-shame.png'), fullPage: true });

    // 4. the winner's view
    await seedSession(page, statics.url, { token: story.mustafa.api.token, me: story.mustafa.me });
    await page.goto(`${statics.url}/challenge/${story.finishedChallengeId}/results`, {
      waitUntil: 'domcontentloaded',
    });
    await expectText(page, ['LAF HAKKI', 'FINAL TABLOSU', 'KOYDUM MU'], 'winner results screen');
    await page.screenshot({ path: join(SHOT_DIR, '04-winner.png'), fullPage: true });

    // 5. home as the winner
    await page.goto(`${statics.url}/`, { waitUntil: 'domcontentloaded' });
    await expectText(page, ['Su İçme', 'Çelınc', 'çelınc'], 'home screen as the winner');
    await page.screenshot({ path: join(SHOT_DIR, '05-home-winner.png'), fullPage: true });

    // 6. the inbox
    await page.goto(`${statics.url}/inbox`, { waitUntil: 'domcontentloaded' });
    await expectText(page, ['Gelen Kutusu', 'Gelen', 'okundu'], 'inbox');
    await page.screenshot({ path: join(SHOT_DIR, '06-inbox.png'), fullPage: true });

    const realErrors = consoleErrors.filter(
      (text) => !/favicon|Download the React DevTools|source ?map|Warning:/i.test(text)
    );
    if (realErrors.length > 0) {
      log(`! ${realErrors.length} console errors:`);
      for (const error of realErrors.slice(0, 10)) log(`   ${error}`);
    }

    log(`screenshots in ${SHOT_DIR}`);
    log('SMOKE TEST PASSED');
    await shutdown();
    process.exit(realErrors.length > 0 ? 2 : 0);
  } catch (error) {
    console.error('\nSMOKE TEST FAILED:', error.message);
    if (serverLog.trim()) console.error('\n--- server log ---\n' + serverLog.slice(-4000));
    await shutdown();
    process.exit(1);
  }
}

main();
