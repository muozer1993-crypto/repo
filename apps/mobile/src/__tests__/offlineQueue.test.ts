import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiClient, ApiError } from '@/lib/api';
import { StorageKeys, setJson } from '@/lib/storage';
import {
  clearFailed,
  dropParked,
  enqueueEntry,
  flushQueue,
  pendingForChallenge,
  readQueue,
  removeFromQueue,
} from '@/services/offlineQueue';

const body = (dayKey: string, value: number) => ({
  dayKey,
  value,
  source: 'manual',
  clientTime: '2026-09-08T10:00:00.000Z',
});

function fakeClient(addEntry: jest.Mock, extra: { uploadPhoto?: jest.Mock; health?: jest.Mock } = {}) {
  return { addEntry, ...extra } as unknown as Parameters<typeof flushQueue>[0];
}

describe('offline entry queue', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('keeps entries in order and finds them per challenge', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await enqueueEntry('c2', body('2026-09-08', 5), 'b');
    expect((await readQueue()).map((item) => item.id)).toEqual(['a', 'b']);
    expect((await pendingForChallenge('c1')).map((item) => item.id)).toEqual(['a']);
  });

  it('a corrected value for the same day (same id) replaces the one still waiting', async () => {
    // the id is how the caller says "this is the same write": upsert metrics key it
    // by challenge, day and source
    await enqueueEntry('c1', body('2026-09-08', 3), 'c1:2026-09-08:manual:');
    await enqueueEntry('c1', body('2026-09-08', 7), 'c1:2026-09-08:manual:');
    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].body.value).toBe(7);
  });

  it('two appended entries for the same day (different ids) both survive', async () => {
    // manual_count adds up: a second glass of water is not a correction of the first
    await enqueueEntry('c1', body('2026-09-08', 1), 'c1:2026-09-08:manual::2026-09-08T10:00:00.000Z');
    await enqueueEntry('c1', body('2026-09-08', 1), 'c1:2026-09-08:manual::2026-09-08T10:20:00.000Z');
    expect(await readQueue()).toHaveLength(2);
  });

  it('sends everything when the server is reachable', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await enqueueEntry('c1', body('2026-09-07', 4), 'b');
    const addEntry = jest.fn().mockResolvedValue({});
    const result = await flushQueue(fakeClient(addEntry));
    expect(addEntry).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 2, dropped: 0, remaining: 0 });
    expect(await readQueue()).toEqual([]);
  });

  it('stops at the first network error and keeps the rest', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await enqueueEntry('c1', body('2026-09-07', 4), 'b');
    const addEntry = jest
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Sunucuya ulaşamadım.', 0));
    const result = await flushQueue(fakeClient(addEntry));
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it('marks a rejected entry as failed instead of retrying forever', async () => {
    await enqueueEntry('c1', body('2026-08-01', 3), 'a');
    const addEntry = jest
      .fn()
      .mockRejectedValue(new ApiError('day_out_of_range', 'O gün çelıncın dışında.', 400));
    const result = await flushQueue(fakeClient(addEntry));
    expect(result).toMatchObject({ sent: 0, dropped: 1, remaining: 0 });
    const queue = await readQueue();
    expect(queue[0].failedReason).toBe('O gün çelıncın dışında.');

    // a failed item is never retried
    const second = await flushQueue(fakeClient(addEntry));
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(second.sent).toBe(0);

    await clearFailed();
    expect(await readQueue()).toEqual([]);
  });

  it('says a check-in that reached the server only the next day was lost to the wait, not to the friend', async () => {
    await enqueueEntry('c1', { ...body('2026-09-07', 1), source: 'checkin' }, 'c1:2026-09-07:checkin:');
    const addEntry = jest
      .fn()
      .mockRejectedValue(new ApiError('checkin_today_only', 'Check-in sadece bugün için yapılır.', 400));
    expect(await flushQueue(fakeClient(addEntry))).toMatchObject({ sent: 0, dropped: 1 });
    expect((await readQueue())[0].failedReason).toBe('Check-in sunucuya ulaşamadan gün bitti, o gün sayılmadı.');
  });

  it('keeps everything when the session ended, for the next sign-in', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await enqueueEntry('c1', body('2026-09-07', 4), 'b');
    const addEntry = jest
      .fn()
      .mockRejectedValueOnce(new ApiError('unauthorized', 'Şifren değişti, bu telefondaki oturum kapandı.', 401));
    const result = await flushQueue(fakeClient(addEntry));
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: 0, dropped: 0, remaining: 2 });
    const queue = await readQueue();
    expect(queue.map((item) => [item.failedReason, item.attempts])).toEqual([
      [undefined, 0],
      [undefined, 0],
    ]);

    // signed in again: both go up
    addEntry.mockResolvedValue({});
    expect(await flushQueue(fakeClient(addEntry))).toMatchObject({ sent: 2, remaining: 0 });
  });

  it("waits out the server's full disk without spending a try, and stops there", async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await enqueueEntry('c1', body('2026-09-07', 4), 'b');
    const addEntry = jest
      .fn()
      .mockRejectedValue(
        new ApiError(
          'disk_full',
          'Sunucunun diski doldu, şimdilik hiçbir şey kaydedilemiyor. Sunucuyu açan kankana haber ver.',
          507
        )
      );
    const client = fakeClient(addEntry);

    // every foreground and saved entry flushes: a day of a full disk is many more than eight
    for (let run = 0; run < 12; run += 1) {
      expect(await flushQueue(client)).toEqual({ sent: 0, dropped: 0, remaining: 2 });
    }
    // the entry behind it would only have been refused the same way
    expect(addEntry).toHaveBeenCalledTimes(12);
    const queue = await readQueue();
    expect(queue.map((item) => [item.id, item.attempts, item.failedReason])).toEqual([
      ['a', 0, undefined],
      ['b', 0, undefined],
    ]);
  });

  it('still spends a try on a server that fails some other way', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    const addEntry = jest
      .fn()
      .mockRejectedValue(new ApiError('internal', 'Sunucuda bir şeyler ters gitti. Birazdan tekrar dene.', 500));
    await flushQueue(fakeClient(addEntry));
    const [item] = await readQueue();
    expect(item?.attempts).toBe(1);
  });

  it('removes a single item', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await removeFromQueue('a');
    expect(await readQueue()).toEqual([]);
  });

  it('never sends the same parked entry twice when two flushes overlap', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await enqueueEntry('c1', body('2026-09-07', 4), 'b');
    // the flush is fired and forgotten from three places at once (a successful
    // write, mount, foreground): a second pass must not replay the first one
    const addEntry = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 5))
    );
    const client = fakeClient(addEntry);
    const [first, second] = await Promise.all([flushQueue(client), flushQueue(client)]);
    expect(addEntry).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(await readQueue()).toEqual([]);
  });

  it('does nothing on an empty queue', async () => {
    const addEntry = jest.fn();
    expect(await flushQueue(fakeClient(addEntry))).toEqual({ sent: 0, dropped: 0, remaining: 0 });
    expect(addEntry).not.toHaveBeenCalled();
  });
});

