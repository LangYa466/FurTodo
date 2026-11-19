import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {
  entityKey,
  toApiEntity,
  type ApiEntity,
  type Kind,
  type StoredEntity,
} from '../domain/model';
import {
  changeSchema,
  dateSchema,
  folderCreateSchema,
  folderEntitySchema,
  folderPatchSchema,
  idSchema,
  listCreateSchema,
  listEntitySchema,
  listPatchSchema,
  tagCreateSchema,
  tagEntitySchema,
  tagPatchSchema,
  taskCreateSchema,
  taskEntitySchema,
  taskPatchSchema,
} from '../domain/schemas';
import {
  filterAndSortTasks,
  metadataMatchesQuery,
  type TaskQuery,
} from '../domain/views';
import {
  applyMutation,
  openReadSession,
  parsePatchOrThrow,
  type AppContext,
  type AppEnv,
} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {AppError} from '../lib/errors';
import {uuidV7} from '../lib/ids';
import {loadEntities, scanMetadata} from '../store/scan';

const DEFAULT_TASK_LIMIT = 500;
const MAX_TASK_LIMIT = 2000;
const idParamSchema = z.object({id: idSchema});

export interface EntityRead {
  entity: StoredEntity | null;
  timeZone: string;
}

/** Reads one entity; the journal overlay makes the caller's own writes visible. */
export async function readEntity(
  c: AppContext,
  kind: Kind,
  id: string,
): Promise<EntityRead> {
  const {userId} = c.get('auth');
  const key = entityKey(userId, kind, id);
  const session = await openReadSession(c, {
    journal: {mode: 'keys', keys: [key]},
    reserveReads: 1,
  });
  const timeZone = session.settings.timezone;
  const journal = session.overlay.get(key);
  if (journal) return {entity: journal.body, timeZone};
  await session.meter.charge('reads', 1);
  const entity = await c.env.DATA.get<StoredEntity>(key, 'json');
  return {entity, timeZone};
}

async function readLiveEntities(
  c: AppContext,
  kind: Kind,
): Promise<{entities: StoredEntity[]; timeZone: string}> {
  const session = await openReadSession(c, {
    journal: {mode: 'scan'},
    reserveLists: 1,
    reserveReads: 100,
  });
  const rows = await scanMetadata(
    c.env.DATA,
    session.userId,
    kind,
    session.meter,
    session.overlay,
  );
  const liveRows = [...rows.values()].filter(row => !row.metadata.deletedAt);
  const {entities} = await loadEntities(
    c.env.DATA,
    liveRows,
    session.meter,
    session.overlay,
  );
  return {
    entities: [...entities.values()].filter(entity => !entity.deletedAt),
    timeZone: session.settings.timezone,
  };
}

/** Create bodies: an optional client id plus the kind's fields. */
interface CreateBody {
  id?: string;
  [field: string]: unknown;
}

interface SimpleKindSpec {
  kind: 'list' | 'folder' | 'tag';
  plural: 'lists' | 'folders' | 'tags';
  tag: string;
  label: string;
  createSchema: z.ZodType<CreateBody>;
  patchSchema: z.ZodType;
  entitySchema: z.ZodType<ApiEntity>;
}

const SIMPLE_KINDS: SimpleKindSpec[] = [
  {
    kind: 'list',
    plural: 'lists',
    tag: 'Lists',
    label: '清單（專案/領域）',
    createSchema: listCreateSchema,
    patchSchema: listPatchSchema,
    entitySchema: listEntitySchema,
  },
  {
    kind: 'folder',
    plural: 'folders',
    tag: 'Folders',
    label: '資料夾（清單分組）',
    createSchema: folderCreateSchema,
    patchSchema: folderPatchSchema,
    entitySchema: folderEntitySchema,
  },
  {
    kind: 'tag',
    plural: 'tags',
    tag: 'Tags',
    label: '情境標籤',
    createSchema: tagCreateSchema,
    patchSchema: tagPatchSchema,
    entitySchema: tagEntitySchema,
  },
];

