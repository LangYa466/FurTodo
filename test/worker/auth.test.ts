import {beforeAll, describe, expect, it} from 'vitest';
import {
  CLIENT_REDIRECT,
  OLD_ENOUGH_DAYS,
  TOO_NEW_DAYS,
  api,
  apiJson,
  authorizeAndCallback,
  installFetchMock,
  login,
  pkcePair,
} from './helpers';

beforeAll(() => installFetchMock());

describe('GitHub OAuth + PKCE', () => {
  it('logs in an account older than a year and reports its age', async () => {
    const token = await login(1001, 'alice', OLD_ENOUGH_DAYS);
    expect(token).toMatch(/^ftk_1001\./);
    const {status, body} = await apiJson<{
      user: {login: string; createdAt: string};
      eligibility: {
        minAccountAgeDays: number;
        accountAgeDays: number;
        checkedAt: string;
      };
    }>('/v1/me', {token});
    expect(status).toBe(200);
    expect(body.user.login).toBe('alice');
    expect(body.user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.eligibility.minAccountAgeDays).toBe(365);
    expect(body.eligibility.accountAgeDays).toBeGreaterThanOrEqual(365);
  });

  it('rejects accounts younger than a year with account_too_new', async () => {
    const {challenge} = await pkcePair();
    const back = await authorizeAndCallback(
      {id: 2000, login: 'newbie', accountAgeDays: TOO_NEW_DAYS},
      challenge,
      's-1',
    );
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get('error')).toBe('account_too_new');
    expect(back.searchParams.get('error_description')).toContain('365');
    expect(back.searchParams.get('state')).toBe('s-1');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('refuses redirect URIs outside the allowlist without redirecting', async () => {
    const {challenge} = await pkcePair();
    for (const redirect of [
      'https://evil.example/cb',
      'http://localhost:5173@evil.example/cb',
      'https://evil.example#.example.com/x',
    ]) {
      const q = new URLSearchParams({
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const res = await api(`/v1/auth/github/authorize?${q}`);
      expect(res.status).toBe(400);
      await res.text();
    }
  });

  it('login code is single-use and bound to the PKCE verifier and redirect_uri', async () => {
    const {verifier, challenge} = await pkcePair();
    const back = await authorizeAndCallback(
      {id: 1002, login: 'bob', accountAgeDays: OLD_ENOUGH_DAYS},
      challenge,
    );
    const code = back.searchParams.get('code');
    if (!code) throw new Error(`login failed: ${back}`);
    const exchange = (body: Record<string, string>) =>
      apiJson('/v1/auth/token', {
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: CLIENT_REDIRECT,
          ...body,
        }),
      });
    expect((await exchange({code_verifier: 'x'.repeat(43)})).status).toBe(400);
    expect(
      (await exchange({redirect_uri: 'http://localhost:5173/other'})).status,
    ).toBe(400);
    expect((await exchange({})).status).toBe(200);
    expect((await exchange({})).status).toBe(400);
  });

  it('rejects forged and missing tokens before touching storage', async () => {
    expect((await apiJson('/v1/me')).status).toBe(401);
    expect(
      (
        await apiJson('/v1/me', {
          token: 'ftk_1001.AAAAAAAAAAAAAAAAAAAAAA.forged',
        })
      ).status,
    ).toBe(401);
  });

  it('personal tokens work, sessions can be listed and revoked, logout invalidates the token', async () => {
    const token = await login(1003, 'carol');
    const pat = await apiJson<{
      token: string;
      session: {id: string; kind: string};
    }>('/v1/auth/tokens', {
      token,
      method: 'POST',
      body: JSON.stringify({name: 'agent', expiresInDays: 7}),
    });
    expect(pat.status).toBe(201);
    expect(pat.body.session.kind).toBe('pat');
    expect((await apiJson('/v1/me', {token: pat.body.token})).status).toBe(200);

    const sessions = await apiJson<{
      sessions: Array<{id: string; current: boolean}>;
    }>('/v1/auth/sessions', {token});
    expect(sessions.body.sessions).toHaveLength(2);
    expect(
      (
        await apiJson(`/v1/auth/sessions/${pat.body.session.id}`, {
          token,
          method: 'DELETE',
        })
      ).body,
    ).toEqual({revoked: true});
    expect((await apiJson('/v1/me', {token: pat.body.token})).status).toBe(401);

    expect(
      (await apiJson('/v1/auth/logout', {token, method: 'POST'})).status,
    ).toBe(200);
    expect((await apiJson('/v1/me', {token})).status).toBe(401);
  });
});
