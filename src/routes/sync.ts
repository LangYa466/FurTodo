import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {TOMBSTONE_RETENTION_MS, toApiEntity} from '../domain/model';
import {
  changeSchema,
  mutationResultSchema,
  mutationSchema,
} from '../domain/schemas';
import {openReadSession, validatePatch, type AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import type {MutationOutcome, ValidatedMutation} from '../hub/types';
import {
  base64UrlDecode,
  base64UrlEncode,
  utf8Decoder,
  utf8Encoder,
} from '../lib/encoding';
import {AppError, unwrap} from '../lib/errors';
import {loadEntities, scanMetadata, type MetadataRow} from '../store/scan';

const MAX_MUTATIONS = 200;
const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 1000;
const CURSOR_VERSION = 1;

/** Opaque pull cursor: changes with `updatedAt > since` are still pending. */
interface Cursor {
  version: number;
  since: number;
}

function encodeCursor(since: number): string {
  const cursor: Cursor = {version: CURSOR_VERSION, since};
  return base64UrlEncode(utf8Encoder.encode(JSON.stringify(cursor)));
}

function isCursor(value: unknown): value is Cursor {
  if (typeof value !== 'object' || value === null) return false;
  const {version, since} = value as Record<string, unknown>;
  return (
    version === CURSOR_VERSION &&
    typeof since === 'number' &&
    Number.isSafeInteger(since) &&
    since >= 0
  );
}

function decodeCursor(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(base64UrlDecode(raw)));
  } catch {
    parsed = null;
  }
  if (isCursor(parsed)) return parsed.since;
  throw new AppError(
    400,
    'bad_request',
    'cursor 无效；请不带 cursor 重新全量同步',
  );
}

const pullResponseSchema = z
  .object({
    changes: z.array(changeSchema).openapi({
      description:
        '按 updatedAt 从旧到新；包含删除（entity.deletedAt 非 null）',
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
        'true = cursor 太旧（> 30 天），请丢弃本地缓存（保留未发送的 mutation）并不带 cursor 全量重新拉取',
    }),
    serverTime: z.string(),
  })
  .openapi('PullResponse');

interface PendingMutation {
  index: number;
  mutation: ValidatedMutation;
}

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
        const {hub, sessionId} = c.get('auth');
        const outcomes = unwrap(
          await hub.applyMutations(
            sessionId,
            pending.map(({mutation}) => mutation),
          ),
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
        '全量快照不含已删除条目；增量包含删除。没有变更时几乎不消耗配额，可以每 15-60 秒轮询一次，或在 App 回到前台、网络恢复时调用。hasMore=true 要立刻接着拉取。',
      security: BEARER_SECURITY,
      request: {
        query: z.object({
          cursor: z.string().max(200).optional(),
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
      const since = query.cursor ? decodeCursor(query.cursor) : 0;
      const isFullSnapshot = since === 0;
      const session = await openReadSession(c, {
        journal: {mode: 'pull', since},
        reserveLists: isFullSnapshot ? 3 : 1,
        reserveReads: isFullSnapshot ? 300 : 50,
      });
      const serverTime = new Date(session.now).toISOString();
      if (!isFullSnapshot && since < session.now - TOMBSTONE_RETENTION_MS) {
        return c.json(
          {changes: [], cursor: null, hasMore: false, reset: true, serverTime},
          200,
        );
      }
      // A cursor never passes committedStamp, so writes still in flight are
      // picked up by the next pull instead of being skipped.
      const caughtUpSince = Math.max(session.committedStamp, since, 1);
      if (session.pullPlan === 'upToDate') {
        return c.json(
          {
            changes: [],
            cursor: encodeCursor(caughtUpSince),
            hasMore: false,
            reset: false,
            serverTime,
          },
          200,
        );
      }

      const isInWindow = (updatedAt: number) =>
        updatedAt > since && updatedAt <= session.committedStamp;
      let rows: MetadataRow[];
      if (session.pullPlan === 'journal') {
        rows = [...session.overlay.values()]
          .filter(entry => isInWindow(entry.metadata.updatedAt))
          .map(entry => ({
            key: entry.key,
            kind: entry.body.kind,
            id: entry.body.id,
            metadata: entry.metadata,
          }));
      } else {
        const listed = await scanMetadata(
          c.env.DATA,
          session.userId,
          null,
          session.meter,
          session.overlay,
        );
        // Full snapshots skip the trash; incremental pulls carry deletions.
        rows = [...listed.values()].filter(
          row =>
            isInWindow(row.metadata.updatedAt) &&
            !(isFullSnapshot && row.metadata.deletedAt),
        );
      }
      rows.sort((a, b) => a.metadata.updatedAt - b.metadata.updatedAt);
      let page = rows.slice(0, query.limit);
      let hasMore = rows.length > query.limit;
      const {entities, stale} = await loadEntities(
        c.env.DATA,
        page,
        session.meter,
        session.overlay,
      );
      // KV returned a value older than its listed metadata: stop before it
      // and let the next pull retry.
      const staleIndex = page.findIndex(row => stale.has(row.key));
      if (staleIndex >= 0) {
        page = page.slice(0, staleIndex);
        hasMore = true;
      }
      const last = page.at(-1);
      let nextSince: number;
      if (staleIndex >= 0) {
        nextSince = last?.metadata.updatedAt ?? since;
      } else if (hasMore && last) {
        nextSince = last.metadata.updatedAt;
      } else {
        nextSince = caughtUpSince;
      }
      const timeZone = session.settings.timezone;
      const changes = page.flatMap(row => {
        const entity = entities.get(row.key);
        return entity
          ? [{type: entity.kind, entity: toApiEntity(entity, timeZone)}]
          : [];
      });
      return c.json(
        {
          changes,
          cursor: encodeCursor(nextSince),
          hasMore,
          reset: false,
          serverTime,
        },
        200,
      );
    },
  );
}
