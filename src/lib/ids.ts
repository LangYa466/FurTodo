import {utf8Encoder} from './encoding';

/** Entity ids are client-generated (UUIDv7 recommended) and URL-safe. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  const digits = hex.join('');
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    digits.slice(12, 16),
    digits.slice(16, 20),
    digits.slice(20, 32),
  ].join('-');
}

/** Sets the RFC 9562 version nibble and variant bits in place. */
function stampVersion(bytes: Uint8Array, version: number): void {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | (version << 4);
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
}

/** Returns an RFC 9562 UUIDv7, which sorts by creation time. */
export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(UUID_BYTES));
  let timestamp = now;
  for (let i = TIMESTAMP_BYTES - 1; i >= 0; i--) {
    bytes[i] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  stampVersion(bytes, 7);
  return formatUuid(bytes);
}

/**
 * Returns an RFC 9562 UUIDv8 derived from SHA-256 of `name`, so every device
 * computes the same id for the same input (used for recurring-task instances).
 */
export async function nameBasedUuid(name: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    utf8Encoder.encode(name),
  );
  const bytes = new Uint8Array(digest).slice(0, UUID_BYTES);
  stampVersion(bytes, 8);
  return formatUuid(bytes);
}
