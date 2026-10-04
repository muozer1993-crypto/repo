/**
 * The owner's server window in Turkish: one short line per log entry instead of
 * pino's JSON.
 *
 * The owner is the only one who reads this window, and reads it when a friend says
 * "bildirim gelmedi": what the server did, and when, has to be readable at a glance.
 * index.ts turns it on only for a console (`wantsReadableLogs`); Docker, a file the
 * output was redirected to, the tests and LOG_FORMAT=json keep the JSON lines a log
 * collector or jq reads. Written by hand because pino-pretty would be one more
 * dependency for what fits on this page.
 *
 *   ── 2026-10-04 ──
 *   21:03:12 • KOYDUM sunucusu ayakta: port 4000, davet adresi https://….trycloudflare.com, veritabanı data/koydum.db
 *   21:03:42 • zamanlayıcı: 1 çelınc bitti, 3 kişiye günlük hatırlatma
 *   21:03:43 • push: 4 bildirim gitti, 1 tanesi gitmedi
 *   21:05:10 ! istek patladı: POST /challenges → 500 (31 ms)
 */
import { DEFAULT_TIMEZONE, dayKeyInTz, localTimeHHmm } from '@koydum/shared';
import type { SchedulerSummary } from './services/challenges.js';

/** Where the lines go: process.stdout, or an array in the tests. */
export interface LineSink {
  write(text: string): unknown;
}

type Entry = Record<string, unknown>;

/** pino's numeric levels. */
const WARN = 40;
const ERROR = 50;
const FATAL = 60;

/** The width of "21:03:12 • ", so the frames of a stack line up under the message. */
const INDENT = ' '.repeat(11);

/** Left out of the k=v tail: pino's bookkeeping, and what the line already shows. */
const NOISE = new Set(['level', 'time', 'pid', 'hostname', 'v', 'msg', 'reqId', 'err']);

/**
 * Readable lines only for a person at a console. Whatever else reads stdout
 * (Docker's log driver, a redirected file, a test's pipe) gets pino's JSON, and so
 * does a console with LOG_FORMAT=json.
 */
export function wantsReadableLogs(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdout.isTTY === true && env.LOG_FORMAT?.trim().toLowerCase() !== 'json';
}

/**
 * A report's reason or an error message is somebody else's text: a newline in it
 * would fake a log line of its own, and an escape sequence would recolour or clear
 * the owner's console. pino's JSON escaped both; here they become spaces.
 */