describe('an entry parked with a photo still on the phone', () => {
  // the image picker's cache file, as the entry modal hands it over
  const PHOTO = 'file:///data/user/0/com.koydum.app/cache/ImagePicker/abc.jpeg';
  const NETWORK = () => new ApiError('network', 'Sunucuya ulaşamadım.', 0);

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('uploads the photo first and posts the entry with its server path', async () => {
    await enqueueEntry('c1', body('2026-09-08', 5), 'a', PHOTO);
    const uploadPhoto = jest.fn().mockResolvedValue({ url: '/uploads/p1.jpg' });
    const addEntry = jest.fn().mockResolvedValue({});
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto }));

    // the picker's own name, so a png is not sent as a jpeg
    expect(uploadPhoto).toHaveBeenCalledWith(PHOTO, 'abc.jpeg');
    expect(addEntry).toHaveBeenCalledWith('c1', { ...body('2026-09-08', 5), proofUrl: '/uploads/p1.jpg' });
    // the phone-side path never reaches the server
    expect(JSON.stringify(addEntry.mock.calls[0])).not.toContain('file://');
    expect(result).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(await readQueue()).toEqual([]);
  });

  it('stays parked with its photo while there is no connection', async () => {
    await enqueueEntry('c1', body('2026-09-08', 5), 'a', PHOTO);
    const uploadPhoto = jest.fn().mockRejectedValue(NETWORK());
    const health = jest.fn().mockRejectedValue(NETWORK());
    const addEntry = jest.fn();
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto, health }));

    expect(addEntry).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    const [item] = await readQueue();
    expect(item?.proofLocalUri).toBe(PHOTO);
    expect(item?.body.proofUrl).toBeUndefined();
    expect(item?.failedReason).toBeUndefined();
  });

  it('keeps the uploaded path when the entry itself does not get through, so the photo goes up once', async () => {
    await enqueueEntry('c1', body('2026-09-08', 5), 'a', PHOTO);
    const uploadPhoto = jest.fn().mockResolvedValue({ url: '/uploads/p1.jpg' });
    const addEntry = jest.fn().mockRejectedValueOnce(NETWORK()).mockResolvedValue({});
    const client = fakeClient(addEntry, { uploadPhoto });

    expect(await flushQueue(client)).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    const [item] = await readQueue();
    expect(item?.body.proofUrl).toBe('/uploads/p1.jpg');
    expect(item?.proofLocalUri).toBeUndefined();

    expect(await flushQueue(client)).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(uploadPhoto).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenLastCalledWith('c1', { ...body('2026-09-08', 5), proofUrl: '/uploads/p1.jpg' });
  });

  it('drops a photo the server refuses and lets the entry go on its own', async () => {
    await enqueueEntry('c1', body('2026-09-08', 5), 'a', PHOTO);
    const uploadPhoto = jest
      .fn()
      .mockRejectedValue(new ApiError('file_too_large', 'Dosya çok büyük (en fazla 5 MB).', 413));
    const addEntry = jest.fn().mockResolvedValue({});
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto }));

    // an optional photo: the count is what matters
    expect(addEntry).toHaveBeenCalledWith('c1', body('2026-09-08', 5));
    expect(result).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it('says what happened to the photo when a çelınc that requires one refuses the entry without it', async () => {
    await enqueueEntry('c1', body('2026-09-08', 5), 'a', PHOTO);
    // the OS cleared the picker's cache: React Native fails that form like a
    // request with no signal, while the server answers /health just fine
    const uploadPhoto = jest.fn().mockRejectedValue(NETWORK());
    const health = jest.fn().mockResolvedValue({ ok: true });
    const addEntry = jest
      .fn()
      .mockRejectedValue(new ApiError('proof_required', 'Bu çelıncta kanıt fotoğrafı zorunlu.', 400));
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto, health }));

    // one more try before calling the file gone
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
    expect(addEntry).toHaveBeenCalledWith('c1', body('2026-09-08', 5));
    expect(result).toEqual({ sent: 0, dropped: 1, remaining: 0 });
    const [item] = await readQueue();
    expect(item?.failedReason).toBe('Kanıt fotoğrafı telefonda bulunamadı. Bu çelıncta kanıt fotoğrafı zorunlu.');
    expect(item?.proofLocalUri).toBeUndefined();

    // told once, never retried
    await flushQueue(fakeClient(addEntry, { uploadPhoto, health }));
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
  });

  it('waits out the hourly photo limit instead of dropping anything', async () => {
    await enqueueEntry('c1', body('2026-09-08', 5), 'a', PHOTO);
    const uploadPhoto = jest
      .fn()
      .mockRejectedValue(new ApiError('upload_limit', 'Bu saatlik fotoğraf hakkın doldu.', 429));
    const addEntry = jest.fn();
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto }));

    expect(addEntry).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    const [item] = await readQueue();
    expect(item?.proofLocalUri).toBe(PHOTO);
    // a wait the server named, not a try toward giving up
    expect(item?.attempts).toBe(0);
    expect(item?.photoHeldSince).toEqual(expect.any(String));
  });
});

