import {beforeAll, describe, expect, it} from 'vitest';
import {apiJson, installFetchMock, login} from './helpers';

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

let token: string;

beforeAll(async () => {
  installFetchMock();
  token = await login(4001, 'syncer');
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

describe('sync', () => {
  it('full snapshot, then incremental pulls see only newer changes including deletions', async () => {
    const editTime = Date.now() - 60_000;
    const first = await push([
      {
        op: 'upsert',
        type: 'list',
        id: 'list-a',
        data: {name: '個人'},
        at: editTime,
      },
      {
        op: 'upsert',
        type: 'task',
        id: 'task-a',
        data: {title: '買牛奶', listId: 'list-a'},
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
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await pull(cursor, 5);
      for (const change of res.body.changes) {
        seen.add(change.entity.id);
      }
      cursor = res.body.cursor!;
      if (!res.body.hasMore) break;
    }
    for (let i = 0; i < 12; i++) {
      expect(seen.has(`tag-${i}`)).toBe(true);
    }
  });

  it('asks for a full resync when the cursor is older than tombstone retention', async () => {
    const ancient = btoa(
      JSON.stringify({version: 1, since: Date.now() - 40 * 86_400_000}),
    ).replaceAll('=', '');
    const res = await pull(ancient);
    expect(res.body).toMatchObject({reset: true, cursor: null, changes: []});
    expect((await pull('not-a-cursor')).status).toBe(400);
  });
});
