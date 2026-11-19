import {describe, expect, it} from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  utf8Decoder,
  utf8Encoder,
} from '../../src/lib/encoding';
import {
  encryptPayload,
  generateVapidKeys,
  sendWebPush,
  vapidAuthorization,
  type PushTarget,
  type VapidConfig,
} from '../../src/lib/webpush';

const ECDH_PARAMS = {name: 'ECDH', namedCurve: 'P-256'} as const;

const RFC = {
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  plaintext: 'When I grow up, I want to be a watermelon',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6Tlz' +
    'AC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The stubs below only cover the call shape the sender uses. */
function asFetch(
  stub: (url: unknown, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return stub as unknown as typeof fetch;
}

interface JwtParts {
  header: string;
  claims: string;
  signature: string;
}

function splitJwt(jwt: string): JwtParts {
  const [header, claims, signature] = jwt.split('.');
  if (!header || !claims || !signature) throw new Error('malformed JWT');
  return {header, claims, signature};
}

function jwtFromAuthorization(authorization: string): string {
  const match = /^vapid t=([^,]+), k=/.exec(authorization);
  if (!match?.[1]) throw new Error('malformed VAPID authorization');
  return match[1];
}

async function newUaKeyPair(): Promise<{
  pair: CryptoKeyPair;
  rawPublic: Uint8Array;
}> {
  // generateKey() is typed as CryptoKey | CryptoKeyPair; P-256 yields a pair.
  const pair = (await crypto.subtle.generateKey(ECDH_PARAMS, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  // exportKey('raw') is typed as ArrayBuffer | JsonWebKey; raw yields bytes.
  const rawPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  return {pair, rawPublic};
}

/** Builds the JWK x/y of a P-256 uncompressed point from its raw bytes. */
function jwkFromRaw(d: string, rawPublic: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    d,
    x: base64UrlEncode(rawPublic.subarray(1, 33)),
    y: base64UrlEncode(rawPublic.subarray(33, 65)),
  };
}

async function importEcdhPrivate(
  d: string,
  rawPublic: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwkFromRaw(d, rawPublic),
    ECDH_PARAMS,
    false,
    ['deriveBits'],
  );
}

async function rfcServerKeys(): Promise<CryptoKeyPair> {
  const asPublic = base64UrlDecode(RFC.asPublic);
  const privateKey = await importEcdhPrivate(RFC.asPrivate, asPublic);
  const publicKey = await crypto.subtle.importKey(
    'raw',
    asPublic,
    ECDH_PARAMS,
    true,
    [],
  );
  return {privateKey, publicKey};
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
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

/**
 * Decrypts a body as the receiver: parses the aes128gcm header and derives
 * with the UA key.
 */
async function decryptAsReceiver(
  body: Uint8Array,
  uaPrivate: CryptoKey,
  uaPublic: Uint8Array,
  auth: Uint8Array,
): Promise<string> {
  const salt = body.subarray(0, 16);
  const idlen = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const asKey = await crypto.subtle.importKey(
    'raw',
    asPublic,
    ECDH_PARAMS,
    false,
    [],
  );
  // workerd spells ECDH's public key member `$public`, hence the cast.
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      {name: 'ECDH', public: asKey} as SubtleCryptoDeriveKeyAlgorithm,
      uaPrivate,
      256,
    ),
  );
  const keyInfo = concatBytes(
    utf8Encoder.encode('WebPush: info'),
    new Uint8Array([0]),
    uaPublic,
    asPublic,
  );
  const ikm = await hkdf(ecdh, auth, keyInfo, 32);
  const cek = await hkdf(
    ikm,
    salt,
    utf8Encoder.encode('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = await hkdf(
    ikm,
    salt,
    utf8Encoder.encode('Content-Encoding: nonce\0'),
    12,
  );

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, [
    'decrypt',
  ]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: nonce, tagLength: 128},
      aesKey,
      ciphertext,
    ),
  );
  expect(record.at(-1)).toBe(0x02);
  return utf8Decoder.decode(record.subarray(0, -1));
}

async function newVapid(): Promise<VapidConfig> {
  const keys = await generateVapidKeys();
  return {...keys, subject: 'mailto:push@furtodo.test'};
}

