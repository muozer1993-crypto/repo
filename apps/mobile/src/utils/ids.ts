/**
 * RFC 4122 version-4 UUIDs for the entry API's `sessionId` — the server
 * validates the field with `z.uuid()`, so anything shorter is a 400, not an id.
 *
 * Hermes has no `crypto.randomUUID`; when the runtime does provide it (web,
 * newer engines) it is used, otherwise `Math.random` fills the 122 bits. This
 * is an idempotency key, not a secret, so that is plenty.
 */
export function uuidV4(): string {
  const native = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (native && typeof native.randomUUID === 'function') {
    try {
      return native.randomUUID();
    } catch {
      // fall through to the arithmetic version
    }
  }
  const bytes = new Array<number>(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