/** Tags sort by name; lists and folders by sortOrder, then creation. */
function compareSimpleEntities(
  kind: SimpleKindSpec['kind'],
): (a: StoredEntity, b: StoredEntity) => number {
  if (kind === 'tag') {
    return (a, b) => String(a.data.name).localeCompare(String(b.data.name));
  }
  return (a, b) =>
    Number(a.data.sortOrder) - Number(b.data.sortOrder) ||
    a.createdAt - b.createdAt;
}

function registerSimpleKind(
  app: OpenAPIHono<AppEnv>,
  spec: SimpleKindSpec,
): void {
  const basePath = `/v1/${spec.plural}`;
  const tags = [spec.tag];

  app.openapi(
    createRoute({
      method: 'get',
      path: basePath,
      tags,
      summary: `列出所有${spec.label}`,
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(
          z.object({items: z.array(spec.entitySchema)}),
          '未刪除的項目',
        ),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {entities, timeZone} = await readLiveEntities(c, spec.kind);
      const items = entities
        .sort(compareSimpleEntities(spec.kind))
        .map(entity => toApiEntity(entity, timeZone));
      return c.json({items}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: basePath,
      tags,
      summary: `建立${spec.label}`,
      description: '可自帶 id（離線建立後同步）；同 id 重送是冪等的。',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {'application/json': {schema: spec.createSchema}},
          required: true,
        },
      },
      responses: {
        201: jsonContent(spec.entitySchema, '已建立'),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const {id, ...fields} = c.req.valid('json');
      const outcome = await applyMutation(c, {
        op: 'upsert',
        type: spec.kind,
        id: id ?? uuidV7(),
        data: parsePatchOrThrow(spec.kind, fields),
      });
      return c.json(requireEntity(outcome.entity, spec.label), 201);
    },
  );

  registerItemRoutes(app, {
    kind: spec.kind,
    basePath,
    tags,
    label: spec.label,
    patchSchema: spec.patchSchema,
    entitySchema: spec.entitySchema,
  });
}

/** Returns the entity a mutation produced, or a 404 when there is none. */
function requireEntity(entity: ApiEntity | null, label: string): ApiEntity {
  if (!entity) throw new AppError(404, 'not_found', `${label}不存在`);
  return entity;
}

interface ItemRouteSpec {
  kind: Exclude<Kind, 'settings'>;
  basePath: string;
  tags: string[];
  label: string;
  patchSchema: z.ZodType;
  entitySchema: z.ZodType<ApiEntity>;
}

/** Registers GET/PATCH/DELETE `{basePath}/{id}` and POST `.../restore`. */
function registerItemRoutes(
  app: OpenAPIHono<AppEnv>,
  spec: ItemRouteSpec,
): void {
  const {kind, basePath, tags, label, patchSchema, entitySchema} = spec;

  app.openapi(
    createRoute({
      method: 'get',
      path: `${basePath}/{id}`,
      tags,
      summary: `取得單一${label}（含垃圾桶中的，deletedAt 非 null）`,
      security: BEARER_SECURITY,
      request: {params: idParamSchema},
      responses: {
        200: jsonContent(entitySchema, '實體'),
        ...errorResponses(401, 403, 404, 429),
      },
    }),
    async c => {
      const {entity, timeZone} = await readEntity(
        c,
        kind,
        c.req.valid('param').id,
      );
      if (!entity) throw new AppError(404, 'not_found', `${label}不存在`);
      return c.json(toApiEntity(entity, timeZone), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: `${basePath}/{id}`,
      tags,
      summary: `部分更新${label}`,
      description: '只送要改的欄位。欄位層級 Last-Writer-Wins。',
      security: BEARER_SECURITY,
      request: {
        params: idParamSchema,
        body: {
          content: {'application/json': {schema: patchSchema}},
          required: true,
        },
      },
      responses: {
        200: jsonContent(entitySchema, '更新後的實體'),
        ...errorResponses(400, 401, 403, 404, 409, 429),
      },
    }),
    async c => {
      const outcome = await applyMutation(c, {
        op: 'upsert',
        type: kind,
        id: c.req.valid('param').id,
        data: parsePatchOrThrow(kind, await c.req.json()),
        mustExist: true,
      });
      return c.json(requireEntity(outcome.entity, label), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: `${basePath}/{id}`,
      tags,
      summary: `刪除${label}（移到垃圾桶，30 天內可還原）`,
      description:
        kind === 'list'
          ? '清單內的任務會一併移到垃圾桶（背景處理）；還原清單時一起還原。'
          : undefined,
      security: BEARER_SECURITY,
      request: {params: idParamSchema},
      responses: {
        200: jsonContent(entitySchema, '刪除後的實體（deletedAt 已設定）'),
        ...errorResponses(401, 403, 404, 429),
      },
    }),
    async c => {
      const outcome = await applyMutation(c, {
        op: 'delete',
        type: kind,
        id: c.req.valid('param').id,
      });
      return c.json(requireEntity(outcome.entity, label), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: `${basePath}/{id}/restore`,
      tags,
      summary: `從垃圾桶還原${label}`,
      security: BEARER_SECURITY,
      request: {params: idParamSchema},
      responses: {
        200: jsonContent(entitySchema, '還原後的實體'),
        ...errorResponses(401, 403, 404, 429),
      },
    }),
    async c => {
      const outcome = await applyMutation(c, {
        op: 'restore',
        type: kind,
        id: c.req.valid('param').id,
      });
      return c.json(requireEntity(outcome.entity, label), 200);
    },
  );
}

const taskQuerySchema = z.object({
  status: z.enum(['open', 'completed', 'all']).default('open'),
  listId: idSchema.optional().openapi({description: '只看某清單'}),
  inbox: z
    .enum(['true', 'false'])
    .optional()
    .openapi({description: 'true = 只看收件匣（沒有清單）'}),
  tagId: idSchema.optional(),
  q: z
    .string()
    .max(200)
    .optional()
    .openapi({description: '標題/備註關鍵字（不分大小寫）'}),
  dueFrom: dateSchema.optional(),
  dueTo: dateSchema.optional(),
  priority: z.coerce.number().int().min(0).max(3).optional(),
  quadrant: z.coerce.number().int().min(1).max(4).optional(),
  energy: z.enum(['low', 'medium', 'high']).optional(),
  maxEstimate: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .openapi({description: '預估分鐘數 <= N（找零碎時間能做的事）'}),
  myDay: dateSchema.optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TASK_LIMIT)
    .default(DEFAULT_TASK_LIMIT),
});

