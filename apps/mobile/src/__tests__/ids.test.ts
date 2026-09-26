import { uuidV4 } from '@/utils/ids';

/**
 * The focus screen once sent `f<base36>` as its session id; the server answers
 * that with 400 "Geçersiz oturum kimliği", so no focus session was ever saved.
 * The id has to be a real v4 UUID, on Hermes too.
 */
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV4', () => {
  it('produces RFC 4122 version 4 ids without crypto.randomUUID', () => {
    const g = globalThis as { crypto?: unknown };
    const saved = g.crypto;
    // simulate Hermes: no WebCrypto at all
    Object.defineProperty(g, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i += 1) {
        const id = uuidV4();
        expect(id).toMatch(V4);
        seen.add(id);
      }
      expect(seen.size).toBe(200);
    } finally {
      Object.defineProperty(g, 'crypto', { value: saved, configurable: true, writable: true });
    }
  });
});
