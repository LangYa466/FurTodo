import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  utf8Encoder,
} from './encoding';

/** A browser push subscription endpoint and its client key material. */
export interface PushTarget {
  endpoint: string;
  /**
   * base64url (padding tolerated): p256dh = 65-byte uncompressed P-256 point,
   * auth = 16 bytes
   */
  keys: {p256dh: string; auth: string};
}

/** Application server keys used to sign VAPID JWTs. */
export interface VapidConfig {
  /** base64url 65-byte uncompressed P-256 public key */
  publicKey: string;
  /** base64url 32-byte private scalar d */
  privateKey: string;
  /** "mailto:..." or "https://..." */
  subject: string;
}

/** Per-message knobs for RFC 8030 delivery; all fields are optional. */
export interface SendOptions {
  /** seconds the push service should keep the message; default 86400 */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** collapse key (<= 32 base64url chars) */
  topic?: string;
}

/** Delivery outcome reported by the push service. */
export interface SendResult {
  ok: boolean;
  status: number;
  /** true for 404/410: the subscription is dead and must be deleted */
  gone: boolean;
  body?: string;
}

/** Deterministic inputs for RFC 8291 test vectors only. */
export interface EncryptTestingOverrides {
  salt: Uint8Array;
  serverKeys: CryptoKeyPair;
}

const RECORD_SIZE = 4096;
const SALT_LENGTH = 16;
const ECDH_SECRET_BITS = 256;
const HKDF_KEY_LENGTH = 32;
const CEK_LENGTH = 16;
const NONCE_LENGTH = 12;
const AUTH_SECRET_LENGTH = 16;
const P256_PUBLIC_KEY_LENGTH = 65;
const P256_PRIVATE_KEY_LENGTH = 32;
const UNCOMPRESSED_POINT_PREFIX = 0x04;
const LAST_RECORD_DELIMITER = 0x02;
const AES_GCM_TAG_BITS = 128;

// salt 16 + rs 4 + idlen 1 + keyid 65
const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + P256_PUBLIC_KEY_LENGTH;
const MAX_PLAINTEXT_BYTES =
  RECORD_SIZE - HEADER_LENGTH - AES_GCM_TAG_BITS / 8 - 1;

const DEFAULT_TTL_SECONDS = 86_400;
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const ERROR_BODY_LIMIT = 500;

// workerd has no EcKeyGenParams; its generic algorithm type covers P-256.
const ECDH_PARAMS: SubtleCryptoGenerateKeyAlgorithm = {
  name: 'ECDH',
  namedCurve: 'P-256',
};
const ECDSA_PARAMS: SubtleCryptoGenerateKeyAlgorithm = {
  name: 'ECDSA',
  namedCurve: 'P-256',
};
const ZERO_BYTE = new Uint8Array(1);
const KEY_INFO_PREFIX = utf8Encoder.encode('WebPush: info');
const CEK_INFO = utf8Encoder.encode('Content-Encoding: aes128gcm\0');
const NONCE_INFO = utf8Encoder.encode('Content-Encoding: nonce\0');

/**
 * Imported keys are immutable and costly to build, so cache them by private
 * key; caching the promise also dedupes concurrent imports.
 */
const vapidKeyCache = new Map<string, Promise<CryptoKey>>();

