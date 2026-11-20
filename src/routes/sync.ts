import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {isKind, toApiEntity} from '../domain/model';
import {
  changeSchema,
  mutationResultSchema,
  mutationSchema,
} from '../domain/schemas';
import {
  applyMutationBatch,
  chargeReads,
  database,
  requireReadQuota,
  validatePatch,
  type AppEnv,
} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {
  base64UrlDecode,
  base64UrlEncode,
  utf8Decoder,
  utf8Encoder,
} from '../lib/encoding';
import {AppError} from '../lib/errors';
import {ID_PATTERN} from '../lib/ids';
import {pullChanges, type SyncCursor} from '../store/entities';
import type {MutationOutcome, ValidatedMutation} from '../store/mutations';

const MAX_MUTATIONS = 200;
const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 1000;
const CURSOR_VERSION = 2;
/** Largest epoch ms a `Date` can hold. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Opaque pull cursor: stamp, plus the kind and id of the last change sent. */
interface EncodedCursor {
  v: number;
  s: number;
  k?: string;
  i?: string;
}

function encodeCursor({stamp, last}: SyncCursor): string {
  const encoded: EncodedCursor = last
    ? {v: CURSOR_VERSION, s: stamp, k: last.kind, i: last.id}
    : {v: CURSOR_VERSION, s: stamp};
  return base64UrlEncode(utf8Encoder.encode(JSON.stringify(encoded)));
}

function parseCursor(value: unknown): SyncCursor | null {
  if (typeof value !== 'object' || value === null) return null;
  const {v, s, k, i} = value as Record<string, unknown>;
  if (v !== CURSOR_VERSION || typeof s !== 'number') return null;
  if (!Number.isSafeInteger(s) || s < 0 || s > MAX_DATE_MS) return null;
  if (k === undefined && i === undefined) return {stamp: s, last: null};
  if (typeof k !== 'string' || !isKind(k)) return null;
  if (typeof i !== 'string' || !ID_PATTERN.test(i)) return null;
  return {stamp: s, last: {kind: k, id: i}};
}

function decodeCursor(raw: string): SyncCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(base64UrlDecode(raw)));
  } catch {
    parsed = null;
  }
  const cursor = parseCursor(parsed);
  if (cursor) return cursor;
  throw new AppError(
    400,
    'bad_request',
    'cursor 无效；请不带 cursor 重新全量同步',
  );
}

const pullResponseSchema = z
  .object({
    changes: z.array(changeSchema).openapi({
      description: '按写入顺序从旧到新；包含删除（entity.deletedAt 非 null）',
    }),
    cursor: z
      .string()
      .nullable()
      .openapi({description: '下次 pull 带回；reset=true 时为 null'}),
    hasMore: z
      .boolean()
      .openapi({description: 'true = 立刻用新 cursor 再拉取一次'}),
    reset: z.boolean().openapi({
      description:
        'true = cursor 之后有删除记录已被永久清除（回收站超过 30 天），请丢弃本地缓存（保留未发送的 mutation）并不带 cursor 全量重新拉取',
    }),
    serverTime: z.string(),
  })
  .openapi('PullResponse');

interface PendingMutation {
  index: number;
  mutation: ValidatedMutation;
}

/** Registers the batch push and incremental pull routes. */
export function registerSyncRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sync/push',
      tags: ['Sync'],
      summary: '批量提交离线累积的变更',
      description:
        '每个 mutation 独立处理、互不影响（单条验证失败只会让那条 rejected）。所有 mutation 都是幂等的，网络中断后可整批重发。逐字段 Last-Writer-Wins：字段的 at 比服务器上该字段最后写入时间旧就不覆盖。',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                mutations: z.array(mutationSchema).min(1).max(MAX_MUTATIONS),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: jsonContent(
          z.object({results: z.array(mutationResultSchema)}),
          '逐条结果（与请求顺序相同）',
        ),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const {mutations} = c.req.valid('json');
      const results: MutationOutcome[] = new Array(mutations.length);
      const pending: PendingMutation[] = [];
      for (const [index, mutation] of mutations.entries()) {
        const {op, type, id, at: editedAt} = mutation;
        if (mutation.op !== 'upsert') {
          pending.push({index, mutation: {op, type, id, editedAt}});
          continue;
        }
        const validation = validatePatch(type, mutation.data);
        if (!validation.ok) {
          const issues = validation.issues
            .map(issue => `${issue.path} ${issue.message}`)
            .join('; ');
          results[index] = {
            index,
            type,
            id,
            op,
            status: 'rejected',
            entity: null,
            spawned: [],
            error: {
              code: 'validation_error',
              message: `${validation.message}: ${issues}`,
              status: 400,
            },
          };
          continue;
        }
        pending.push({
          index,
          mutation: {op, type, id, data: validation.patch, editedAt},
        });
      }
      if (pending.length > 0) {
        const outcomes = await applyMutationBatch(
          c,
          pending.map(({mutation}) => mutation),
        );
        for (const [position, outcome] of outcomes.entries()) {
          const request = pending[position];
          if (request) {
            results[request.index] = {...outcome, index: request.index};
          }
        }
      }
      return c.json({results}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sync/pull',
      tags: ['Sync'],
      summary: '拉取 cursor 之后的变更（不带 cursor = 全量快照）',
      description:
        '全量快照不含已删除条目；增量包含删除。没有变更时只消耗一次请求配额，可以每 15-60 秒轮询一次，或在 App 回到前台、网络恢复时调用。hasMore=true 要立刻接着拉取。',
      security: BEARER_SECURITY,
      request: {
        query: z.object({
          cursor: z.string().max(400).optional(),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(MAX_PULL_LIMIT)
            .default(DEFAULT_PULL_LIMIT),
        }),
      },
      responses: {
        200: jsonContent(pullResponseSchema, '变更'),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const query = c.req.valid('query');
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      requireReadQuota(c);
      const page = await pullChanges(
        await database(c),
        c.get('auth').userId,
        cursor,
        query.limit,
      );
      chargeReads(c, page.changes.length);
      const serverTime = new Date().toISOString();
      if (page.expired) {
        return c.json(
          {changes: [], cursor: null, hasMore: false, reset: true, serverTime},
          200,
        );
      }
      const timeZone = c.get('auth').settings.timezone;
      return c.json(
        {
          changes: page.changes.map(entity => ({
            type: entity.kind,
            entity: toApiEntity(entity, timeZone),
          })),
          cursor: encodeCursor(page.next),
          hasMore: page.hasMore,
          reset: false,
          serverTime,
        },
        200,
      );
    },
  );
}