describe('a photo the server holds back for a while', () => {
  const PHOTO = 'file:///data/user/0/com.koydum.app/cache/ImagePicker/abc.jpeg';
  const DISK_FULL = 'Sunucunun diski dolmak üzere, şimdilik fotoğraf alınmıyor. Sunucuyu açan kankana haber ver.';
  const diskFull = () => new ApiError('disk_full', DISK_FULL, 507);

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  /** As if the server had first held the photo back `ms` ago. */
  async function heldFor(ms: number): Promise<void> {
    const since = new Date(Date.now() - ms).toISOString();
    await setJson(
      'koydum.pendingEntries',
      (await readQueue()).map((item) => ({ ...item, photoHeldSince: since }))
    );
  }

  it('keeps the entry and its photo however many flushes run on a nearly full disk', async () => {
    await enqueueEntry('cA', body('2026-09-08', 30), 'a', PHOTO);
    await enqueueEntry('cB', body('2026-09-08', 7), 'b');
    const uploadPhoto = jest.fn().mockRejectedValue(diskFull());
    const addEntry = jest.fn().mockResolvedValue({});
    const client = fakeClient(addEntry, { uploadPhoto });

    // every foreground, every saved entry and the background task flush
    for (let run = 0; run < 12; run += 1) await flushQueue(client);

    // the entry without a photo behind it went at once
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith('cB', body('2026-09-08', 7));
    const [item] = await readQueue();
    expect(item).toMatchObject({ id: 'a', proofLocalUri: PHOTO, attempts: 0 });
    expect(item?.failedReason).toBeUndefined();
  });

  it('sends the entry without it after an hour where the photo is optional', async () => {
    await enqueueEntry('cA', body('2026-09-08', 30), 'a', PHOTO);
    const uploadPhoto = jest.fn().mockRejectedValue(diskFull());
    const addEntry = jest.fn().mockResolvedValue({});
    const client = fakeClient(addEntry, { uploadPhoto });

    await flushQueue(client);
    await heldFor(60 * 60 * 1000);
    const result = await flushQueue(client);

    expect(addEntry).toHaveBeenCalledWith('cA', body('2026-09-08', 30));
    expect(result).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(await readQueue()).toEqual([]);
  });

  it("says it was the server's disk when a çelınc that requires a photo refuses the entry without it", async () => {
    await enqueueEntry('cA', body('2026-09-08', 30), 'a', PHOTO);
    const uploadPhoto = jest.fn().mockRejectedValue(diskFull());
    const addEntry = jest
      .fn()
      .mockRejectedValue(new ApiError('proof_required', 'Bu çelıncta kanıt fotoğrafı zorunlu.', 400));
    const client = fakeClient(addEntry, { uploadPhoto });

    await flushQueue(client);
    await heldFor(61 * 60 * 1000);
    const result = await flushQueue(client);

    expect(result).toEqual({ sent: 0, dropped: 1, remaining: 0 });
    const [item] = await readQueue();
    expect(item?.failedReason).toBe(`${DISK_FULL} Bu çelıncta kanıt fotoğrafı zorunlu.`);
  });

  it('still counts a try for a server that fails some other way', async () => {
    await enqueueEntry('cA', body('2026-09-08', 30), 'a', PHOTO);
    const uploadPhoto = jest
      .fn()
      .mockRejectedValue(new ApiError('internal', 'Sunucuda bir şeyler ters gitti.', 500));
    await flushQueue(fakeClient(jest.fn(), { uploadPhoto }));

    const [item] = await readQueue();
    expect(item?.attempts).toBe(1);
    expect(item?.photoHeldSince).toBeUndefined();
  });
});

