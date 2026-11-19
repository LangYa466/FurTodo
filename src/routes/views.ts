import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {toApiEntity, type ApiEntity, type StoredEntity} from '../domain/model';
import {dateSchema, taskEntitySchema} from '../domain/schemas';
import {
  buildMatrix,
  buildToday,
  buildUpcoming,
  isOpenMetadata,
  todayFilter,
} from '../domain/views';
import {
  openReadSession,
  type AppContext,
  type AppEnv,
  type ReadSession,
} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {localDate} from '../lib/time';
import {loadEntities, scanMetadata, type MetadataRow} from '../store/scan';

const MAX_UPCOMING_DAYS = 62;
const DEFAULT_UPCOMING_DAYS = 7;
const MATRIX_UNCLASSIFIED_LIMIT = 100;

const tasksSchema = z.array(taskEntitySchema);

const todayViewSchema = z
  .object({
    date: dateSchema,
    focus: tasksSchema.openapi({
      description:
        '今天最关键的 1-3 件事（从 myDay/overdue/dueToday 按四象限、优先级、到期日计分）',
    }),
    myDay: tasksSchema.openapi({
      description: '用户选入“我的一天”的任务（myDay = date），按 myDayOrder',
    }),
    overdue: tasksSchema.openapi({
      description: '逾期未完成（settings.todayIncludesOverdue = false 时为空）',
    }),
    dueToday: tasksSchema.openapi({description: '今天到期、尚未加入 My Day'}),
    suggestions: tasksSchema.openapi({
      description:
        '建议加入 My Day：昨天没做完的 My Day、3 天内到期、高优先级、重要象限',
    }),
    completed: tasksSchema.openapi({description: '今天完成的任务'}),
    stats: z.object({
      open: z.int(),
      completed: z.int(),
      plannedMinutes: z.int().openapi({description: '待办任务预估分钟数总和'}),
    }),
  })
  .openapi('TodayView');

const upcomingViewSchema = z
  .object({
    from: dateSchema,
    days: z.int(),
    overdue: tasksSchema,
    dates: z.array(z.object({date: dateSchema, tasks: tasksSchema})),
  })
  .openapi('UpcomingView');

const matrixViewSchema = z
  .object({
    q1: tasksSchema.openapi({description: '重要且紧急：马上做'}),
    q2: tasksSchema.openapi({description: '重要不紧急：安排时间做'}),
    q3: tasksSchema.openapi({description: '紧急不重要：委派或快速处理'}),
    q4: tasksSchema.openapi({description: '不重要不紧急：删掉或以后再说'}),
    unclassified: tasksSchema.openapi({
      description: `尚未分类的未完成任务（最多 ${MATRIX_UNCLASSIFIED_LIMIT} 条）`,
    }),
  })
  .openapi('MatrixView');

interface LoadedTasks {
  session: ReadSession;
  tasks: StoredEntity[];
}

/**
 * Loads the tasks a view needs. `filterFor` builds the metadata filter once
 * the read session (and with it the user's time zone) is known.
 */
async function loadTasks(
  c: AppContext,
  filterFor: (session: ReadSession) => (row: MetadataRow) => boolean,
): Promise<LoadedTasks> {
  const session = await openReadSession(c, {
    journal: {mode: 'scan'},
    reserveLists: 2,
    reserveReads: 200,
  });
  const rows = await scanMetadata(
    c.env.DATA,
    session.userId,
    'task',
    session.meter,
    session.overlay,
  );
  const {entities} = await loadEntities(
    c.env.DATA,
    [...rows.values()].filter(filterFor(session)),
    session.meter,
    session.overlay,
  );
  return {session, tasks: [...entities.values()]};
}

function toApiTasks(tasks: StoredEntity[], timeZone: string): ApiEntity[] {
  return tasks.map(task => toApiEntity(task, timeZone));
}

export function registerViewRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/views/today',
      tags: ['Views'],
      summary: '今日视图（My Day）',
      security: BEARER_SECURITY,
      request: {
        query: z.object({
          date: dateSchema.optional().openapi({
            description: '默认为用户时区的今天',
          }),
        }),
      },
      responses: {
        200: jsonContent(todayViewSchema, '今日视图'),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const requested = c.req.valid('query').date;
      const dateFor = (session: ReadSession) =>
        requested ?? localDate(session.now, session.settings.timezone);
      const {session, tasks} = await loadTasks(c, readSession => {
        const isCandidate = todayFilter(
          dateFor(readSession),
          readSession.settings.timezone,
        );
        return row => isCandidate(row.metadata);
      });
      const timeZone = session.settings.timezone;
      const view = buildToday(tasks, dateFor(session), session.settings);
      return c.json(
        {
          date: view.date,
          focus: toApiTasks(view.focus, timeZone),
          myDay: toApiTasks(view.myDay, timeZone),
          overdue: toApiTasks(view.overdue, timeZone),
          dueToday: toApiTasks(view.dueToday, timeZone),
          suggestions: toApiTasks(view.suggestions, timeZone),
          completed: toApiTasks(view.completed, timeZone),
          stats: view.stats,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/views/upcoming',
      tags: ['Views'],
      summary: '即将到来（按到期日分组）',
      security: BEARER_SECURITY,
      request: {
        query: z.object({
          from: dateSchema.optional().openapi({description: '默认为今天'}),
          days: z.coerce
            .number()
            .int()
            .min(1)
            .max(MAX_UPCOMING_DAYS)
            .default(DEFAULT_UPCOMING_DAYS),
        }),
      },
      responses: {
        200: jsonContent(upcomingViewSchema, '即将到来'),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const query = c.req.valid('query');
      const {session, tasks} = await loadTasks(
        c,
        () => row =>
          isOpenMetadata(row.metadata) && Boolean(row.metadata.dueDate),
      );
      const timeZone = session.settings.timezone;
      const today = localDate(session.now, timeZone);
      const view = buildUpcoming(tasks, query.from ?? today, query.days, today);
      return c.json(
        {
          from: view.from,
          days: view.days,
          overdue: toApiTasks(view.overdue, timeZone),
          dates: view.dates.map(group => ({
            date: group.date,
            tasks: toApiTasks(group.tasks, timeZone),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/views/matrix',
      tags: ['Views'],
      summary: '四象限（艾森豪威尔矩阵）',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(matrixViewSchema, '四象限'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {session, tasks} = await loadTasks(
        c,
        () => row => isOpenMetadata(row.metadata),
      );
      const timeZone = session.settings.timezone;
      const view = buildMatrix(
        tasks,
        localDate(session.now, timeZone),
        MATRIX_UNCLASSIFIED_LIMIT,
      );
      return c.json(
        {
          q1: toApiTasks(view.q1, timeZone),
          q2: toApiTasks(view.q2, timeZone),
          q3: toApiTasks(view.q3, timeZone),
          q4: toApiTasks(view.q4, timeZone),
          unclassified: toApiTasks(view.unclassified, timeZone),
        },
        200,
      );
    },
  );
}
