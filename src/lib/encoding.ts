/** Stateless UTF-8 encoder reused by the crypto and push helpers. */
export const utf8Encoder = new TextEncoder();
/** Decodes UTF-8 bytes produced by the matching encoder. */
export const utf8Decoder = new TextDecoder();

/** Keeps `String.fromCharCode(...chunk)` under engine argument limits. */
const CHAR_CODE_CHUNK = 0x8000;

/** Encodes bytes as unpadded base64url, safe in URLs and JWT segments. */
export function base64UrlEncode(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHAR_CODE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHAR_CODE_CHUNK));
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** Decodes base64url or standard base64, with or without padding. */
export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const normalized = input
    .trim()
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1) {
    throw new TypeError('Invalid base64url input');
  }
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Concatenates byte arrays into one new array of their total length. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}
