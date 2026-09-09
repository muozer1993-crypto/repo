/**
 * Repro harness for the "previously tapped challenge-type cards go invisible" bug.
 * Reuses e2e/static-server.mjs and the same server-boot recipe as e2e/smoke.mjs.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { startStaticServer } from '/home/user/repo/e2e/static-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('/tmp/claude-0/-home-user-repo/abeeccf2-8720-52f3-924e-d851a08e726c/scratchpad/pw/node_modules/playwright-core');

const API_PORT = Number(process.env.API_PORT ?? 4995);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const DATA_DIR = '/tmp/koydum-bug-data';
const WEB_DIR = process.env.WEB_DIR ?? '/tmp/koydum-bug-web';
const OUT = '/home/user/repo/docs/screens/bug-typecards';
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const log = (...p) => console.log('•', ...p);

async function waitFor(check, { timeoutMs = 60000, everyMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

class Api {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.token = null;
  }
  async call(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
}

/* ---- the DOM dump that runs inside the page ---- */

const DUMP_FN = () => {
  const scrollers = Array.from(document.querySelectorAll('*')).filter((el) => {
    const s = getComputedStyle(el);
    return (
      (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4
    );
  });
  const scroller = scrollers[0] ?? null;

  // A TypeRow is <Card><Pressable(head)>…; RNW renders the Card as a div that
  // carries the shadow inline, and the head as its first-child <button>.
  const heads = Array.from(document.querySelectorAll('button[role="button"]')).filter((b) => {
    const p = b.parentElement;
    return (
      p &&
      /box-shadow/.test(p.getAttribute('style') ?? '') &&
      p.firstElementChild === b &&
      /\S/.test(b.textContent ?? '')
    );
  });

  const info = (el, label) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      label,
      tag: el.tagName,
      className: el.className,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      offsetHeight: el.offsetHeight,
      scrollHeight: el.scrollHeight,
      opacity: s.opacity,
      display: s.display,
      visibility: s.visibility,
      height: s.height,
      maxHeight: s.maxHeight,
      overflow: s.overflow,
      position: s.position,
      transform: s.transform,
      zIndex: s.zIndex,
      backgroundColor: s.backgroundColor,
      color: s.color,
      borderWidth: `${s.borderTopWidth}/${s.borderRightWidth}/${s.borderBottomWidth}/${s.borderLeftWidth}`,
      borderColor: `${s.borderTopColor} | left:${s.borderLeftColor}`,
      boxShadow: s.boxShadow,
      filter: s.filter,
      clipPath: s.clipPath,
      contentVisibility: s.contentVisibility,
      offsetParentNull: el.offsetParent === null,
      isConnected: el.isConnected,
    };
  };

  const cards = heads.map((head, i) => {
    const card = head.parentElement;
    const text = (card?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const r = card.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + Math.min(24, r.height / 2);
    const topEl = document.elementFromPoint(cx, cy);
    return {
      index: i,
      name: text.split(' ').slice(0, 4).join(' '),
      selected: head.getAttribute('aria-selected'),
      text: text.slice(0, 160),
      card: info(card, 'card'),
      head: info(head, 'head'),
      // is anything painting over it?
      hitTest:
        topEl == null
          ? 'none (outside viewport)'
          : card.contains(topEl)
            ? 'self'
            : `OTHER: ${topEl.tagName}.${String(topEl.className).slice(0, 60)}`,
      // ancestors that could hide it
      ancestors: (() => {
        const out = [];
        let el = card.parentElement;
        let depth = 0;
        while (el && depth < 6) {
          const s = getComputedStyle(el);
          if (
            s.opacity !== '1' ||
            s.display === 'none' ||
            s.visibility !== 'visible' ||
            s.overflow !== 'visible' ||
            s.transform !== 'none'
          ) {
            out.push({
              depth,
              tag: el.tagName,
              className: String(el.className).slice(0, 60),
              opacity: s.opacity,
              display: s.display,
              visibility: s.visibility,
              overflow: s.overflow,
              transform: s.transform,
              height: s.height,
            });
          }
          el = el.parentElement;
          depth += 1;
        }
        return out;
      })(),
    };
  });

  return {
    cardCount: cards.length,
    scroller: scroller
      ? {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          className: String(scroller.className).slice(0, 80),
        }
      : null,
    bodyTextLength: (document.body.innerText ?? '').length,
    cards,
  };
};

