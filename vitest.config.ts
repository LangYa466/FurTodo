import {generateKeyPairSync} from 'node:crypto';
import {cloudflareTest} from '@cloudflare/vitest-plugin';
import {defineConfig} from 'vitest/config';

/** A fresh VAPID key pair, so the tests need no local secrets. */
function testVapidKeys(): {publicKey: string; privateKey: string} {
  const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'P-256'});
  const {x, y, d} = privateKey.export({format: 'jwk'});
  if (!x || !y || !d) throw new Error('P-256 JWK is missing coordinates');
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(x, 'base64url'),
    Buffer.from(y, 'base64url'),
  ]);
  return {publicKey: point.toString('base64url'), privateKey: d};
}

const vapid = testVapidKeys();

export default defineConfig({
  // The worker pool resolves require() calls in dependencies with the root
  // Vite server, and pg's require('pg-cloudflare') only finds the real
  // socket under the workerd condition.
  ssr: {resolve: {conditions: ['workerd', 'worker', 'module', 'browser']}},
  test: {
    projects: [
      {
        // Pure-function modules (time, recurrence, quick-input parsing, Web
        // Push crypto) run on Node.
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Integration tests: the full Worker on workerd, with Hyperdrive
        // pointing at the PostgreSQL database from global-setup.ts.
        plugins: [
          cloudflareTest(({inject}) => {
            // Wrangler reads the local Hyperdrive target from this variable.
            process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
              inject('databaseUrl');
            return {
              wrangler: {configPath: './wrangler.jsonc'},
              miniflare: {
                bindings: {
                  GITHUB_API_BASE: 'https://gh-api.test',
                  GITHUB_OAUTH_BASE: 'https://gh.test',
                  GITHUB_CLIENT_ID: 'test-client-id',
                  GITHUB_CLIENT_SECRET: 'test-client-secret',
                  TOKEN_SECRET: 'test-token-secret-0123456789abcdef0123456789',
                  VAPID_PUBLIC_KEY: vapid.publicKey,
                  VAPID_PRIVATE_KEY: vapid.privateKey,
                  QUOTA_WRITES_PER_DAY: '400',
                },
              },
            };
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          globalSetup: ['./test/global-setup.ts'],
        },
      },
    ],
  },
});