describe('a photo too slow for the connection', () => {
  const PHOTO = 'file:///data/user/0/com.koydum.app/cache/ImagePicker/abc.jpeg';
  // two minutes went by without an answer (lib/api.ts UPLOAD_TIMEOUT_MS)
  const TIMEOUT = () => new ApiError('timeout', 'Sunucu cevap vermedi. Bağlantını kontrol et.', 0);
  const REQUIRED = () => new ApiError('proof_required', 'Bu çelıncta kanıt fotoğrafı zorunlu.', 400);

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('lets the entries behind it go while the server answers', async () => {
    await enqueueEntry('cA', body('2026-09-08', 5), 'a', PHOTO);
    await enqueueEntry('cB', body('2026-09-08', 7), 'b');
    const uploadPhoto = jest.fn().mockRejectedValue(TIMEOUT());
    const health = jest.fn().mockResolvedValue({ ok: true });
    const addEntry = jest.fn().mockResolvedValue({});
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto, health }));

    // one try per flush: a second would hold everything up two more minutes
    expect(uploadPhoto).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith('cB', body('2026-09-08', 7));
    expect(result).toEqual({ sent: 1, dropped: 0, remaining: 1 });
    const [item] = await readQueue();
    expect(item).toMatchObject({ id: 'a', proofLocalUri: PHOTO, photoSlowTries: 1, attempts: 1 });
    expect(item?.failedReason).toBeUndefined();
  });

  it('sends the entry without it on the third slow flush, and says why when that is refused', async () => {
    await enqueueEntry('cA', body('2026-09-08', 5), 'a', PHOTO);
    const uploadPhoto = jest.fn().mockRejectedValue(TIMEOUT());
    const health = jest.fn().mockResolvedValue({ ok: true });
    const addEntry = jest.fn().mockRejectedValue(REQUIRED());
    const client = fakeClient(addEntry, { uploadPhoto, health });

    await flushQueue(client);
    await flushQueue(client);
    expect(addEntry).not.toHaveBeenCalled();
    expect((await readQueue())[0]?.photoSlowTries).toBe(2);

    const third = await flushQueue(client);
    expect(uploadPhoto).toHaveBeenCalledTimes(3);
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith('cA', body('2026-09-08', 5));
    expect(third).toEqual({ sent: 0, dropped: 1, remaining: 0 });
    const [item] = await readQueue();
    expect(item?.proofLocalUri).toBeUndefined();
    expect(item?.failedReason).toBe('Kanıt fotoğrafı gitmedi, bağlantı çok yavaştı. Bu çelıncta kanıt fotoğrafı zorunlu.');
  });

  it('counts the entry without it where the photo is optional', async () => {
    await enqueueEntry('cA', body('2026-09-08', 5), 'a', PHOTO);
    const uploadPhoto = jest.fn().mockRejectedValue(TIMEOUT());
    const health = jest.fn().mockResolvedValue({ ok: true });
    const addEntry = jest.fn().mockResolvedValue({});
    const client = fakeClient(addEntry, { uploadPhoto, health });

    for (let run = 0; run < 3; run += 1) await flushQueue(client);
    expect(addEntry).toHaveBeenCalledWith('cA', body('2026-09-08', 5));
    expect(await readQueue()).toEqual([]);
  });

  it('still stops the flush when the server does not answer either', async () => {
    await enqueueEntry('cA', body('2026-09-08', 5), 'a', PHOTO);
    await enqueueEntry('cB', body('2026-09-08', 7), 'b');
    const uploadPhoto = jest.fn().mockRejectedValue(TIMEOUT());
    const health = jest.fn().mockRejectedValue(new ApiError('network', 'Sunucuya ulaşamadım.', 0));
    const addEntry = jest.fn();
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto, health }));

    expect(addEntry).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, dropped: 0, remaining: 2 });
    const [item] = await readQueue();
    expect(item?.proofLocalUri).toBe(PHOTO);
    expect(item?.photoSlowTries).toBeUndefined();
  });
});

