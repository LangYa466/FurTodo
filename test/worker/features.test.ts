import {eq} from 'drizzle-orm';
import {beforeAll, describe, expect, it} from 'vitest';
import {sessions} from '../../src/db/schema';
import {HOUSEKEEPING_CRON, REMINDER_CRON} from '../../src/scheduled';
import {
  apiJson,
  installFetchMock,
  login,
  pushCalls,
  pushStatus,
  runCron,
  uniqueUserId,
  withTestDatabase,
} from './helpers';

interface Task extends Record<string, unknown> {
  id: string;
  title: string;
  tagIds: string[];
  listId: string | null;
}

let token: string;

beforeAll(async () => {
  installFetchMock();
  token = await login(uniqueUserId(), 'featurer');
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
      text: '明天下午3点 打电话给王先生确认报价 #电脑前 @工作 !高 ~15m',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.task).toBeNull();
    expect(preview.body.resolved).toMatchObject({
      listId: work.body.id,
      newTags: ['电脑前'],
    });

    const created = await post<{
      task: Task;
      createdTags: Array<{id: string; name: string}>;
    }>('/v1/capture', {
      text: '明天下午3点 打电话给王先生确认报价 #电脑前 @工作 !高 ~15m',
      myDay: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({
      title: '打电话给王先生确认报价',
      dueTime: '15:00',
      priority: 3,
      estimateMinutes: 15,
      listId: work.body.id,
    });
    expect(created.body.createdTags.map(t => t.name)).toEqual(['电脑前']);
    expect(created.body.task.tagIds).toEqual([created.body.createdTags[0]!.id]);

    const reuse = await post<{createdTags: unknown[]; task: Task}>(
      '/v1/capture',
      {text: '整理桌面 #电脑前'},
    );
    expect(reuse.body.createdTags).toEqual([]);
    expect(reuse.body.task.tagIds).toEqual([created.body.createdTags[0]!.id]);
  });
});

describe('views', () => {
  it('today shows My Day, overdue, due today and focus picks the most critical', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
    }).format(new Date());
    await post('/v1/tasks', {
      title: '逾期报告',
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
    expect(view.body.overdue.map(t => t.title)).toContain('逾期报告');
    expect(view.body.dueToday.map(t => t.title)).toContain('今天到期');
    expect(view.body.focus[0]!.title).toBe('逾期报告');

    const matrix = await apiJson<{q1: Task[]}>('/v1/views/matrix', {token});
    expect(matrix.body.q1.map(t => t.title)).toContain('逾期报告');
    const upcoming = await apiJson<{
      dates: Array<{date: string; tasks: Task[]}>;
    }>('/v1/views/upcoming?days=3', {token});
    expect(upcoming.body.dates[0]!.date).toBe(today);
  });
});

describe('web push reminders', () => {
  it('the reminder cron sends due reminders and drops dead subscriptions', async () => {
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
      title: '吃药',
      reminders: [{at: new Date(Date.now() - 1000).toISOString()}],
    });
    await runCron(REMINDER_CRON);
    expect(pushCalls.map(c => c.url).sort()).toEqual([
      'https://push.test/alive',
      'https://push.test/dead',
    ]);
    expect(pushCalls[0]!.headers.get('content-encoding')).toBe('aes128gcm');
    expect(pushCalls[0]!.headers.get('authorization')).toMatch(
      /^vapid t=.+, k=.+/,
    );

    // Sent reminders are gone, so the next run sends nothing.
    pushCalls.length = 0;
    await runCron(REMINDER_CRON);
    expect(pushCalls).toEqual([]);

    const testPush = await post<{sent: number}>('/v1/push/test', {});
    expect(testPush.body.sent).toBe(1);
    expect(pushCalls.map(c => c.url)).toEqual(['https://push.test/alive']);
  });
});

