import AsyncStorage from '@react-native-async-storage/async-storage';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useAddEntry, type AddEntryResult, type AddEntryVariables } from '@/hooks/queries';
import { ApiError, type ApiClient } from '@/lib/api';
import { StorageKeys, removeItem, setJson } from '@/lib/storage';
import { enqueueEntry, flushQueue, readQueue, type PendingEntry } from '@/services/offlineQueue';

/**
 * Every change to the offline queue reads the whole list and writes it back.
 * On a phone AsyncStorage answers each call from its native thread, one at a
 * time, so a glass tapped while a flush is sending the one parked before it
 * runs its read and write between the flush's. The stock jest mock answers
 * within the same tick, which is why the queue's own tests never saw a glass
 * told "Sıraya alındı" vanish.
 */

const mockApi: { client: ApiClient | null } = { client: null };
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  // the mutation's options come straight back, so the test calls its own function
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({
    getQueryData: () => undefined,
    getQueriesData: () => [],
    invalidateQueries: async () => {},
  }),
}));
jest.mock('@/hooks/useApi', () => ({ useApi: () => mockApi.client }));
jest.mock('@/services/reminders', () => ({ refreshReminders: async () => 0, clearReminders: async () => {} }));

/** AsyncStorage as the native module answers it: one call at a time, in order, each a macrotask away. */
function nativeLikeStorage(): void {
  const store = new Map<string, string>([[StorageKeys.me, JSON.stringify({ id: 'u1' })]]);
  const waiting: (() => void)[] = [];
  const next = () => {
    waiting.shift()?.();
    if (waiting.length > 0) setImmediate(next);
  };
  const op = <T>(run: () => T) =>
    new Promise<T>((resolve) => {
      waiting.push(() => resolve(run()));
      if (waiting.length === 1) setImmediate(next);
    });
  // The stock mock's methods are jest.fn already: this replaces their
  // implementation for the whole file, and every test starts with a fresh map.
  jest.mocked(AsyncStorage.getItem).mockImplementation((key: string) => op(() => store.get(key) ?? null));
  jest.mocked(AsyncStorage.setItem).mockImplementation((key: string, value: string) =>
    op(() => {
      store.set(key, value);
    })
  );
  jest.mocked(AsyncStorage.removeItem).mockImplementation((key: string) =>
    op(() => {
      store.delete(key);
    })
  );
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await tick();
}