describe('two accounts on one phone', () => {
  const PHOTO = 'file:///data/user/0/com.koydum.app/cache/ImagePicker/ali.jpeg';

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it("leaves the previous account's parked entry and photo for that account", async () => {
    // Ali logs a day offline, with a photo, then logs out; Veli logs in
    await setJson(StorageKeys.me, { id: 'ali' });
    await enqueueEntry('c1', body('2026-09-08', 30000), 'c1:2026-09-08:manual:', PHOTO);
    await setJson(StorageKeys.me, { id: 'veli' });
    await enqueueEntry('c1', body('2026-09-08', 9000), 'c1:2026-09-08:manual:');

    const uploadPhoto = jest.fn().mockResolvedValue({ url: '/uploads/p1.jpg' });
    const addEntry = jest.fn().mockResolvedValue({});
    const result = await flushQueue(fakeClient(addEntry, { uploadPhoto }));

    // only Veli's own entry goes up with Veli's token, and nothing of Ali's
    expect(uploadPhoto).not.toHaveBeenCalled();
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith('c1', body('2026-09-08', 9000));
    expect(result).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    const left = await readQueue();
    expect(left.map((item) => [item.ownerId, item.body.value, item.proofLocalUri])).toEqual([['ali', 30000, PHOTO]]);

    // Ali back on the phone: his day and photo go out as his
    await setJson(StorageKeys.me, { id: 'ali' });
    await flushQueue(fakeClient(addEntry, { uploadPhoto }));
    expect(uploadPhoto).toHaveBeenCalledWith(PHOTO, 'ali.jpeg');
    expect(addEntry).toHaveBeenLastCalledWith('c1', { ...body('2026-09-08', 30000), proofUrl: '/uploads/p1.jpg' });
    expect(await readQueue()).toEqual([]);
  });

  it("never hands the previous account's parked check-in to the next one as its own tap", async () => {
    const checkin = { dayKey: '2026-09-08', value: 1, source: 'checkin', clientTime: '2026-09-08T20:10:00.000Z' };
    // parked before entries carried an owner: it goes with whoever is logged in
    await enqueueEntry('c1', { ...checkin, dayKey: '2026-09-07' }, 'c1:2026-09-07:checkin:');
    await setJson(StorageKeys.me, { id: 'ali' });
    await enqueueEntry('c1', checkin, 'c1:2026-09-08:checkin:');
    await setJson(StorageKeys.me, { id: 'veli' });

    expect((await pendingForChallenge('c1')).map((item) => item.id)).toEqual(['c1:2026-09-07:checkin:']);
    await setJson(StorageKeys.me, { id: 'ali' });
    expect((await pendingForChallenge('c1')).map((item) => item.id)).toEqual([
      'c1:2026-09-07:checkin:',
      'ali/c1:2026-09-08:checkin:',
    ]);
  });
});

