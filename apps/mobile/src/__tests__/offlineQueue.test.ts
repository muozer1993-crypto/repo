import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError } from '@/lib/api';
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

function fakeClient(addEntry: jest.Mock) {
  return { addEntry } as unknown as Parameters<typeof flushQueue>[0];
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

  it('replaces an earlier write for the same day and source', async () => {
    await enqueueEntry('c1', body('2026-09-08', 3), 'a');
    await enqueueEntry('c1', body('2026-09-08', 7), 'b');
    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].body.value).toBe(7);
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