interface Answer {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function answer(): Answer {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const noSignal = () => new ApiError('network', 'Sunucuya ulaşamadım.', 0);
const landed = { entry: { id: 'e1' }, standings: [] };

const glass = (sessionId: string, clientTime: string) => ({
  dayKey: '2026-11-16',
  value: 1,
  source: 'manual',
  clientTime,
  sessionId,
});
const sessions = (queue: PendingEntry[]) => queue.map((item) => item.body.sessionId);

/** A server whose answer to each entry (by its sessionId) the test gives when it likes. */
function heldServer() {
  const posts = new Map<string, Answer>();
  const client = {
    addEntry: (_challengeId: string, body: { sessionId?: string }) => {
      const reply = answer();
      posts.set(body.sessionId ?? '', reply);
      return reply.promise;
    },
  } as unknown as ApiClient;
  return { posts, client };
}

/** "+1" on the water çelınc (or a day's answer elsewhere), through the hook the entry screen uses. */
function tapper(
  client: ApiClient,
  challengeId = 'su',
  append = true
): (variables: AddEntryVariables) => Promise<AddEntryResult> {
  mockApi.client = client;
  const hook: { mutationFn?: (variables: AddEntryVariables) => Promise<AddEntryResult> } = {};
  function Probe() {
    Object.assign(hook, useAddEntry(challengeId, { append }));
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(createElement(Probe));
  });
  act(() => {
    tree.unmount();
  });
  const { mutationFn } = hook;
  if (!mutationFn) throw new Error('useAddEntry gave no mutation');
  return mutationFn;
}

/**
 * Glass A parked in the metro; the signal comes back, the drain sends A and
 * the friend taps glass B, both requests still waiting for their answer.
 */
async function bothInFlight() {
  const { posts, client } = heldServer();
  const tap = tapper(client);
  const A = glass('A', '2026-11-16T08:00:00.000Z');
  await enqueueEntry('su', A, `su:${A.dayKey}:manual:A:${A.clientTime}`);
  const flush = flushQueue(client);
  await ticks(20);
  const tapped = tap(glass('B', '2026-11-16T08:05:00.000Z'));
  await ticks(20);
  expect([...posts.keys()].sort()).toEqual(['A', 'B']);
  return { posts, flush, tapped };
}

/** Both the order and a few storage calls apart: the gap a dropped connection leaves. */
const WINDOW = [0, 1, 2, 3, 4].flatMap((apart) => [
  { first: 'B', second: 'A', apart },
  { first: 'A', second: 'B', apart },
]);

beforeEach(() => {
  nativeLikeStorage();
});

describe('a glass tapped while the flush sends the one parked before it', () => {
  it.each(WINDOW)(
    'keeps both when the signal drops under them ($first fails first, $apart storage calls apart)',
    async ({ first, second, apart }) => {
      const { posts, flush, tapped } = await bothInFlight();
      posts.get(first)?.reject(noSignal());
      await ticks(apart);
      posts.get(second)?.reject(noSignal());

      // the friend was told "Sıraya alındı"
      expect((await tapped).queued).toBe(true);
      expect(await flush).toMatchObject({ sent: 0 });
      expect(sessions(await readQueue()).sort()).toEqual(['A', 'B']);
    }
  );

  it.each(WINDOW)(
    'keeps the tapped one when the parked one lands as the signal drops ($first answered first, $apart storage calls apart)',
    async ({ first, second, apart }) => {
      const { posts, flush, tapped } = await bothInFlight();
      const answerFor = (session: string) =>
        session === 'A' ? posts.get('A')?.resolve(landed) : posts.get('B')?.reject(noSignal());
      answerFor(first);
      await ticks(apart);
      answerFor(second);

      expect((await tapped).queued).toBe(true);
      expect(await flush).toMatchObject({ sent: 1 });
      expect(sessions(await readQueue())).toEqual(['B']);
    }
  );
});

describe('two entries parked at the same moment', () => {
  it('keeps both, oldest first', async () => {
    const A = glass('A', '2026-11-16T08:00:00.000Z');
    const B = glass('B', '2026-11-16T08:00:01.000Z');
    await Promise.all([enqueueEntry('su', A, 'su:A'), enqueueEntry('su', B, 'su:B')]);
    expect(sessions(await readQueue())).toEqual(['A', 'B']);
  });
});

/**
 * A server keeping one value a day, the last write winning (upsertDayEntry):
 * each request reaches it the moment it is made, and its answer comes back
 * when the test says. After `answerAll` every answer comes at once.
 */
function dayServer() {
  const days = new Map<string, number>();
  const sent: number[] = [];
  const waiting: Answer[] = [];
  let answerNow: unknown = null;
  const client = {
    addEntry: (_challengeId: string, body: { dayKey: string; value: number }) => {
      days.set(body.dayKey, body.value);
      sent.push(body.value);
      if (answerNow) return Promise.resolve(answerNow);
      const reply = answer();
      waiting.push(reply);
      return reply.promise;
    },
  } as unknown as ApiClient;
  const answerAll = (value: unknown) => {
    answerNow = value;
    for (const reply of waiting.splice(0)) reply.resolve(value);
  };
  return { days, sent, waiting, client, answerAll };
}

const DAY = '2026-11-15';
// "Yaptım" tapped in the metro and parked; above ground she puts it right to "Yapmadım"
const didIt = { dayKey: DAY, value: 1, source: 'manual', clientTime: '2026-11-16T07:00:00.000Z' };
const didNot = { ...didIt, value: 0, clientTime: '2026-11-16T07:10:00.000Z' };
const dayId = `spor:${DAY}:manual:`;
const values = (queue: PendingEntry[]) => queue.map((item) => [item.body.dayKey, item.body.value]);

describe("a day's parked copy while her own write of that day is on its way", () => {
  it('is not sent by a drain that starts meanwhile, so the day keeps the newer value', async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);
    await enqueueEntry('spor', didIt, dayId);

    const written = write(didNot);
    await ticks(20);
    // the app comes to the front: the drain finds "Yaptım" still parked
    const flush = flushQueue(server.client);
    await ticks(20);
    server.answerAll(landed);

    expect((await written).queued).toBe(false);
    await flush;
    await ticks(20);
    expect(server.sent).toEqual([0]);
    expect(server.days.get(DAY)).toBe(0);
    expect(await readQueue()).toEqual([]);
  });

  it('is skipped when a drain busy with an earlier one reaches it', async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);
    await enqueueEntry('spor', { ...didIt, dayKey: '2026-11-14' }, 'spor:2026-11-14:manual:');
    await enqueueEntry('spor', didIt, dayId);

    const flush = flushQueue(server.client);
    await ticks(20);
    expect(server.sent).toEqual([1]);
    const written = write(didNot);
    await ticks(20);
    // the earlier day lands, and the drain moves on to hers
    server.waiting[0]?.resolve(landed);
    await ticks(20);
    server.waiting[1]?.resolve(landed);
    expect((await written).queued).toBe(false);
    server.answerAll(landed);
    await flush;
    await ticks(20);