describe('a reply that is not from our server', () => {
  // The real client, so what it makes of each reply is what the queue sees.
  const realFetch = global.fetch;
  const onUnauthorized = jest.fn();

  function clientAnswering(status: number, page: string, type = 'text/html; charset=utf-8'): ApiClient {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () =>
      new Response(page, { status, headers: { 'Content-Type': type } })
    );
    const client = new ApiClient({ baseUrl: 'http://192.168.1.20:4000', token: 'tok', onUnauthorized });
    // React Native's form shape does not exist here; the reply is what matters
    jest.spyOn(client, 'uploadPhoto').mockImplementation(() => client.request('POST', '/uploads'));
    return client;
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    onUnauthorized.mockClear();
  });

  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('keeps an entry a Wi-Fi login page answered with 200: it was never sent', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    const result = await flushQueue(clientAnswering(200, '<html>Misafir Wi-Fi girişi</html>'));

    expect(result).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    const [item] = await readQueue();
    expect(item?.id).toBe('a');
    expect(item?.failedReason).toBeUndefined();
  });

  it("keeps an entry a portal's 403 page turned away: it was never refused", async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    const result = await flushQueue(clientAnswering(403, '<h1>Erişim engellendi</h1>'));

    expect(result).toMatchObject({ sent: 0, dropped: 0, remaining: 1 });
    expect((await readQueue())[0]?.failedReason).toBeUndefined();
  });

  it("keeps everything over a proxy's 401 page, and signs nobody out", async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    const result = await flushQueue(clientAnswering(401, '<h1>401 Authorization Required</h1>'));

    expect(result).toMatchObject({ sent: 0, dropped: 0, remaining: 1 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("waits out a PC asleep all night instead of giving up on the tunnel's 530", async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    const client = clientAnswering(530, '<title>Cloudflare Tunnel error</title>');
    // a background run every quarter hour, all night: more than the eight tries
    for (let run = 0; run < 12; run += 1) await flushQueue(client);

    const [item] = await readQueue();
    expect(item?.failedReason).toBeUndefined();
  });

  it('has not used up its tries by morning: a night asleep is no try at all', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    const client = clientAnswering(530, '<title>Cloudflare Tunnel error</title>');
    for (let run = 0; run < 12; run += 1) await flushQueue(client);

    // awake, and one hiccup of our own: that is its first try, not its thirteenth
    clientAnswering(500, JSON.stringify({ error: { code: 'internal', message: 'Sunucuda bir hata oldu.' } }), 'application/json');
    await flushQueue(client);

    const [item] = await readQueue();
    expect(item?.failedReason).toBeUndefined();
    expect(item?.attempts).toBe(1);
  });

  it('still drops an entry our own server refused', async () => {
    await enqueueEntry('c1', body('2026-08-01', 3), 'a');
    const client = clientAnswering(
      400,
      JSON.stringify({ error: { code: 'day_out_of_range', message: 'O gün çelıncın dışında.' } }),
      'application/json'
    );
    const result = await flushQueue(client);

    expect(result).toMatchObject({ sent: 0, dropped: 1 });
    expect((await readQueue())[0]?.failedReason).toBe('O gün çelıncın dışında.');
  });

  it("keeps the photo when a 404 page answers its upload, instead of dropping it", async () => {
    const PHOTO = 'file:///data/user/0/com.koydum.app/cache/ImagePicker/abc.jpeg';
    await enqueueEntry('c1', body('2026-09-08', 5), 'a', PHOTO);
    const client = clientAnswering(404, '<html>Sayfa bulunamadı</html>');
    const addEntry = jest.spyOn(client, 'addEntry');
    const result = await flushQueue(client);

    expect(addEntry).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    const [item] = await readQueue();
    expect(item?.proofLocalUri).toBe(PHOTO);
    expect(item?.failedReason).toBeUndefined();
  });
});

