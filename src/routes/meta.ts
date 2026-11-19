import type {OpenAPIHono} from '@hono/zod-openapi';
import integrationGuide from '../../docs/INTEGRATION.md';
import {configFor, type AppEnv} from '../http/context';
import {randomBase64Url} from '../lib/crypto';
import {devLoginPage} from './dev-login';

const NONCE_BYTES = 16;

export function registerMetaRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get('/', c => {
    const {publicBaseUrl, minAccountAgeDays} = configFor(c.env);
    return c.json({
      name: 'FurTodo API',
      baseUrl: publicBaseUrl,
      docs: `${publicBaseUrl}/docs`,
      openapi: `${publicBaseUrl}/openapi.json`,
      integrationGuide: `${publicBaseUrl}/integration.md`,
      devLogin: `${publicBaseUrl}/dev/login`,
      minAccountAgeDays,
    });
  });

  app.get('/healthz', c => c.json({ok: true, time: new Date().toISOString()}));

  app.get('/integration.md', c =>
    c.body(integrationGuide, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    }),
  );

  app.get('/dev/login', c => {
    const nonce = randomBase64Url(NONCE_BYTES);
    return c.html(devLoginPage(nonce), 200, {
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src https://avatars.githubusercontent.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
  });
}