async function hkdfBits(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {name: 'HKDF', hash: 'SHA-256', salt, info},
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** RFC 8291 aes128gcm body (header + single record, rs = 4096). */
export async function encryptPayload(
  plaintext: Uint8Array,
  target: PushTarget,
  testing?: EncryptTestingOverrides,
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`payload exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }

  const uaPublic = base64UrlDecode(target.keys.p256dh);
  if (
    uaPublic.length !== P256_PUBLIC_KEY_LENGTH ||
    uaPublic[0] !== UNCOMPRESSED_POINT_PREFIX
  ) {
    throw new TypeError(
      'p256dh must be a 65-byte uncompressed P-256 public key',
    );
  }
  const authSecret = base64UrlDecode(target.keys.auth);
  if (authSecret.length !== AUTH_SECRET_LENGTH) {
    throw new TypeError(`auth must be ${AUTH_SECRET_LENGTH} bytes`);
  }

  // generateKey() is typed as CryptoKey | CryptoKeyPair; P-256 yields a pair.
  const serverKeys =
    testing?.serverKeys ??
    ((await crypto.subtle.generateKey(ECDH_PARAMS, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  // exportKey('raw') is typed as ArrayBuffer | JsonWebKey; raw yields bytes.
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', serverKeys.publicKey)) as ArrayBuffer,
  );

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    ECDH_PARAMS,
    false,
    [],
  );
  // workerd spells ECDH's public key member `$public`, hence the cast.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      {name: 'ECDH', public: uaKey} as SubtleCryptoDeriveKeyAlgorithm,
      serverKeys.privateKey,
      ECDH_SECRET_BITS,
    ),
  );

  const keyInfo = concatBytes(KEY_INFO_PREFIX, ZERO_BYTE, uaPublic, asPublic);
  const ikm = await hkdfBits(ecdhSecret, authSecret, keyInfo, HKDF_KEY_LENGTH);

  const salt =
    testing?.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const cek = await hkdfBits(ikm, salt, CEK_INFO, CEK_LENGTH);
  const nonce = await hkdfBits(ikm, salt, NONCE_INFO, NONCE_LENGTH);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, [
    'encrypt',
  ]);
  const record = concatBytes(
    plaintext,
    new Uint8Array([LAST_RECORD_DELIMITER]),
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv: nonce, tagLength: AES_GCM_TAG_BITS},
      aesKey,
      record,
    ),
  );

  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_LENGTH, RECORD_SIZE, false);
  header[SALT_LENGTH + 4] = asPublic.length;
  header.set(asPublic, SALT_LENGTH + 5);

  return concatBytes(header, ciphertext);
}

async function importVapidKey(vapid: VapidConfig): Promise<CryptoKey> {
  const cached = vapidKeyCache.get(vapid.privateKey);
  if (cached) return cached;

  const pending = (async () => {
    const publicBytes = base64UrlDecode(vapid.publicKey);
    if (
      publicBytes.length !== P256_PUBLIC_KEY_LENGTH ||
      publicBytes[0] !== UNCOMPRESSED_POINT_PREFIX
    ) {
      throw new TypeError(
        'VAPID public key must be a 65-byte uncompressed P-256 point',
      );
    }
    const privateBytes = base64UrlDecode(vapid.privateKey);
    if (privateBytes.length !== P256_PRIVATE_KEY_LENGTH) {
      throw new TypeError(
        `VAPID private key must be ${P256_PRIVATE_KEY_LENGTH} bytes`,
      );
    }
    const jwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(publicBytes.subarray(1, 1 + P256_PRIVATE_KEY_LENGTH)),
      y: base64UrlEncode(publicBytes.subarray(1 + P256_PRIVATE_KEY_LENGTH)),
      d: base64UrlEncode(privateBytes),
    };
    return crypto.subtle.importKey('jwk', jwk, ECDSA_PARAMS, false, ['sign']);
  })();

  vapidKeyCache.set(vapid.privateKey, pending);
  try {
    return await pending;
  } catch (error) {
    vapidKeyCache.delete(vapid.privateKey);
    throw error;
  }
}

/**
 * RFC 8292 header value: `vapid t=<jwt>, k=<publicKey>`, with aud set to the
 * endpoint origin and exp to now + 12h.
 */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidConfig,
  nowSeconds?: number,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const exp =
    (nowSeconds ?? Math.floor(Date.now() / 1000)) + VAPID_TOKEN_TTL_SECONDS;
  const header = {typ: 'JWT', alg: 'ES256'};
  const claims = {aud, exp, sub: vapid.subject};
  const signingInput = `${base64UrlEncode(utf8Encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(
    utf8Encoder.encode(JSON.stringify(claims)),
  )}`;

  const key = await importVapidKey(vapid);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      {name: 'ECDSA', hash: 'SHA-256'},
      key,
      utf8Encoder.encode(signingInput),
    ),
  );

  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

/** Sends one encrypted push; gone flags a subscription the service rejected. */
export async function sendWebPush(
  target: PushTarget,
  payload: string,
  vapid: VapidConfig,
  options?: SendOptions,
  fetchImpl?: typeof fetch,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    TTL: String(options?.ttl ?? DEFAULT_TTL_SECONDS),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: await vapidAuthorization(target.endpoint, vapid),
  };
  if (options?.urgency) headers.Urgency = options.urgency;
  if (options?.topic) headers.Topic = options.topic;

  const body = await encryptPayload(utf8Encoder.encode(payload), target);
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(target.endpoint, {
    method: 'POST',
    headers,
    body,
  });

  const result: SendResult = {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
  };
  if (!response.ok) {
    result.body = (await response.text()).slice(0, ERROR_BODY_LIMIT);
  }
  return result;
}

/** Generates a base64url-encoded P-256 VAPID key pair. */
export async function generateVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  // generateKey() is typed as CryptoKey | CryptoKeyPair; P-256 yields a pair.
  const pair = (await crypto.subtle.generateKey(ECDSA_PARAMS, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  // exportKey('raw') is typed as ArrayBuffer | JsonWebKey; raw yields bytes.
  const rawPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  // Same union; this call asks for the JWK branch.
  const jwk = (await crypto.subtle.exportKey(
    'jwk',
    pair.privateKey,
  )) as JsonWebKey;
  if (typeof jwk.d !== 'string') {
    throw new Error('P-256 private key export is missing d');
  }
  return {publicKey: base64UrlEncode(rawPublic), privateKey: jwk.d};
}
