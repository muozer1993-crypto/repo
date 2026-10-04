/**
 * The owner's window (src/log.ts): pino's JSON turned into one Turkish line with
 * the Istanbul time, nothing for a pass that did nothing, the frames of an error's
 * stack, a date line when the day turns, and anything it does not know printed as
 * it came — and only for a console; a pipe or LOG_FORMAT=json keeps the JSON.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ownerLogStream, wantsReadableLogs } from '../src/log.js';

/** 2026-10-04 18:03:12 UTC: 21:03:12 in Istanbul. */
const AT = Date.UTC(2026, 9, 4, 18, 3, 12);

function capture(): { stream: ReturnType<typeof ownerLogStream>; output: () => string; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = ownerLogStream({ write: (text) => chunks.push(text) });
  const output = (): string => chunks.join('');
  return { stream, output, lines: () => output().split('\n').filter(Boolean) };
}

/** One line the way pino writes it. */
function pino(fields: Record<string, unknown>, time = AT): string {
  return `${JSON.stringify({ level: 30, time, pid: 4242, hostname: 'ev-pc', ...fields })}\n`;
}

describe('ownerLogStream', () => {
  it('prints the startup line under the date, with the Istanbul time', () => {
    const { stream, output } = capture();
    stream.write(
      pino({
        port: 4000,
        host: '0.0.0.0',
        publicUrl: 'https://tatli-koydum.trycloudflare.com',
        db: 'data/koydum.db',
        msg: 'KOYDUM sunucusu ayakta',
      }),
    );
    expect(output()).toBe(
      '── 2026-10-04 ──\n' +
        '21:03:12 • KOYDUM sunucusu ayakta: port 4000, davet adresi https://tatli-koydum.trycloudflare.com, veritabanı data/koydum.db\n',
    );
  });

  it('leaves out an address nobody else can use, and names a host that is not every interface', () => {
    const { stream, lines } = capture();
    stream.write(pino({ port: 4001, host: '127.0.0.1', db: 'data/koydum.db', msg: 'KOYDUM sunucusu ayakta' }));
    stream.write(pino({ msg: 'Server listening at http://192.168.1.20:4000' }));
    expect(lines().slice(1)).toEqual([
      '21:03:12 • KOYDUM sunucusu ayakta: 127.0.0.1:4001, veritabanı data/koydum.db',
      '21:03:12 • şu adreste dinliyor: http://192.168.1.20:4000',
    ]);
  });

  it('says what a scheduler pass did and skips one that did nothing', () => {
    const { stream, lines } = capture();
    const pass = {
      activated: 0,
      disputes: 0,
      finalized: 0,
      cancelled: 0,
      reminders: 0,
      nudges: 0,
      recaps: 0,
      tauntFollowups: 0,
      msg: 'scheduler pass',
    };
    stream.write(pino(pass));
    expect(lines()).toEqual([]);

    stream.write(pino({ ...pass, activated: 1, finalized: 2, reminders: 3, tauntFollowups: 1 }));
    expect(lines()).toEqual([
      '── 2026-10-04 ──',
      '21:03:12 • zamanlayıcı: 1 çelınc başladı, 2 çelınc bitti, 3 günlük hatırlatma, 1 kazanana "hadi koy" hatırlatması',
    ]);
  });

  it('counts the pushes that went and the ones that did not', () => {
    const { stream, lines } = capture();
    stream.write(pino({ sent: 4, failed: 1, msg: 'push flush' }));
    stream.write(pino({ sent: 3, failed: 0, msg: 'push flush' }));
    stream.write(pino({ sent: 0, failed: 2, msg: 'push flush' }));
    expect(lines().slice(1)).toEqual([
      '21:03:12 • push: 4 bildirim gitti, 1 tanesi gitmedi',
      '21:03:12 • push: 3 bildirim gitti',
      '21:03:12 • push: 2 bildirim gitmedi',
    ]);
  });

  it('marks a failed request and a slow one as warnings', () => {
    const { stream, lines } = capture();
    stream.write(pino({ level: 40, reqId: 'req-7', method: 'POST', url: '/challenges', statusCode: 500, ms: 812, msg: 'request failed' }));
    stream.write(pino({ level: 40, reqId: 'req-8', method: 'GET', url: '/me/inbox', statusCode: 200, ms: 2412, msg: 'slow request' }));
    expect(lines().slice(1)).toEqual([
      '21:03:12 ! istek patladı: POST /challenges → 500 (812 ms)',
      '21:03:12 ! yavaş istek: GET /me/inbox → 200 (2412 ms)',
    ]);
  });

  it('puts three frames of an error under it, and the whole stack under a crash', () => {
    const stack = ['Error: kaboom', ...Array.from({ length: 6 }, (_, i) => `    at frame${i} (/koydum/src/x.ts:${i}:1)`)].join('\n');
    const err = { type: 'Error', message: 'kaboom', stack };
    const { stream, lines } = capture();
    stream.write(pino({ level: 50, reqId: 'req-1', err, msg: 'unhandled error' }));
    expect(lines().slice(1)).toEqual([
      '21:03:12 ✗ beklenmedik hata: kaboom',
      '           at frame0 (/koydum/src/x.ts:0:1)',
      '           at frame1 (/koydum/src/x.ts:1:1)',
      '           at frame2 (/koydum/src/x.ts:2:1)',
    ]);

    const crash = capture();
    crash.stream.write(pino({ level: 60, err, msg: 'uncaught exception' }));
    expect(crash.lines()[1]).toBe('21:03:12 ✗ sunucu çöktü: kaboom');
    expect(crash.lines()).toHaveLength(2 + 6);
  });

  it('prints a message it does not know with the rest of the entry as k=v', () => {
    const { stream, lines } = capture();
    stream.write(pino({ level: 40, reqId: 'req-3', step: 'finalize', count: 3, extra: { a: 1 }, err: { message: 'disk full' }, msg: 'something new' }));
    expect(lines()[1]).toBe('21:03:12 ! something new step=finalize count=3 extra={"a":1} err=disk full');
  });

  it('keeps a report on one line, without the escape codes a friend typed into it', () => {
    const { stream, lines } = capture();
    stream.write(
      pino({
        level: 40,
        reporter: 'ali',
        reported: 'veli',
        reason: 'küfür ediyor\nsahte satır \u001b[2J',
        msg: 'YENİ ŞİKAYET (npm run yonet -- sikayetler)',
      }),
    );
    expect(lines().slice(1)).toEqual([
      '21:03:12 ! YENİ ŞİKAYET: @ali, @veli hakkında: "küfür ediyor sahte satır [2J" (hepsi: npm run yonet -- sikayetler)',
    ]);
  });

  it('passes a line that is not pino JSON through unchanged', () => {
    const { stream, output } = capture();
    stream.write('düz bir satır, JSON değil\n');
    expect(output()).toBe('düz bir satır, JSON değil\n');
  });

  it('dates the first line of each Istanbul day, not every line', () => {
    const { stream, lines } = capture();
    // 23:59:59 UTC on the 4th is already 02:59:59 on the 5th in Istanbul
    stream.write(pino({ file: 'data/backups/koydum-2026-10-05.db', msg: 'database backup written' }, Date.UTC(2026, 9, 4, 23, 59, 59)));
    stream.write(pino({ reason: 'SIGINT', msg: 'shutting down' }, Date.UTC(2026, 9, 5, 0, 0, 5)));
    expect(lines()).toEqual([
      '── 2026-10-05 ──',
      '02:59:59 • günün yedeği alındı: data/backups/koydum-2026-10-05.db',
      '03:00:05 • sunucu kapanıyor (Ctrl+C)',
    ]);
  });

  it('turns the real lines of a failing request into Turkish', async () => {
    const { stream, lines } = capture();
    const built = await buildApp({
      config: {
        dataDir: ':memory:',
        dbPath: ':memory:',
        jwtSecret: 'test-secret-koydum',
        logLevel: 'info',
        publicUrl: 'http://test.local',
      },
      logStream: stream,
    });
    built.app.get('/patlat', async () => {
      throw new Error('kaboom');
    });
    try {
      await built.app.ready();
      expect((await built.app.inject({ method: 'GET', url: '/patlat?kod=GIZLI123' })).statusCode).toBe(500);
      const logged = lines().filter((line) => !line.startsWith('──'));
      expect(logged[0]).toMatch(/^\d\d:\d\d:\d\d ✗ beklenmedik hata: kaboom$/);
      expect(logged.slice(1, 4).every((line) => line.startsWith('           at '))).toBe(true);
      expect(logged[4]).toMatch(/^\d\d:\d\d:\d\d ! istek patladı: GET \/patlat → 500 \(\d+ ms\)$/);
      expect(lines().join('\n')).not.toContain('GIZLI123');
    } finally {
      await built.app.close();
    }
  });
});

describe('wantsReadableLogs', () => {
  it('is on for a console only, and LOG_FORMAT=json turns it off there too', () => {
    expect(wantsReadableLogs({}, { isTTY: true })).toBe(true);
    expect(wantsReadableLogs({ LOG_FORMAT: '' }, { isTTY: true })).toBe(true);
    expect(wantsReadableLogs({}, { isTTY: false })).toBe(false);
    expect(wantsReadableLogs({}, {})).toBe(false);
    expect(wantsReadableLogs({ LOG_FORMAT: 'json' }, { isTTY: true })).toBe(false);
    expect(wantsReadableLogs({ LOG_FORMAT: ' JSON ' }, { isTTY: true })).toBe(false);
  });
});
