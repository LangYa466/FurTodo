import {cloudflareTest} from '@cloudflare/vitest-plugin';
import {defineConfig} from 'vitest/config';

export default defineConfig({
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
        // Integration tests: the full Worker + KV + Durable Object on workerd.
        plugins: [
          cloudflareTest({
            wrangler: {configPath: './wrangler.jsonc'},
            miniflare: {
              bindings: {
                GITHUB_API_BASE: 'https://gh-api.test',
                GITHUB_OAUTH_BASE: 'https://gh.test',
                GITHUB_CLIENT_ID: 'test-client-id',
                GITHUB_CLIENT_SECRET: 'test-client-secret',
                TOKEN_SECRET: 'test-token-secret-0123456789abcdef0123456789',
                QUOTA_KV_WRITES_PER_DAY: '400',
              },
            },
          }),
        ],
        test: {name: 'worker', include: ['test/worker/**/*.test.ts']},
      },
    ],
  },
});