describe('encryptPayload', () => {
  it('matches the RFC 8291 Section 5 example byte for byte', async () => {
    const target: PushTarget = {
      endpoint:
        'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
      keys: {p256dh: RFC.uaPublic, auth: RFC.authSecret},
    };
    const body = await encryptPayload(
      utf8Encoder.encode(RFC.plaintext),
      target,
      {
        salt: base64UrlDecode(RFC.salt),
        serverKeys: await rfcServerKeys(),
      },
    );
    expect(base64UrlEncode(body)).toBe(RFC.body);
  });

  it('round-trips: the receiver decrypts the original plaintext', async () => {
    const {pair, rawPublic: uaPublic} = await newUaKeyPair();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const target: PushTarget = {
      endpoint: 'https://push.example.net/push/abc',
      keys: {p256dh: base64UrlEncode(uaPublic), auth: base64UrlEncode(auth)},
    };

    const plaintext = utf8Encoder.encode('去买牛奶 🥛 and stretch');
    const body = await encryptPayload(plaintext, target);
    expect(body.length).toBe(86 + plaintext.length + 1 + 16);
    await expect(
      decryptAsReceiver(body, pair.privateKey, uaPublic, auth),
    ).resolves.toBe('去买牛奶 🥛 and stretch');
  });

  it('produces a single record even for empty plaintext', async () => {
    const {pair, rawPublic: uaPublic} = await newUaKeyPair();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptPayload(new Uint8Array(0), {
      endpoint: 'https://push.example.net/x',
      keys: {p256dh: base64UrlEncode(uaPublic), auth: base64UrlEncode(auth)},
    });
    expect(body.length).toBe(86 + 0 + 1 + 16);
    await expect(
      decryptAsReceiver(body, pair.privateKey, uaPublic, auth),
    ).resolves.toBe('');
  });

  it('throws RangeError above 3993 plaintext bytes', async () => {
    const {rawPublic: uaPublic} = await newUaKeyPair();
    const target: PushTarget = {
      endpoint: 'https://push.example.net/x',
      keys: {
        p256dh: base64UrlEncode(uaPublic),
        auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
      },
    };
    await expect(
      encryptPayload(new Uint8Array(3994), target),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      encryptPayload(new Uint8Array(3993), target),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('throws TypeError on a wrong-length p256dh', async () => {
    const target: PushTarget = {
      endpoint: 'https://push.example.net/x',
      keys: {
        p256dh: base64UrlEncode(new Uint8Array(64)),
        auth: RFC.authSecret,
      },
    };
    await expect(
      encryptPayload(new Uint8Array(1), target),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('throws TypeError on a wrong-length auth secret', async () => {
    const target: PushTarget = {
      endpoint: 'https://push.example.net/x',
      keys: {
        p256dh: RFC.uaPublic,
        auth: base64UrlEncode(new Uint8Array(15)),
      },
    };
    await expect(
      encryptPayload(new Uint8Array(1), target),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('vapidAuthorization', () => {
  const verifyJwt = async (jwt: string, publicKey: string) => {
    const {header, claims, signature} = splitJwt(jwt);
    const rawPublic = base64UrlDecode(publicKey);
    const key = await crypto.subtle.importKey(
      'raw',
      rawPublic,
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      key,
      base64UrlDecode(signature),
      utf8Encoder.encode(`${header}.${claims}`),
    );
    return {
      header: JSON.parse(
        utf8Decoder.decode(base64UrlDecode(header)),
      ) as unknown,
      claims: JSON.parse(
        utf8Decoder.decode(base64UrlDecode(claims)),
      ) as unknown,
      valid,
    };
  };

  it('produces a verifiable ES256 JWT', async () => {
    const vapid = await newVapid();
    const value = await vapidAuthorization(
      'https://push.example.net/push/abc?x=1',
      vapid,
      1_700_000_000,
    );
    expect(value.startsWith('vapid t=')).toBe(true);
    const match = /^vapid t=[^,]+, k=(.+)$/.exec(value);
    expect(match?.[1]).toBe(vapid.publicKey);

    const {header, claims, valid} = await verifyJwt(
      jwtFromAuthorization(value),
      vapid.publicKey,
    );
    expect(header).toEqual({typ: 'JWT', alg: 'ES256'});
    expect(claims).toEqual({
      aud: 'https://push.example.net',
      exp: 1_700_000_000 + 43_200,
      sub: 'mailto:push@furtodo.test',
    });
    expect(valid).toBe(true);
  });

  it('a failed import does not poison the key cache', async () => {
    const vapid = await newVapid();
    const broken: VapidConfig = {
      ...vapid,
      publicKey: vapid.publicKey.slice(2),
    };
    await expect(
      vapidAuthorization('https://push.example.net/a', broken, 1_700_000_000),
    ).rejects.toBeInstanceOf(TypeError);
    const value = await vapidAuthorization(
      'https://push.example.net/a',
      vapid,
      1_700_000_000,
    );
    await expect(
      verifyJwt(jwtFromAuthorization(value), vapid.publicKey),
    ).resolves.toMatchObject({valid: true});
  });
});

describe('sendWebPush', () => {
  const makeTarget = async (): Promise<PushTarget> => {
    const {rawPublic: uaPublic} = await newUaKeyPair();
    return {
      endpoint: 'https://push.example.net/push/sub-1',
      keys: {
        p256dh: base64UrlEncode(uaPublic),
        auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
      },
    };
  };

  it('sends the right request and reports ok', async () => {
    const target = await makeTarget();
    const vapid = await newVapid();
    const payload = '打卡提醒';
    let captured: RequestInit | undefined;
    let capturedUrl: string | undefined;

    const result = await sendWebPush(
      target,
      payload,
      vapid,
      {ttl: 60, urgency: 'high', topic: 'task-42'},
      asFetch(async (url, init) => {
        capturedUrl = String(url);
        captured = init;
        return new Response('', {status: 201});
      }),
    );

    expect(capturedUrl).toBe(target.endpoint);
    expect(captured?.method).toBe('POST');
    // The sender passes a plain header map, not a Headers instance.
    const headers = captured?.headers as Record<string, string>;
    expect(headers.TTL).toBe('60');
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers.Urgency).toBe('high');
    expect(headers.Topic).toBe('task-42');
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);

    // The sender passes the ciphertext bytes as the body.
    const body = captured?.body as Uint8Array;
    expect(body.length).toBe(86 + utf8Encoder.encode(payload).length + 1 + 16);
    expect(result).toEqual({ok: true, status: 201, gone: false});
  });

  it('omits Urgency/Topic and defaults TTL to 86400 when options are absent', async () => {
    const target = await makeTarget();
    const vapid = await newVapid();
    let headers: Record<string, string> = {};
    await sendWebPush(
      target,
      'x',
      vapid,
      undefined,
      asFetch(async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return new Response('', {status: 200});
      }),
    );

    expect(headers.TTL).toBe('86400');
    expect(headers.Urgency).toBeUndefined();
    expect(headers.Topic).toBeUndefined();
  });

  it('flags 410 as gone and truncates the error body', async () => {
    const target = await makeTarget();
    const vapid = await newVapid();
    const result = await sendWebPush(
      target,
      'x',
      vapid,
      undefined,
      asFetch(async () => new Response('g'.repeat(900), {status: 410})),
    );

    expect(result.ok).toBe(false);
    expect(result.gone).toBe(true);
    expect(result.body).toHaveLength(500);
  });

  it('treats 404 as gone too', async () => {
    const target = await makeTarget();
    const vapid = await newVapid();
    const result = await sendWebPush(
      target,
      'x',
      vapid,
      undefined,
      asFetch(async () => new Response('not found', {status: 404})),
    );
    expect(result.gone).toBe(true);
    expect(result.body).toBe('not found');
  });

  it('rethrows network errors', async () => {
    const target = await makeTarget();
    const vapid = await newVapid();
    await expect(
      sendWebPush(
        target,
        'x',
        vapid,
        undefined,
        asFetch(async () => {
          throw new TypeError('network down');
        }),
      ),
    ).rejects.toThrow('network down');
  });
});

describe('generateVapidKeys', () => {
  it('produces a 65-byte public key and a 32-byte private key', async () => {
    const keys = await generateVapidKeys();
    const publicBytes = base64UrlDecode(keys.publicKey);
    const privateBytes = base64UrlDecode(keys.privateKey);
    expect(publicBytes).toHaveLength(65);
    expect(publicBytes[0]).toBe(0x04);
    expect(privateBytes).toHaveLength(32);
  });

  it('a JWT signed with the generated keys verifies against the public key', async () => {
    const keys = await generateVapidKeys();
    const vapid: VapidConfig = {...keys, subject: 'https://furtodo.test'};
    const value = await vapidAuthorization(
      'https://push.example.net/push/1',
      vapid,
      1_700_000_000,
    );
    const {header, claims, signature} = splitJwt(jwtFromAuthorization(value));
    const key = await crypto.subtle.importKey(
      'raw',
      base64UrlDecode(keys.publicKey),
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      key,
      base64UrlDecode(signature),
      utf8Encoder.encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });
});
