import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError } from '@/lib/api';
import { StorageKeys, setJson } from '@/lib/storage';
import {
  clearFailed,
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
    expect(item?.attempts).toBe(1);
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
});