describe('a write that got through while a flush was running', () => {
  const PHOTO = 'file:///data/user/0/com.koydum.app/cache/ImagePicker/slow.jpeg';
  const DAY = 'c2:2026-09-08:manual:';
  const yesNo = (value: number) => ({ ...body('2026-09-08', value), clientTime: `2026-09-08T2${value}:00:00.000Z` });

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  /** A photo entry ahead in the line, its upload held open until `release` is called. */
  async function heldFlush() {
    await enqueueEntry('c1', body('2026-09-08', 5), 'photo', PHOTO);
    // "Yapmadım", parked while offline, behind the photo
    await enqueueEntry('c2', yesNo(0), DAY);
    let release!: () => void;
    const uploadPhoto = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ url: '/uploads/p1.jpg' });
        })
    );
    const addEntry = jest.fn().mockResolvedValue({});
    const flush = flushQueue(fakeClient(addEntry, { uploadPhoto }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploadPhoto).toHaveBeenCalled();
    return { addEntry, flush, release: () => release() };
  }

  it('does not send the older value a direct write already put right', async () => {
    const { addEntry, flush, release } = await heldFlush();
    // "Yaptım" while the photo goes up: it gets through, and spends the parked "Yapmadım"
    await dropParked(DAY);
    release();

    expect(await flush).toMatchObject({ sent: 1, remaining: 0 });
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith('c1', expect.objectContaining({ proofUrl: '/uploads/p1.jpg' }));
    expect(await readQueue()).toEqual([]);
  });

  it('leaves a correction parked during the flush for the next one, and never writes the older copy over it', async () => {
    const { addEntry, flush, release } = await heldFlush();
    // a new queuedAt, as a real re-park a moment later has
    await new Promise((resolve) => setTimeout(resolve, 5));
    await enqueueEntry('c2', yesNo(1), DAY);
    release();

    await flush;
    expect(addEntry).toHaveBeenCalledTimes(1);
    const queue = await readQueue();
    expect(queue.map((item) => [item.id, item.body.value, item.attempts])).toEqual([[DAY, 1, 0]]);

    addEntry.mockClear();
    await flushQueue(fakeClient(addEntry));
    expect(addEntry).toHaveBeenCalledWith('c2', yesNo(1));
  });

  it('takes a check-in the server already has as sent, not as refused', async () => {
    // its first send landed and only the answer was lost; the replay comes the next morning
    await enqueueEntry('c1', { ...body('2026-09-07', 1), source: 'checkin' }, 'c1:2026-09-07:checkin:');
    const addEntry = jest
      .fn()
      .mockRejectedValue(new ApiError('already_checked_in', 'O gün zaten check-in yapmıştın.', 409));

    expect(await flushQueue(fakeClient(addEntry))).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(await readQueue()).toEqual([]);
  });
});

describe('telling the user about a refused entry', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('keeps the title of the çelınc an entry was parked for', async () => {
    const item = await enqueueEntry('c1', body('2026-09-08', 3), 'a', undefined, 'Adım savaşı');
    expect(item.challengeTitle).toBe('Adım savaşı');
    expect((await readQueue())[0]?.challengeTitle).toBe('Adım savaşı');
  });

  it('clears only the refusals already told, so one landing meanwhile is not lost', async () => {
    await enqueueEntry('c1', body('2026-08-01', 3), 'a');
    const refuse = jest.fn().mockRejectedValue(new ApiError('day_out_of_range', 'O gün çelıncın dışında.', 400));
    await flushQueue(fakeClient(refuse));
    const told = (await readQueue()).map((item) => item.id);

    // another flush refuses a second entry while the toast for the first is up
    await enqueueEntry('c1', body('2026-08-02', 4), 'b');
    await flushQueue(fakeClient(refuse));
    await clearFailed(told);

    expect((await readQueue()).map((item) => [item.id, item.failedReason])).toEqual([['b', 'O gün çelıncın dışında.']]);
  });
});
