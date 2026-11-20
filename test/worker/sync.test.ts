import {and, eq} from 'drizzle-orm';
import {beforeAll, describe, expect, it} from 'vitest';
import {entities} from '../../src/db/schema';
import {HOUSEKEEPING_CRON} from '../../src/scheduled';
import {
  apiJson,
  installFetchMock,
  login,
  runCron,
  uniqueUserId,
  withTestDatabase,
} from './helpers';

interface Entity extends Record<string, unknown> {
  id: string;
  rev: number;
  title?: string;
  notes?: string;
  deletedAt: string | null;
}

interface PullResult {
  changes: Array<{type: string; entity: Entity}>;
  cursor: string | null;
  hasMore: boolean;
  reset: boolean;
}

interface PushResult {
  results: Array<{
    index: number;
    status: string;
    entity: Entity | null;
    error: {code: string} | null;
  }>;
}

const UID = uniqueUserId();
const DAY_MS = 86_400_000;
let token: string;

beforeAll(async () => {
  installFetchMock();
  token = await login(UID, 'syncer');
});

function push(mutations: unknown[]) {
  return apiJson<PushResult>('/v1/sync/push', {
    token,
    method: 'POST',
    body: JSON.stringify({mutations}),
  });
}

function pull(cursor?: string, limit?: number) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  return apiJson<PullResult>(`/v1/sync/pull?${params}`, {token});
}

/** Pulls from `cursor` until caught up; returns every change and the cursor. */
async function pullAll(
  cursor: string | undefined,
  limit: number,
): Promise<{changes: PullResult['changes']; cursor: string}> {
  const changes: PullResult['changes'] = [];
  let next = cursor;
  for (let page = 0; page < 50; page++) {
    const res = await pull(next, limit);
    expect(res.status).toBe(200);
    changes.push(...res.body.changes);
    next = res.body.cursor ?? undefined;
    if (!res.body.hasMore) break;
  }
  if (!next) throw new Error('pull returned no cursor');
  return {changes, cursor: next};
}