const completeResponseSchema = z.object({
  task: taskEntitySchema,
  spawned: z.array(taskEntitySchema).openapi({description: '重複任務的下一期'}),
});

export function registerEntityRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/tasks',
      tags: ['Tasks'],
      summary: '查詢任務',
      description:
        '未完成依 sortOrder 排序，已完成依 completedAt 新到舊。離線優先的客戶端建議改用 /v1/sync/pull 同步全部資料後在本地查詢。',
      security: BEARER_SECURITY,
      request: {query: taskQuerySchema},
      responses: {
        200: jsonContent(
          z.object({
            items: z.array(taskEntitySchema),
            truncated: z.boolean().openapi({description: '超過 limit 被截斷'}),
          }),
          '任務清單',
        ),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const params = c.req.valid('query');
      const query: TaskQuery = {
        status: params.status,
        listId: params.listId,
        inboxOnly: params.inbox === 'true',
        tagId: params.tagId,
        searchText: params.q,
        dueFrom: params.dueFrom,
        dueTo: params.dueTo,
        priority: params.priority,
        quadrant: params.quadrant,
        energy: params.energy,
        maxEstimate: params.maxEstimate,
        myDay: params.myDay,
        includeDeleted: params.includeDeleted === 'true',
      };
      const session = await openReadSession(c, {
        journal: {mode: 'scan'},
        reserveLists: 2,
        reserveReads: 300,
      });
      const rows = await scanMetadata(
        c.env.DATA,
        session.userId,
        'task',
        session.meter,
        session.overlay,
      );
      const candidates = [...rows.values()].filter(row =>
        metadataMatchesQuery(row.metadata, query),
      );
      const {entities} = await loadEntities(
        c.env.DATA,
        candidates,
        session.meter,
        session.overlay,
      );
      const matches = filterAndSortTasks([...entities.values()], query);
      const timeZone = session.settings.timezone;
      return c.json(
        {
          items: matches
            .slice(0, params.limit)
            .map(task => toApiEntity(task, timeZone)),
          truncated: matches.length > params.limit,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/tasks',
      tags: ['Tasks'],
      summary: '建立任務',
      description:
        '可自帶 id（建議 UUIDv7）；同 id 重送是冪等的。設定 recurrence 但沒有 dueDate 時，伺服器會填入第一個符合的日期。',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {'application/json': {schema: taskCreateSchema}},
          required: true,
        },
      },
      responses: {
        201: jsonContent(taskEntitySchema, '已建立'),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const {id, ...fields} = c.req.valid('json');
      const outcome = await applyMutation(c, {
        op: 'upsert',
        type: 'task',
        id: id ?? uuidV7(),
        data: parsePatchOrThrow('task', fields),
      });
      return c.json(requireEntity(outcome.entity, '任務'), 201);
    },
  );

  registerItemRoutes(app, {
    kind: 'task',
    basePath: '/v1/tasks',
    tags: ['Tasks'],
    label: '任務',
    patchSchema: taskPatchSchema,
    entitySchema: taskEntitySchema,
  });

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/tasks/{id}/complete',
      tags: ['Tasks'],
      summary: '完成任務（重複任務會產生下一期）',
      security: BEARER_SECURITY,
      request: {params: idParamSchema},
      responses: {
        200: jsonContent(completeResponseSchema, '完成後的任務'),
        ...errorResponses(401, 403, 404, 409, 429),
      },
    }),
    async c => {
      const outcome = await applyMutation(c, {
        op: 'upsert',
        type: 'task',
        id: c.req.valid('param').id,
        data: {completedAt: new Date().toISOString()},
        mustExist: true,
      });
      return c.json(
        {task: requireEntity(outcome.entity, '任務'), spawned: outcome.spawned},
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/tasks/{id}/uncomplete',
      tags: ['Tasks'],
      summary: '取消完成',
      security: BEARER_SECURITY,
      request: {params: idParamSchema},
      responses: {
        200: jsonContent(taskEntitySchema, '任務'),
        ...errorResponses(401, 403, 404, 409, 429),
      },
    }),
    async c => {
      const outcome = await applyMutation(c, {
        op: 'upsert',
        type: 'task',
        id: c.req.valid('param').id,
        data: {completedAt: null},
        mustExist: true,
      });
      return c.json(requireEntity(outcome.entity, '任務'), 200);
    },
  );

  for (const spec of SIMPLE_KINDS) {
    registerSimpleKind(app, spec);
  }

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/trash',
      tags: ['Tasks'],
      summary: '垃圾桶（30 天內刪除的任務、清單、資料夾、標籤）',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(
          z.object({items: z.array(changeSchema)}),
          '依刪除時間新到舊',
        ),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const session = await openReadSession(c, {
        journal: {mode: 'scan'},
        reserveLists: 2,
        reserveReads: 100,
      });
      const rows = await scanMetadata(
        c.env.DATA,
        session.userId,
        null,
        session.meter,
        session.overlay,
      );
      const trashedRows = [...rows.values()].filter(
        row => row.metadata.deletedAt,
      );
      const {entities} = await loadEntities(
        c.env.DATA,
        trashedRows,
        session.meter,
        session.overlay,
      );
      const timeZone = session.settings.timezone;
      const items = [...entities.values()]
        .filter(entity => entity.deletedAt)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
        .map(entity => ({
          type: entity.kind,
          entity: toApiEntity(entity, timeZone),
        }));
      return c.json({items}, 200);
    },
  );
}