/* --------------------------------------------------------------- main */

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(join(WEB_DIR, 'index.html'))) throw new Error(`no web export at ${WEB_DIR}`);

  log('starting server');
  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    detached: true,
    cwd: '/home/user/repo/apps/server',
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
  server.stdout.on('data', (c) => (serverLog += c));
  server.stderr.on('data', (c) => (serverLog += c));

  const cleanup = [];
  const shutdown = async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {}
    }
    try {
      if (server.pid) process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  };

  try {
    await waitFor(async () => (await fetch(`${API_URL}/health`)).ok, {
      what: '/health',
      timeoutMs: 60000,
    });
    log('server up');

    const mustafa = new Api(API_URL);
    const ali = new Api(API_URL);
    const reg = async (api, username, displayName) => {
      const r = await api.call('POST', '/auth/register', {
        username,
        password: 'koydum123',
        displayName,
        timezone: 'Europe/Istanbul',
      });
      api.token = r.token;
      return r;
    };
    const a = await reg(mustafa, 'mustafa', 'Mustafa');
    const b = await reg(ali, 'ali', 'Ali');
    await mustafa.call('POST', '/friends/request', { username: 'ali' });
    const inbox = await ali.call('GET', '/friends');
    await ali.call('POST', `/friends/${inbox.incoming[0].id}/accept`);
    log('registered + friends');

    const statics = await startStaticServer(WEB_DIR);
    cleanup.push(statics.close);
    log(`web at ${statics.url}`);

    const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
    cleanup.push(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    });
    await context.addInitScript(
      ([apiUrl, token, me]) => {
        window.localStorage.setItem('koydum.serverUrl', JSON.stringify(apiUrl));
        window.localStorage.setItem('koydum.token', JSON.stringify(token));
        window.localStorage.setItem('koydum.me', JSON.stringify(me));
        window.localStorage.setItem('koydum.onboarded', '1');
      },
      [API_URL, mustafa.token, a.me]
    );
    const page = await context.newPage();
    const consoleMsgs = [];
    page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

    await page.goto(`${statics.url}/challenge/new`, { waitUntil: 'domcontentloaded' });
    await waitFor(
      async () => (await page.evaluate(() => document.body.innerText ?? '')).includes('Adım'),
      { what: 'the type picker to render', timeoutMs: 30000 }
    );
    log('type picker rendered');

    const steps = [];
    const record = async (label) => {
      const dump = await page.evaluate(DUMP_FN);
      await page.screenshot({ path: join(OUT, `${label}.png`) });
      await page.screenshot({ path: join(OUT, `${label}-full.png`), fullPage: true });
      steps.push({ label, dump });
      const short = dump.cards.map(
        (c) =>
          `${String(c.index).padStart(2)} ${c.selected === 'true' ? 'ON ' : '   '}` +
          `h=${String(c.card.rect.h).padStart(6)} y=${String(c.card.rect.y).padStart(7)} ` +
          `op=${c.card.opacity} disp=${c.card.display} vis=${c.card.visibility} ` +
          `hit=${c.hitTest} :: ${c.name}`
      );
      console.log(`\n===== ${label} (cards=${dump.cardCount}, scroller=${JSON.stringify(dump.scroller)}) =====`);
      console.log(short.join('\n'));
      return dump;
    };

    await record('00-initial');

    const clickType = async (name, label) => {
      log(`clicking ${name}`);
      const target = page.locator(`button[role="button"]`, { hasText: name }).first();
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await page.waitForTimeout(700);
      return record(label);
    };

    await clickType('Adım Yarışı', '01-after-A-adim');
    await clickType('Koşu Kilometresi', '02-after-B-kosu');
    await clickType('Şınav Kapışması', '03-after-C-sinav');
    // a fourth in a different category, and back to the first
    await clickType('Su Bardağı', '04-after-D-su');
    await clickType('Adım Yarışı', '05-back-to-A');

    // scroll to the very top and re-dump, in case things simply scrolled away
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*')).filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4;
      });
      if (els[0]) els[0].scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);
    await record('06-scrolled-top');

    /* ---- phase 2: touch taps, an expanded info block, and rapid switching ---- */
    const tapType = async (name, label) => {
      log(`tapping (touch) ${name}`);
      const target = page.locator(`button[role="button"]`, { hasText: name }).first();
      await target.scrollIntoViewIfNeeded();
      await target.tap();
      await page.waitForTimeout(700);
      return label ? record(label) : null;
    };

    await tapType('Adım Yarışı', null);
    await page.getByText('Nasıl ölçülür?').first().tap();
    await page.waitForTimeout(500);
    await record('07-A-tapped-info-open');

    await tapType('Koşu Kilometresi', '08-B-after-A-had-info-open');

    // rapid switching, no waiting between taps
    for (const name of ['Adım Yarışı', 'Şınav Kapışması', 'Merdiven Canavarı', 'Koşu Kilometresi']) {
      const t = page.locator(`button[role="button"]`, { hasText: name }).first();
      await t.scrollIntoViewIfNeeded();
      await t.tap();
    }
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*')).filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4;
      });
      if (els[0]) els[0].scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await record('09-after-rapid-switching');

    writeFileSync(
      join(OUT, 'dump.json'),
      JSON.stringify({ steps, console: consoleMsgs }, null, 2),
      'utf8'
    );
    console.log('\n===== CONSOLE =====');
    console.log(consoleMsgs.join('\n') || '(none)');
    log(`wrote ${join(OUT, 'dump.json')}`);
    await shutdown();
    process.exit(0);
  } catch (error) {
    console.error('FAILED:', error.message);
    if (serverLog.trim()) console.error('--- server log ---\n' + serverLog.slice(-3000));
    await shutdown();
    process.exit(1);
  }
}

main();
