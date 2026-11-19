import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  utf8Decoder,
  utf8Encoder,
} from './encoding';

// Every key is derived from TOKEN_SECRET with HKDF; the purpose string is the
// HKDF info, so keys for different purposes are independent. The strings are
// part of the key derivation: changing one invalidates what it protects.
type KeyPurpose = 'token-hmac' | 'state-aes' | 'ghtoken-aes';
export type SealPurpose = Extract<KeyPurpose, `${string}-aes`>;

const HKDF_SALT = utf8Encoder.encode('furtodo/v1');
const AES_IV_BYTES = 12;
const MAX_TOKEN_LENGTH = 200;
const TOKEN_USER_ID_RE = /^\d{1,20}$/;
const TOKEN_SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const keyCache = new Map<string, Promise<CryptoKey>>();

async function importAndDeriveKey(
  secret: string,
  purpose: KeyPurpose,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    utf8Encoder.encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const params = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: HKDF_SALT,
    info: utf8Encoder.encode(purpose),
  };
  if (purpose.endsWith('-hmac')) {
    return crypto.subtle.deriveKey(
      params,
      baseKey,
      {name: 'HMAC', hash: 'SHA-256', length: 256},
      false,
      ['sign', 'verify'],
    );
  }
  return crypto.subtle.deriveKey(
    params,
    baseKey,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  );
}

function deriveKey(secret: string, purpose: KeyPurpose): Promise<CryptoKey> {
  const cacheKey = `${purpose}\0${secret}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = importAndDeriveKey(secret, purpose);
    keyCache.set(cacheKey, key);
  }
  return key;
}

export function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    utf8Encoder.encode(input),
  );
  return base64UrlEncode(digest);
}

async function hmacSign(
  secret: string,
  purpose: KeyPurpose,
  message: string,
): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    utf8Encoder.encode(message),
  );
  return base64UrlEncode(signature);
}

async function hmacVerify(
  secret: string,
  purpose: KeyPurpose,
  message: string,
  signature: string,
): Promise<boolean> {
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64UrlDecode(signature);
  } catch {
    return false;
  }
  const key = await deriveKey(secret, purpose);
  return crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    utf8Encoder.encode(message),
  );
}

/** `ftk` is an access token, `ftc` a one-time login code. */
export type TokenPrefix = 'ftk' | 'ftc';

export interface TokenClaims {
  userId: string;
  sessionId: string;
}

/**
 * Returns a self-verifying token `<prefix>_<userId>.<sessionId>.<hmac>`.
 * Callers check the HMAC before touching storage, so forged tokens cost no
 * Durable Object or KV operations.
 */
export async function signToken(
  secret: string,
  prefix: TokenPrefix,
  {userId, sessionId}: TokenClaims,
): Promise<string> {
  const signature = await hmacSign(
    secret,
    'token-hmac',
    `${prefix}|${userId}|${sessionId}`,
  );
  return `${prefix}_${userId}.${sessionId}.${signature}`;
}

export async function verifyToken(
  secret: string,
  prefix: TokenPrefix,
  token: string,
): Promise<TokenClaims | null> {
  if (!token.startsWith(`${prefix}_`) || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const [userId, sessionId, signature] = token
    .slice(prefix.length + 1)
    .split('.');
  if (
    !userId ||
    !sessionId ||
    !signature ||
    !TOKEN_USER_ID_RE.test(userId) ||
    !TOKEN_SESSION_ID_RE.test(sessionId)
  ) {
    return null;
  }
  const valid = await hmacVerify(
    secret,
    'token-hmac',
    `${prefix}|${userId}|${sessionId}`,
    signature,
  );
  return valid ? {userId, sessionId} : null;
}

/** Encrypts `value` as JSON with AES-GCM; the output is base64url(iv || ciphertext). */
export async function sealJson(
  secret: string,
  purpose: SealPurpose,
  value: unknown,
): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    utf8Encoder.encode(JSON.stringify(value)),
  );
  return base64UrlEncode(concatBytes(iv, new Uint8Array(ciphertext)));
}

/** Returns the value sealed by `sealJson`, or null if it was tampered with. */
export async function openJson<T>(
  secret: string,
  purpose: SealPurpose,
  sealed: string,
): Promise<T | null> {
  let plaintext: ArrayBuffer;
  try {
    const bytes = base64UrlDecode(sealed);
    if (bytes.length <= AES_IV_BYTES) return null;
    const key = await deriveKey(secret, purpose);
    plaintext = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: bytes.subarray(0, AES_IV_BYTES)},
      key,
      bytes.subarray(AES_IV_BYTES),
    );
  } catch {
    return null;
  }
  // AES-GCM authenticated the payload, so it is JSON that sealJson wrote.
  return JSON.parse(utf8Decoder.decode(plaintext)) as T;
}