function oneLine(value: string): string {
  return value.replace(/\s*[\u0000-\u001f\u007f-\u009f]+\s*/g, ' ').trim();
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return oneLine(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return oneLine(JSON.stringify(value));
}

function count(entry: Entry, key: string): number {
  const value = entry[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** pino serializes an Error as `{ type, message, stack }`; a rejected string stays a string. */
function errorMessage(err: unknown): string {
  const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.trim() !== '' ? oneLine(message) : text(err);
}

/** Three frames point at the spot; a crash gets them all, it is what a bug report needs. */
function stackFrames(err: unknown, all: boolean): string[] {
  const stack = typeof err === 'object' && err !== null ? (err as { stack?: unknown }).stack : undefined;
  if (typeof stack !== 'string') return [];
  const frames = stack
    .split('\n')
    .map(oneLine)
    .filter((line) => line.startsWith('at '));
  return all ? frames : frames.slice(0, 3);
}

/** A pass's counts, in the order a çelınc lives through them; a new count fails the typecheck until it is here. */
const PASS_PARTS: Record<keyof SchedulerSummary, (n: number) => string> = {
  activated: (n) => `${n} çelınc başladı`,
  disputes: (n) => `${n} itirazlı kayıt sayılmadı`,
  finalized: (n) => `${n} çelınc bitti`,
  cancelled: (n) => `${n} çelınc başlamadan iptal oldu`,
  // "3 günlük hatırlatma" would read as a three-day reminder
  reminders: (n) => `${n} kişiye günlük hatırlatma`,
  nudges: (n) => `${n} dürtme`,
  tauntFollowups: (n) => `${n} kazanana "hadi koy" hatırlatması`,
  recaps: (n) => `${n} kişiye haftalık özet`,
};

const SHUTDOWN_REASONS: Record<string, string> = {
  SIGINT: 'Ctrl+C',
  SIGBREAK: 'Ctrl+Break',
  SIGHUP: 'pencere kapandı',
  supervisor: 'npm run internet istedi',
  'supervisor gone': 'npm run internet kapandı',
  unhandledRejection: 'hata yüzünden',
  uncaughtException: 'hata yüzünden',
};

function startupLine(entry: Entry): string {
  const host = text(entry.host);
  const parts = [host && host !== '0.0.0.0' ? `${host}:${text(entry.port)}` : `port ${text(entry.port)}`];
  if (text(entry.publicUrl)) parts.push(`davet adresi ${text(entry.publicUrl)}`);
  if (text(entry.db)) parts.push(`veritabanı ${text(entry.db)}`);
  return `KOYDUM sunucusu ayakta: ${parts.join(', ')}`;
}

function passLine(entry: Entry): string | null {
  const parts = Object.entries(PASS_PARTS)
    .map(([key, say]) => (count(entry, key) > 0 ? say(count(entry, key)) : ''))
    .filter(Boolean);
  return parts.length > 0 ? `zamanlayıcı: ${parts.join(', ')}` : null;
}

function pushLine(entry: Entry): string | null {
  const sent = count(entry, 'sent');
  const failed = count(entry, 'failed');
  if (sent > 0 && failed > 0) return `push: ${sent} bildirim gitti, ${failed} tanesi gitmedi`;
  if (sent > 0) return `push: ${sent} bildirim gitti`;
  if (failed > 0) return `push: ${failed} bildirim gitmedi`;
  return null;
}

/** The query string never got into the entry (app.ts); an invite code has no business here. */
function requestLine(entry: Entry): string {
  return `${text(entry.method)} ${text(entry.url)} → ${text(entry.statusCode)} (${text(entry.ms)} ms)`;
}

/**
 * The server's own messages, by their English text (grep for it to find where each
 * is logged). An `err` on the entry is added after the line; null writes nothing.
 */
const MESSAGES: Record<string, (entry: Entry) => string | null> = {
  'KOYDUM sunucusu ayakta': startupLine,
  'shutting down': (e) => {
    const reason = text(e.reason);
    return `sunucu kapanıyor (${Object.hasOwn(SHUTDOWN_REASONS, reason) ? SHUTDOWN_REASONS[reason] : reason})`;
  },
  'close failed': () => 'sunucu düzgün kapanamadı',
  'unhandled rejection': () => 'sunucu çöktü',
  'uncaught exception': () => 'sunucu çöktü',
  'scheduler pass': passLine,
  'scheduler pass failed': () => 'zamanlayıcı turu patladı',
  'scheduler step failed': (e) => `zamanlayıcının "${text(e.step)}" adımı patladı`,
  'scheduler pass still running at shutdown, closing anyway': () => 'zamanlayıcı turu bitmedi, beklemeden kapatıyorum',
  'push flush': pushLine,
  'push flush failed': () => 'push gönderilemedi',
  'database backup written': (e) => `günün yedeği alındı: ${text(e.file)}`,
  'database backup failed': () => 'günün yedeği alınamadı',
  'database backup copied to BACKUP_DIR': (e) => `yedek BACKUP_DIR'a da kopyalandı: ${text(e.file)}`,
  'database backup copy to BACKUP_DIR failed, trying again in an hour': (e) =>
    `yedek BACKUP_DIR'a kopyalanamadı, bir saat sonra yine denerim (${text(e.dir)})`,
  'upload directory unavailable, /uploads is not served': (e) =>
    `fotoğraf klasörü açılamadı, kanıt fotoğrafları bu açılışta çalışmaz (${text(e.uploadDir)})`,
  'request failed': (e) => `istek patladı: ${requestLine(e)}`,
  'slow request': (e) => `yavaş istek: ${requestLine(e)}`,
  'unhandled error': () => 'beklenmedik hata',
};

/** Anything without a Turkish line: the message, then whatever else it carried as k=v. */
function fallbackLine(msg: string, entry: Entry): string {
  const extras = Object.entries(entry)
    .filter(([key, value]) => !NOISE.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${text(value)}`);
  if (entry.err !== undefined) extras.push(`err=${errorMessage(entry.err)}`);
  return [msg, ...extras].filter(Boolean).join(' ');
}

/** The entry's first line, without the time; null for nothing to say. */
function headLine(msg: string, entry: Entry): string | null {
  // own keys only: a message that happens to read "constructor" is not a renderer
  const known = Object.hasOwn(MESSAGES, msg) ? MESSAGES[msg] : undefined;
  if (known) {
    const line = known(entry);
    return line !== null && entry.err !== undefined ? `${line}: ${errorMessage(entry.err)}` : line;
  }
  // Fastify's own, one per interface on 0.0.0.0: the home Wi-Fi address shows up here
  const listening = /^Server listening at (\S+)$/.exec(msg);
  if (listening) return `şu adreste dinliyor: ${listening[1]}`;
  if (msg.startsWith('YENİ ŞİKAYET')) {
    return `YENİ ŞİKAYET: @${text(entry.reporter)}, @${text(entry.reported)} hakkında: "${text(entry.reason)}" (hepsi: npm run yonet -- sikayetler)`;
  }
  return fallbackLine(msg, entry);
}

/** The head line, and under an error the frames of its stack. */
function render(entry: Entry, level: number): string | null {
  const line = headLine(typeof entry.msg === 'string' ? oneLine(entry.msg) : '', entry);
  if (line === null || level < ERROR) return line;
  const frames = stackFrames(entry.err, level >= FATAL);
  return [line, ...frames.map((frame) => `${INDENT}${frame}`)].join('\n');
}

function glyph(level: number): string {
  if (level >= ERROR) return '✗';
  if (level >= WARN) return '!';
  return '•';
}

function timeOf(entry: Entry): Date {
  const at = typeof entry.time === 'number' || typeof entry.time === 'string' ? new Date(entry.time) : new Date();
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

/** HH:mm:ss in Istanbul, like every other time the owner reads (npm run yonet). */
function clock(at: Date): string {
  // every zone's offset is whole minutes, so the seconds are the same everywhere
  return `${localTimeHHmm(at, DEFAULT_TIMEZONE)}:${String(at.getUTCSeconds()).padStart(2, '0')}`;
}

function parse(line: string): Entry | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Entry) : null;
  } catch {
    return null;
  }
}

/**
 * A pino destination (`buildApp({ logStream })`) that writes the Turkish lines to
 * `out`. A day's first line is preceded by its date: a window left open for a week
 * would otherwise show seven 21:00s and no way to tell them apart. Anything that is
 * not a pino entry goes through as it came.
 */
export function ownerLogStream(out: LineSink = process.stdout): { write(chunk: string): void } {
  let day: string | null = null;
  return {
    write(chunk: string): void {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        const entry = parse(line);
        if (!entry) {
          out.write(`${line}\n`);
          continue;
        }
        const level = typeof entry.level === 'number' ? entry.level : 30;
        const body = render(entry, level);
        if (body === null) continue;
        const at = timeOf(entry);
        const today = dayKeyInTz(at, DEFAULT_TIMEZONE);
        const header = today === day ? '' : `── ${today} ──\n`;
        day = today;
        // one write per entry, so a stack never ends up split around another line
        out.write(`${header}${clock(at)} ${glyph(level)} ${body}\n`);
      }
    },
  };
}
