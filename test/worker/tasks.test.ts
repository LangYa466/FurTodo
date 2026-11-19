import {runDurableObjectAlarm} from 'cloudflare:test';
import {beforeAll, describe, expect, it} from 'vitest';
import {apiJson, hubStub, installFetchMock, login} from './helpers';

interface Task extends Record<string, unknown> {
  id: string;
  rev: number;
  title: string;
  completedAt: string | null;
  deletedAt: string | null;
  dueDate: string | null;
}

interface Subtask {
  id: string;
  completed: boolean;
}

const UID = 3001;
let token: string;

/**
 * Miniflare fires alarms scheduled for now on its own; run one extra and wait
 * for the background work to show up in reads.
 */
async function settle<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
): Promise<T> {
  await runDurableObjectAlarm(hubStub(UID));
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await read();
    if (isDone(value)) return value;
    await scheduler.wait(50);
  }
  return read();
}

beforeAll(async () => {
  installFetchMock();
  token = await login(UID, 'tasker');
});

function post<T>(path: string, body: unknown) {
  return apiJson<T>(path, {token, method: 'POST', body: JSON.stringify(body)});
}

function patch<T>(path: string, body: unknown) {
  return apiJson<T>(path, {token, method: 'PATCH', body: JSON.stringify(body)});
}

describe('tasks', () => {
  it('creates with client id (idempotent), reads back immediately, and patches field by field', async () => {
    const id = '019a9e8c-0000-7000-8000-000000000001';
    const created = await post<Task & {subtasks: Subtask[]}>('/v1/tasks', {
      id,
      title: '打電話給王先生確認報價',
      priority: 3,
      subtasks: [{title: '準備報價單'}],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id,
      title: '打電話給王先生確認報價',
      priority: 3,
      rev: 1,
      listId: null,
      completedAt: null,
    });
    expect(created.body.subtasks[0]).toMatchObject({completed: false});

    const again = await post<Task>('/v1/tasks', {
      id,
      title: '打電話給王先生確認報價',
      priority: 3,
    });
    expect(again.body.rev).toBe(1);

    const list = await apiJson<{items: Task[]}>('/v1/tasks', {token});
    expect(list.body.items.map(t => t.id)).toContain(id);

    const updated = await patch<Task>(`/v1/tasks/${id}`, {
      dueDate: '2026-12-01',
      dueTime: '15:00',
    });
    expect(updated.body).toMatchObject({
      title: '打電話給王先生確認報價',
      dueDate: '2026-12-01',
      dueTime: '15:00',
      dueAt: '2026-12-01T07:00:00.000Z',
      rev: 2,
    });

    expect((await patch('/v1/tasks/does-not-exist', {title: 'x'})).status).toBe(
      404,
    );
    expect((await patch(`/v1/tasks/${id}`, {bogus: 1})).status).toBe(400);
  });

  it('completing a recurring task spawns the next occurrence exactly once', async () => {
    const created = await post<Task>('/v1/tasks', {
      title: '繳電話費',
      dueDate: '2026-11-19',
      recurrence: {freq: 'monthly', interval: 1},
    });
    expect(created.body.recurrence).toMatchObject({
      freq: 'monthly',
      byMonthDay: 19,
      basis: 'due',
    });
    const done = await post<{task: Task; spawned: Task[]}>(
      `/v1/tasks/${created.body.id}/complete`,
      {},
    );
    expect(done.status).toBe(200);
    expect(done.body.task.completedAt).not.toBeNull();
    expect(done.body.spawned).toHaveLength(1);
    expect(done.body.spawned[0]).toMatchObject({
      title: '繳電話費',
      completedAt: null,
      seriesId: created.body.id,
    });
    expect(done.body.spawned[0]!.dueDate! > '2026-11-19').toBe(true);

    await post(`/v1/tasks/${created.body.id}/uncomplete`, {});
    const redo = await post<{spawned: Task[]}>(
      `/v1/tasks/${created.body.id}/complete`,
      {},
    );
    expect(redo.body.spawned).toHaveLength(0);
  });

  it('deleting a list moves its tasks to the trash in the background; restoring brings them back', async () => {
    const list = await post<Task>('/v1/lists', {name: '工作'});
    const t1 = await post<Task>('/v1/tasks', {
      title: '寫週報',
      listId: list.body.id,
    });
    const t2 = await post<Task>('/v1/tasks', {
      title: '整理信箱',
      listId: list.body.id,
    });

    const deleted = await apiJson<Task>(`/v1/lists/${list.body.id}`, {
      token,
      method: 'DELETE',
    });
    expect(deleted.body.deletedAt).not.toBeNull();
    const trash = await settle(
      () =>
        apiJson<{items: Array<{type: string; entity: Task}>}>('/v1/trash', {
          token,
        }),
      res => res.body.items.some(i => i.entity.id === t2.body.id),
    );
    const trashed = trash.body.items.map(i => i.entity.id);
    expect(trashed).toEqual(
      expect.arrayContaining([list.body.id, t1.body.id, t2.body.id]),
    );
    const open = await apiJson<{items: Task[]}>('/v1/tasks', {token});
    expect(open.body.items.map(t => t.id)).not.toContain(t1.body.id);

    await post(`/v1/lists/${list.body.id}/restore`, {});
    const restored = await settle(
      () =>
        apiJson<{items: Task[]}>(`/v1/tasks?listId=${list.body.id}`, {token}),
      res => res.body.items.length === 2,
    );
    expect(restored.body.items.map(t => t.id).sort()).toEqual(
      [t1.body.id, t2.body.id].sort(),
    );
  });

  it('refuses edits to trashed tasks until restored', async () => {
    const t = await post<Task>('/v1/tasks', {title: '暫時的'});
    await apiJson(`/v1/tasks/${t.body.id}`, {token, method: 'DELETE'});
    const edit = await patch<{error: {code: string}}>(
      `/v1/tasks/${t.body.id}`,
      {title: '改不了'},
    );
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('deleted');
    const restored = await post<Task>(`/v1/tasks/${t.body.id}/restore`, {});
    expect(restored.body.deletedAt).toBeNull();
  });

  it('settings sync and drive dueAt time zone', async () => {
    const s = await patch<{timezone: string}>('/v1/settings', {
      timezone: 'America/New_York',
      weekStart: 0,
    });
    expect(s.body).toMatchObject({timezone: 'America/New_York', weekStart: 0});
    const t = await post<Task>('/v1/tasks', {
      title: '紐約會議',
      dueDate: '2026-07-01',
      dueTime: '09:00',
    });
    expect(t.body.dueAt).toBe('2026-07-01T13:00:00.000Z');
    expect(
      (await patch('/v1/settings', {timezone: 'Mars/Olympus'})).status,
    ).toBe(400);
    await patch('/v1/settings', {timezone: 'Asia/Taipei', weekStart: 1});
  });
});