describe('sync', () => {
  it('full snapshot, then incremental pulls see only newer changes including deletions', async () => {
    const editTime = Date.now() - 60_000;
    const first = await push([
      {
        op: 'upsert',
        type: 'list',
        id: 'list-a',
        data: {name: '个人'},
        at: editTime,
      },
      {
        op: 'upsert',
        type: 'task',
        id: 'task-a',
        data: {title: '买牛奶', listId: 'list-a'},
        at: editTime,
      },
      {
        op: 'upsert',
        type: 'task',
        id: 'task-b',
        data: {title: '倒垃圾'},
        at: editTime,
      },
      {op: 'upsert', type: 'task', id: 'bad', data: {title: ''}},
    ]);
    expect(first.body.results.map(r => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'rejected',
    ]);
    expect(first.body.results[3]!.error!.code).toBe('validation_error');

    const full = await pull();
    expect(full.body.reset).toBe(false);
    expect(full.body.changes.map(c => c.entity.id).sort()).toEqual([
      'list-a',
      'task-a',
      'task-b',
    ]);
    const cursor = full.body.cursor!;

    const idle = await pull(cursor);
    expect(idle.body.changes).toEqual([]);

    await push([
      {op: 'upsert', type: 'task', id: 'task-a', data: {notes: '低脂'}},
      {op: 'delete', type: 'task', id: 'task-b'},
    ]);
    const delta = await pull(cursor);
    expect(
      delta.body.changes.map(c => [c.entity.id, c.entity.deletedAt !== null]),
    ).toEqual([
      ['task-a', false],
      ['task-b', true],
    ]);
    expect((await pull(delta.body.cursor!)).body.changes).toEqual([]);
  });

  it('field-level last-writer-wins by client edit time; replays are idempotent', async () => {
    const now = Date.now();
    await push([
      {
        op: 'upsert',
        type: 'task',
        id: 'lww',
        data: {title: 'v1', notes: 'n1'},
        at: now - 10_000,
      },
    ]);
    // An offline device's older title edit must not beat the newer one, but
    // its newer notes edit is applied.
    await push([
      {
        op: 'upsert',
        type: 'task',
        id: 'lww',
        data: {title: 'newer'},
        at: now - 1_000,
      },
    ]);
    const stale = await push([
      {
        op: 'upsert',
        type: 'task',
        id: 'lww',
        data: {title: 'older', notes: 'n2'},
        at: now - 5_000,
      },
    ]);
    expect(stale.body.results[0]).toMatchObject({status: 'applied'});
    expect(stale.body.results[0]!.entity).toMatchObject({
      title: 'newer',
      notes: 'n2',
    });

    const replay = await push([
      {
        op: 'upsert',
        type: 'task',
        id: 'lww',
        data: {title: 'older', notes: 'n2'},
        at: now - 5_000,
      },
    ]);
    expect(replay.body.results[0]!.status).toBe('noop');
  });

  it('pages large snapshots with hasMore and a stable cursor', async () => {
    await push(
      Array.from({length: 12}, (_, i) => ({
        op: 'upsert',
        type: 'tag',
        id: `tag-${i}`,
        data: {name: `t${i}`},
      })),
    );
    const {changes} = await pullAll(undefined, 5);
    const seen = new Set(changes.map(change => change.entity.id));
    for (let i = 0; i < 12; i++) {
      expect(seen.has(`tag-${i}`)).toBe(true);
    }
  });

  it('pages through changes that share one stamp without skipping any', async () => {
    const taskIds = Array.from({length: 7}, (_, i) => `cascade-${i}`);
    await push([
      {op: 'upsert', type: 'list', id: 'cascade', data: {name: '项目'}},
      ...taskIds.map(id => ({
        op: 'upsert',
        type: 'task',
        id,
        data: {title: id, listId: 'cascade'},
      })),
    ]);
    const {cursor} = await pullAll(undefined, 1000);

    // Deleting the list trashes its tasks in the same write.
    await push([{op: 'delete', type: 'list', id: 'cascade'}]);
    const {changes} = await pullAll(cursor, 3);
    expect(changes.map(change => change.entity.id).sort()).toEqual(
      ['cascade', ...taskIds].sort(),
    );
    expect(changes.every(change => change.entity.deletedAt !== null)).toBe(
      true,
    );
  });

  it('asks for a full resync once deletions it missed are purged, then resumes', async () => {
    await push([{op: 'upsert', type: 'task', id: 'gone', data: {title: '旧'}}]);
    const before = await pullAll(undefined, 1000);
    await push([{op: 'delete', type: 'task', id: 'gone'}]);

    // The trash keeps deletions for 30 days; age this one past that.
    await withTestDatabase(async db => {
      await db
        .update(entities)
        .set({deletedAt: new Date(Date.now() - 31 * DAY_MS)})
        .where(and(eq(entities.userId, UID), eq(entities.id, 'gone')));
    });
    await runCron(HOUSEKEEPING_CRON);

    const stale = await pull(before.cursor);
    expect(stale.body).toMatchObject({reset: true, cursor: null, changes: []});

    const resync = await pullAll(undefined, 1000);
    expect(resync.changes.map(change => change.entity.id)).not.toContain(
      'gone',
    );
    const after = await pull(resync.cursor);
    expect(after.body).toMatchObject({reset: false, changes: []});
  });

  it('rejects cursors it did not issue', async () => {
    expect((await pull('not-a-cursor')).status).toBe(400);
    for (const body of [
      {version: 1, since: Date.now()},
      {v: 2, s: 9_000_000_000_000_000},
    ]) {
      const cursor = btoa(JSON.stringify(body)).replaceAll('=', '');
      expect((await pull(cursor)).status).toBe(400);
    }
  });
});
