import {runDurableObjectAlarm} from 'cloudflare:test';
import {beforeAll, describe, expect, it} from 'vitest';
import {
  api,
  apiJson,
  hubStub,
  installFetchMock,
  login,
  pushCalls,
  pushStatus,
} from './helpers';

interface Task extends Record<string, unknown> {
  id: string;
  title: string;
  tagIds: string[];
  listId: string | null;
}

interface Attachment {
  id: string;
  size: number;
}

const UID = 5001;
let token: string;

beforeAll(async () => {
  installFetchMock();
  token = await login(UID, 'featurer');
});

function post<T>(path: string, body: unknown) {
  return apiJson<T>(path, {token, method: 'POST', body: JSON.stringify(body)});
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

describe('quick capture', () => {
  it('parses, auto-creates tags, resolves @list and supports dryRun', async () => {
    const work = await post<{id: string}>('/v1/lists', {name: '工作'});
    const preview = await post<{
      task: null;
      parsed: {title: string};
      resolved: {listId: string; newTags: string[]};
    }>('/v1/capture', {
      text: '明天下午3點 打電話給王先生確認報價 #電腦前 @工作 !高 ~15m',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.task).toBeNull();
    expect(preview.body.resolved).toMatchObject({
      listId: work.body.id,
      newTags: ['電腦前'],
    });

    const created = await post<{
      task: Task;
      createdTags: Array<{id: string; name: string}>;
    }>('/v1/capture', {
      text: '明天下午3點 打電話給王先生確認報價 #電腦前 @工作 !高 ~15m',
      myDay: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({
      title: '打電話給王先生確認報價',
      dueTime: '15:00',
      priority: 3,
      estimateMinutes: 15,
      listId: work.body.id,
    });
    expect(created.body.createdTags.map(t => t.name)).toEqual(['電腦前']);
    expect(created.body.task.tagIds).toEqual([created.body.createdTags[0]!.id]);

    const reuse = await post<{createdTags: unknown[]; task: Task}>(
      '/v1/capture',
      {text: '整理桌面 #電腦前'},
    );
    expect(reuse.body.createdTags).toEqual([]);
    expect(reuse.body.task.tagIds).toEqual([created.body.createdTags[0]!.id]);
  });
});

describe('views', () => {
  it('today shows My Day, overdue, due today and focus picks the most critical', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
    }).format(new Date());
    await post('/v1/tasks', {
      title: '逾期報告',
      dueDate: '2020-01-01',
      quadrant: 1,
    });
    await post('/v1/tasks', {title: '今天到期', dueDate: today});
    await post('/v1/tasks', {title: '我的一天', myDay: today, myDayOrder: 1});
    const view = await apiJson<{
      date: string;
      myDay: Task[];
      overdue: Task[];
      dueToday: Task[];
      focus: Task[];
      stats: {open: number};
    }>('/v1/views/today', {token});
    expect(view.status).toBe(200);
    expect(view.body.date).toBe(today);
    expect(view.body.myDay.map(t => t.title)).toContain('我的一天');
    expect(view.body.overdue.map(t => t.title)).toContain('逾期報告');
    expect(view.body.dueToday.map(t => t.title)).toContain('今天到期');
    expect(view.body.focus[0]!.title).toBe('逾期報告');

    const matrix = await apiJson<{q1: Task[]}>('/v1/views/matrix', {token});
    expect(matrix.body.q1.map(t => t.title)).toContain('逾期報告');
    const upcoming = await apiJson<{
      dates: Array<{date: string; tasks: Task[]}>;
    }>('/v1/views/upcoming?days=3', {token});
    expect(upcoming.body.dates[0]!.date).toBe(today);
  });
});

describe('attachments', () => {
  it('uploads, downloads with bearer and signed URL, deletes', async () => {
    const task = await post<Task>('/v1/tasks', {title: '報帳'});
    const upload = await api(
      `/v1/tasks/${task.body.id}/attachments?name=${encodeURIComponent('收據.txt')}`,
      {
        token,
        method: 'POST',
        headers: {'content-type': 'text/plain'},
        body: 'receipt 123',
      },
    );
    expect(upload.status).toBe(201);
    const {attachment}: {attachment: Attachment} = await upload.json();
    expect(attachment.size).toBe(11);

    const download = await api(`/v1/attachments/${attachment.id}`, {token});
    expect(download.headers.get('content-security-policy')).toContain(
      'sandbox',
    );
    expect(await download.text()).toBe('receipt 123');

    const signed = await apiJson<{url: string}>(
      `/v1/attachments/${attachment.id}/url`,
      {token},
    );
    const signedPath = new URL(signed.body.url);
    const viaSig = await api(`${signedPath.pathname}${signedPath.search}`);
    expect(await viaSig.text()).toBe('receipt 123');
    const tampered = await api(
      `${signedPath.pathname}${signedPath.search.replace(/sig=[^&]+/, 'sig=AAAA')}`,
    );
    expect(tampered.status).toBe(403);
    await tampered.text();

    const removed = await apiJson<{task: {attachments: unknown[]}}>(
      `/v1/tasks/${task.body.id}/attachments/${attachment.id}`,
      {token, method: 'DELETE'},
    );
    expect(removed.body.task.attachments).toEqual([]);
    const gone = await api(`/v1/attachments/${attachment.id}`, {token});
    expect(gone.status).toBe(404);
    await gone.text();
  });
});

describe('web push reminders', () => {
  it('fires due reminders through the Durable Object alarm and drops dead subscriptions', async () => {
    const keyPair = await crypto.subtle.generateKey(
      {name: 'ECDH', namedCurve: 'P-256'},
      true,
      ['deriveBits'],
    );
    if (!('publicKey' in keyPair)) throw new Error('expected an ECDH key pair');
    // exportKey('raw') returns bytes, but the ambient type is a union.
    const p256dh = base64UrlEncode(
      (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer,
    );
    const auth = base64UrlEncode(
      crypto.getRandomValues(new Uint8Array(16)).buffer,
    );
    pushStatus.set('https://push.test/dead', 410);
    for (const endpoint of [
      'https://push.test/alive',
      'https://push.test/dead',
    ]) {
      expect(
        (
          await post('/v1/push/subscriptions', {
            endpoint,
            keys: {p256dh, auth},
            device: 'test',
          })
        ).status,
      ).toBe(200);
    }
    pushCalls.length = 0;
    await post('/v1/tasks', {
      title: '吃藥',
      reminders: [{at: new Date(Date.now() + 500).toISOString()}],
    });
    expect(await runDurableObjectAlarm(hubStub(UID))).toBe(true);
    expect(pushCalls.map(c => c.url).sort()).toEqual([
      'https://push.test/alive',
      'https://push.test/dead',
    ]);
    expect(pushCalls[0]!.headers.get('content-encoding')).toBe('aes128gcm');
    expect(pushCalls[0]!.headers.get('authorization')).toMatch(
      /^vapid t=.+, k=.+/,
    );

    pushCalls.length = 0;
    const testPush = await post<{sent: number}>('/v1/push/test', {});
    expect(testPush.body.sent).toBe(1);
    expect(pushCalls.map(c => c.url)).toEqual(['https://push.test/alive']);
  });
});

describe('daily quota', () => {
  it('rejects writes past the per-user daily limit with 429 + Retry-After, and reports usage', async () => {
    const usage = await apiJson<{
      used: {writes: number};
      limits: {writes: number};
    }>('/v1/usage', {token});
    const remaining = usage.body.limits.writes - usage.body.used.writes;
    const mutations = (n: number, offset: number) =>
      Array.from({length: n}, (_, i) => ({
        op: 'upsert',
        type: 'tag',
        id: `q-${offset + i}`,
        data: {name: `q${offset + i}`},
      }));
    let sent = 0;
    while (sent < remaining) {
      const n = Math.min(200, remaining - sent);
      const res = await apiJson<{results: Array<{status: string}>}>(
        '/v1/sync/push',
        {
          token,
          method: 'POST',
          body: JSON.stringify({mutations: mutations(n, sent)}),
        },
      );
      expect(res.body.results.every(r => r.status === 'applied')).toBe(true);
      sent += n;
    }
    const over = await apiJson<{
      results: Array<{status: string; error: {code: string}}>;
    }>('/v1/sync/push', {
      token,
      method: 'POST',
      body: JSON.stringify({mutations: mutations(1, 10_000)}),
    });
    expect(over.body.results[0]).toMatchObject({
      status: 'rejected',
      error: {code: 'quota_exceeded'},
    });
    const rest = await apiJson<{error: {code: string}}>('/v1/tasks', {
      token,
      method: 'POST',
      body: JSON.stringify({title: 'x'}),
    });
    expect(rest.status).toBe(429);
    expect(Number(rest.headers.get('retry-after'))).toBeGreaterThan(0);
    const after = await apiJson<{
      used: {writes: number};
      limits: {writes: number};
    }>('/v1/usage', {token});
    expect(after.body.used.writes).toBe(after.body.limits.writes);
  });
});
