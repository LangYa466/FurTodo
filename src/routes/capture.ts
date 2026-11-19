import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import type {ApiEntity} from '../domain/model';
import {
  idSchema,
  recurrenceSchema,
  tagEntitySchema,
  taskEntitySchema,
} from '../domain/schemas';
import {openReadSession, parsePatchOrThrow, type AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import type {ValidatedMutation} from '../hub/types';
import {parseCapture, type ParsedCapture} from '../lib/capture';
import {AppError, unwrap} from '../lib/errors';
import {uuidV7} from '../lib/ids';
import {localDate} from '../lib/time';
import {scanMetadata} from '../store/scan';

const parsedCaptureSchema = z
  .object({
    title: z.string(),
    dueDate: z.string().nullable(),
    dueTime: z.string().nullable(),
    priority: z.int().nullable(),
    quadrant: z.int().nullable(),
    estimateMinutes: z.int().nullable(),
    energy: z.enum(['low', 'medium', 'high']).nullable(),
    tags: z.array(z.string()),
    list: z.string().nullable(),
    recurrence: recurrenceSchema.nullable(),
    tokens: z
      .array(
        z.object({
          kind: z.string(),
          text: z.string(),
          start: z.int(),
          end: z.int(),
        }),
      )
      .openapi({
        description: '被识别的片段（UTF-16 偏移量），可用于在输入框标记颜色',
      }),
    warnings: z.array(z.string()),
  })
  .openapi('ParsedCapture');

const captureResultSchema = z
  .object({
    task: taskEntitySchema
      .nullable()
      .openapi({description: 'dryRun 时为 null'}),
    createdTags: z
      .array(tagEntitySchema)
      .openapi({description: '自动创建的新标签'}),
    parsed: parsedCaptureSchema,
    resolved: z.object({
      listId: idSchema.nullable(),
      tagIds: z.array(idSchema),
      newTags: z
        .array(z.string())
        .openapi({description: '尚不存在、创建时会自动添加的标签名称'}),
    }),
    warnings: z.array(z.string()),
  })
  .openapi('CaptureResult');

/** Treats the whole input as the title when parsing is turned off. */
function unparsedCapture(text: string): ParsedCapture {
  return {
    title: text,
    dueDate: null,
    dueTime: null,
    priority: null,
    quadrant: null,
    estimateMinutes: null,
    energy: null,
    tags: [],
    list: null,
    recurrence: null,
    tokens: [],
    warnings: [],
  };
}

interface NewTag {
  id: string;
  name: string;
}

export function registerCaptureRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/capture',
      tags: ['Capture'],
      summary: '快速收集：一行文字创建任务',
      description:
        '例：`明天下午3点 给王先生打电话确认报价 #电脑前 @工作 !高 ~15m`。语法：#标签（不存在时自动创建）、@清单（比对名称）、!1-3/!低中高/!q1-q4、~15m/~1h（预估）、%低/%中/%高（精力）、*每天/*每周一三五/*每月15号/*完成后3天（重复）、今天/明天/下周一/11月30日/2026-12-25/3pm/下午三点半（日期时间）。dryRun=true 只解析不创建，可用于实时预览。',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                text: z.string().trim().min(1).max(1000),
                listId: idSchema
                  .nullable()
                  .optional()
                  .openapi({description: '指定清单（优先于 @清单）'}),
                myDay: z
                  .boolean()
                  .default(false)
                  .openapi({description: '同时加入今天的 My Day'}),
                dryRun: z.boolean().default(false),
                parse: z
                  .boolean()
                  .default(true)
                  .openapi({description: 'false = 整段文字直接作为标题'}),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: jsonContent(captureResultSchema, 'dryRun 预览'),
        201: jsonContent(captureResultSchema, '已创建'),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const body = c.req.valid('json');
      const session = await openReadSession(c, {
        journal: {mode: 'scan'},
        reserveLists: 2,
      });
      const {timezone, weekStart} = session.settings;
      const parsed = body.parse
        ? parseCapture(body.text, {
            now: session.now,
            timeZone: timezone,
            weekStart,
          })
        : unparsedCapture(body.text);
      if (!parsed.title) {
        throw new AppError(400, 'validation_error', '解析后没有剩余任务标题', {
          warnings: parsed.warnings,
        });
      }
      const warnings = [...parsed.warnings];

      // Tag names match case-insensitively; unknown tags are created.
      const tagIdByName = new Map<string, string>();
      if (parsed.tags.length > 0) {
        const tagRows = await scanMetadata(
          c.env.DATA,
          session.userId,
          'tag',
          session.meter,
          session.overlay,
        );
        for (const row of tagRows.values()) {
          if (!row.metadata.deletedAt && row.metadata.name) {
            tagIdByName.set(row.metadata.name.toLowerCase(), row.id);
          }
        }
      }
      const tagIds: string[] = [];
      const newTags: NewTag[] = [];
      for (const name of parsed.tags) {
        const key = name.toLowerCase();
        let tagId = tagIdByName.get(key);
        if (!tagId) {
          tagId = uuidV7(session.now);
          tagIdByName.set(key, tagId);
          newTags.push({id: tagId, name});
        }
        tagIds.push(tagId);
      }

      // An explicit listId wins; otherwise @list matches a name exactly, then
      // by prefix.
      let listId = body.listId ?? null;
      if (body.listId === undefined && parsed.list) {
        const listRows = await scanMetadata(
          c.env.DATA,
          session.userId,
          'list',
          session.meter,
          session.overlay,
        );
        const lists = [...listRows.values()].flatMap(row =>
          !row.metadata.deletedAt && row.metadata.name
            ? [{id: row.id, name: row.metadata.name.toLowerCase()}]
            : [],
        );
        const wanted = parsed.list.toLowerCase();
        const match =
          lists.find(list => list.name === wanted) ??
          lists.find(list => list.name.startsWith(wanted));
        if (match) {
          listId = match.id;
        } else {
          warnings.push(`unknown_list:@${parsed.list}`);
        }
      }

      const resolved = {listId, tagIds, newTags: newTags.map(tag => tag.name)};
      if (body.dryRun) {
        return c.json(
          {task: null, createdTags: [], parsed, resolved, warnings},
          200,
        );
      }

      const taskFields = {
        title: parsed.title,
        dueDate: parsed.dueDate,
        dueTime: parsed.dueTime,
        priority: parsed.priority ?? 0,
        quadrant: parsed.quadrant,
        estimateMinutes: parsed.estimateMinutes,
        energy: parsed.energy,
        tagIds,
        listId,
        recurrence: parsed.recurrence,
        myDay: body.myDay ? localDate(session.now, timezone) : null,
      };
      const mutations: ValidatedMutation[] = [
        ...newTags.map((tag): ValidatedMutation => ({
          op: 'upsert',
          type: 'tag',
          id: tag.id,
          data: parsePatchOrThrow('tag', {name: tag.name}),
        })),
        {
          op: 'upsert',
          type: 'task',
          id: uuidV7(session.now),
          data: parsePatchOrThrow('task', taskFields),
        },
      ];
      const {hub, sessionId} = c.get('auth');
      const outcomes = unwrap(await hub.applyMutations(sessionId, mutations));
      const taskOutcome = outcomes.at(-1);
      if (taskOutcome?.status === 'rejected' && taskOutcome.error) {
        const {status, code, message} = taskOutcome.error;
        throw new AppError(status, code, message);
      }
      if (!taskOutcome?.entity) {
        throw new AppError(500, 'internal_error', 'capture 没有创建任务');
      }
      const createdTags: ApiEntity[] = outcomes
        .slice(0, -1)
        .flatMap(outcome =>
          outcome.status === 'applied' && outcome.entity
            ? [outcome.entity]
            : [],
        );
      return c.json(
        {
          task: taskOutcome.entity,
          createdTags,
          parsed,
          resolved,
          warnings,
        },
        201,
      );
    },
  );
}