    expect(server.sent).toEqual([1, 0]);
    expect(server.days.get(DAY)).toBe(0);
    expect(await readQueue()).toEqual([]);
  });

  it('gives way to the newer value parked when her write finds no signal', async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);
    await enqueueEntry('spor', didIt, dayId);

    const written = write(didNot);
    await ticks(20);
    const flush = flushQueue(server.client);
    await ticks(20);
    server.waiting[0]?.reject(noSignal());
    expect((await written).queued).toBe(true);
    expect(values(await readQueue())).toEqual([[DAY, 0]]);
    server.answerAll(landed);
    await flush;

    // let go once parked: the next drain sends the newer value
    expect(await flushQueue(server.client)).toMatchObject({ sent: 1, remaining: 0 });
    expect(server.sent).toEqual([0, 0]);
    expect(server.days.get(DAY)).toBe(0);
    expect(await readQueue()).toEqual([]);
  });

  it('goes as before once her write is refused', async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);
    await enqueueEntry('spor', didIt, dayId);

    const written = write(didNot);
    await ticks(20);
    server.waiting[0]?.reject(new ApiError('validation', 'Gönderdiğin bilgiler geçersiz.', 400));
    await expect(written).rejects.toThrow('Gönderdiğin bilgiler geçersiz.');
    server.answerAll(landed);

    expect(await flushQueue(server.client)).toMatchObject({ sent: 1, remaining: 0 });
    expect(server.sent).toEqual([0, 1]);
    expect(await readQueue()).toEqual([]);
  });

  it('stays held while a second write of the day is out after the first one parked', async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);

    const first = write(didIt);
    await ticks(20);
    const second = write(didNot);
    await ticks(20);
    server.waiting[0]?.reject(noSignal());
    expect((await first).queued).toBe(true);
    // the first parked "Yaptım" while "Yapmadım" is still on its way
    const flush = flushQueue(server.client);
    await ticks(20);
    server.answerAll(landed);
    expect((await second).queued).toBe(false);
    await flush;
    await ticks(20);

    expect(server.sent).toEqual([1, 0]);
    expect(server.days.get(DAY)).toBe(0);
    expect(await readQueue()).toEqual([]);
  });
});

/** Who is logged in on the phone changes while her write is out: the form closed, the write runs on. */
const signOut = () => removeItem(StorageKeys.me);
const signIn = (id: string) => setJson(StorageKeys.me, { id });

describe('an entry still on its way when the account logs out', () => {
  it('parks under the account that tapped, and waits for her rather than going up as the next one', async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);

    const written = write(didIt);
    await ticks(20);
    await signOut();
    server.waiting[0]?.reject(noSignal());
    expect((await written).queued).toBe(true);
    expect((await readQueue()).map((item) => [item.id, item.ownerId])).toEqual([[`u1/${dayId}`, 'u1']]);

    // Veli signs in on the same phone: his drain leaves her day alone
    await signIn('u2');
    server.answerAll(landed);
    expect(await flushQueue(server.client)).toMatchObject({ sent: 0, remaining: 0 });
    expect(server.sent).toEqual([1]);
    // she signs back in: it goes as hers
    await signIn('u1');
    expect(await flushQueue(server.client)).toMatchObject({ sent: 1, remaining: 0 });
    expect(await readQueue()).toEqual([]);
  });

  it('spends her parked copy of the day when her correction lands after the logout', async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);
    await enqueueEntry('spor', didIt, dayId);

    const written = write(didNot);
    await ticks(20);
    await signOut();
    server.answerAll(landed);
    expect((await written).queued).toBe(false);
    await ticks(20);
    expect(await readQueue()).toEqual([]);

    // her next sign-in has nothing older to put back over "Yapmadım"
    await signIn('u1');
    expect(await flushQueue(server.client)).toMatchObject({ sent: 0 });
    expect(server.sent).toEqual([0]);
    expect(server.days.get(DAY)).toBe(0);
  });

  it("does not drain the next account's parked entries with her token", async () => {
    const server = dayServer();
    const write = tapper(server.client, 'spor', false);

    const written = write(didNot);
    await ticks(20);
    await signOut();
    await signIn('u2');
    await enqueueEntry('kitap', didIt, `kitap:${DAY}:manual:`);
    server.answerAll(landed);
    expect((await written).queued).toBe(false);
    await ticks(40);

    // only her own write went up with her client; Veli's day waits for his
    expect(server.sent).toEqual([0]);
    expect((await readQueue()).map((item) => item.ownerId)).toEqual(['u2']);
  });
});