describe('concurrent writers', () => {
  it('applies parallel edits of one task without losing any field', async () => {
    const racer = await login(uniqueUserId(), 'racer');
    const created = await apiJson<{id: string}>('/v1/tasks', {
      token: racer,
      method: 'POST',
      body: JSON.stringify({title: '并发'}),
    });
    const edits: Array<Record<string, unknown>> = [
      {notes: '备注'},
      {priority: 2},
      {quadrant: 1},
      {dueDate: '2026-12-24'},
      {energy: 'high'},
      {estimateMinutes: 30},
      {myDay: '2026-12-01'},
      {sortOrder: 5},
    ];
    const responses = await Promise.all(
      edits.map(edit =>
        apiJson(`/v1/tasks/${created.body.id}`, {
          token: racer,
          method: 'PATCH',
          body: JSON.stringify(edit),
        }),
      ),
    );
    expect(responses.map(response => response.status)).toEqual(
      edits.map(() => 200),
    );
    const task = await apiJson<Record<string, unknown>>(
      `/v1/tasks/${created.body.id}`,
      {token: racer},
    );
    expect(task.body).toMatchObject(Object.assign({rev: 9}, ...edits));
  });

  it('keeps the live entity count exact under parallel creates', async () => {
    const racer = await login(uniqueUserId(), 'counter');
    const responses = await Promise.all(
      Array.from({length: 20}, (_, i) =>
        apiJson('/v1/tasks', {
          token: racer,
          method: 'POST',
          body: JSON.stringify({title: `任务 ${i}`}),
        }),
      ),
    );
    expect(responses.every(response => response.status === 201)).toBe(true);
    const usage = await apiJson<{totals: {entities: number}}>('/v1/usage', {
      token: racer,
    });
    expect(usage.body.totals.entities).toBe(20);
  });
});

describe('hourly housekeeping', () => {
  it('purges expired sessions and keeps live ones', async () => {
    const owner = await login(uniqueUserId(), 'sweeper');
    const pat = await apiJson<{token: string; session: {id: string}}>(
      '/v1/auth/tokens',
      {
        token: owner,
        method: 'POST',
        body: JSON.stringify({name: 'old script', expiresInDays: 1}),
      },
    );
    await withTestDatabase(async db => {
      await db
        .update(sessions)
        .set({expiresAt: new Date(Date.now() - 60_000)})
        .where(eq(sessions.id, pat.body.session.id));
    });
    await runCron(HOUSEKEEPING_CRON);

    // A purged session is unknown, not merely expired.
    const purged = await apiJson<{error: {code: string}}>('/v1/me', {
      token: pat.body.token,
    });
    expect(purged.body.error.code).toBe('invalid_token');
    expect((await apiJson('/v1/me', {token: owner})).status).toBe(200);
  });
});

describe('daily quota', () => {
  it('rejects writes past the per-user daily limit with 429 + Retry-After, and reports usage', async () => {
    // A user of its own, so burning the whole budget affects no other test.
    const owner = await login(uniqueUserId(), 'quota');
    const usage = await apiJson<{
      used: {writes: number};
      limits: {writes: number};
    }>('/v1/usage', {token: owner});
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
          token: owner,
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
      token: owner,
      method: 'POST',
      body: JSON.stringify({mutations: mutations(1, 10_000)}),
    });
    expect(over.body.results[0]).toMatchObject({
      status: 'rejected',
      error: {code: 'quota_exceeded'},
    });
    const rest = await apiJson<{error: {code: string}}>('/v1/tasks', {
      token: owner,
      method: 'POST',
      body: JSON.stringify({title: 'x'}),
    });
    expect(rest.status).toBe(429);
    expect(Number(rest.headers.get('retry-after'))).toBeGreaterThan(0);
    const after = await apiJson<{
      used: {writes: number};
      limits: {writes: number};
    }>('/v1/usage', {token: owner});
    expect(after.body.used.writes).toBe(after.body.limits.writes);
  });
});
