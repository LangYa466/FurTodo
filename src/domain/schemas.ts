import {z} from '@hono/zod-openapi';
import {ID_PATTERN} from '../lib/ids';
import {isValidDate, isValidTimeZone} from '../lib/time';
import {KINDS, type ApiEntity} from './model';

/** Client-generated entity id: 1-64 URL-safe characters. */
export const idSchema = z
  .string()
  .regex(ID_PATTERN, 'id 只能包含 A-Z a-z 0-9 _ -，长度 1-64')
  .openapi({
    description: '实体 id。建议由客户端生成 UUIDv7（离线也能创建）',
    example: '019a9e8c-6f3b-7c2e-9b1a-3f2d4c5b6a71',
  });
/** Calendar date without a time zone, "YYYY-MM-DD". */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidDate, '不是有效日期')
  .openapi({description: '日历日期（不含时区）', example: '2026-11-20'});
/** Time of day on a 24-hour clock, "HH:mm". */
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式需为 HH:mm')
  .openapi({description: '24 小时制时间', example: '15:00'});
/** Absolute instant with its offset; responses always emit UTC. */
export const isoDateTimeSchema = z.iso.datetime({offset: true}).openapi({
  description: 'ISO 8601 时刻（响应一律为 UTC Z 格式）',
  example: '2026-11-20T07:00:00.000Z',
});
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #RRGGBB')
  .openapi({example: '#4F46E5'});
/** Which entity kind a request or response body carries. */
export const kindSchema = z.enum(KINDS).openapi({description: '实体种类'});

/** A repeat rule: frequency, interval, and the restrictions it applies. */
export const recurrenceSchema = z
  .strictObject({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z
      .int()
      .min(1)
      .max(365)
      .default(1)
      .openapi({description: '每 N 个 freq'}),
    byWeekday: z
      .array(z.int().min(0).max(6))
      .max(7)
      .nullable()
      .optional()
      .openapi({description: 'weekly：0=周日 … 6=周六；省略则取到期日的星期'}),
    byMonthDay: z
      .int()
      .min(-1)
      .max(31)
      .refine(v => v !== 0, 'byMonthDay 不可为 0')
      .nullable()
      .optional()
      .openapi({
        description: 'monthly/yearly：1-31，-1 = 月底；天数不足时取月底',
      }),
    byMonth: z
      .int()
      .min(1)
      .max(12)
      .nullable()
      .optional()
      .openapi({description: 'yearly：1-12'}),
    until: dateSchema
      .nullable()
      .optional()
      .openapi({description: '最后可能日期（含）'}),
    count: z
      .int()
      .min(1)
      .max(10_000)
      .nullable()
      .optional()
      .openapi({description: '剩余次数（含本期）；每生成下一期减 1'}),
    basis: z.enum(['due', 'completion']).default('due').openapi({
      description:
        'due：按计划（逾期完成顺延到今天以后）；completion：完成日 + interval',
    }),
  })
  .openapi('Recurrence');

/** Checklist item as accepted on input; the id may be omitted. */
export const subtaskInputSchema = z
  .strictObject({
    id: idSchema.optional().openapi({description: '省略时由服务器生成'}),
    title: z.string().trim().min(1).max(500),
    completed: z.boolean().default(false),
  })
  .openapi('SubtaskInput');

/** Related link accepted on input; only http(s), mailto, and tel. */
export const linkInputSchema = z
  .strictObject({
    id: idSchema.optional(),
    url: z
      .string()
      .max(2048)
      .refine(
        v => /^(https?:\/\/|mailto:|tel:)/i.test(v) && URL.canParse(v),
        '只接受 http(s)/mailto/tel 网址',
      ),
    title: z.string().max(200).nullable().default(null),
  })
  .openapi('LinkInput');

/** Reminder as accepted on input, firing at an absolute instant. */
export const reminderInputSchema = z
  .strictObject({
    id: idSchema.optional(),
    at: isoDateTimeSchema.openapi({description: '通知时刻（绝对时间）'}),
  })
  .openapi('ReminderInput');

const taskFields = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .openapi({description: '具体可执行的动作，例如“给王先生打电话确认报价”'}),
  notes: z.string().max(20_000).openapi({description: '备注（Markdown）'}),
  listId: idSchema.nullable().openapi({
    description: '所属清单；null = 收件箱（Inbox）',
  }),
  tagIds: z.array(idSchema).max(20).openapi({description: '情境标签 id'}),
  priority: z
    .int()
    .min(0)
    .max(3)
    .openapi({description: '0 无、1 低、2 中、3 高'}),
  quadrant: z.int().min(1).max(4).nullable().openapi({
    description:
      '四象限：1 重要且紧急、2 重要不紧急、3 紧急不重要、4 都不；null 未分类',
  }),
  dueDate: dateSchema.nullable(),
  dueTime: timeSchema.nullable().openapi({
    description: '有值时 dueDate 也必须有值；按用户设置的时区解读',
  }),
  reminders: z.array(reminderInputSchema).max(10),
  estimateMinutes: z
    .int()
    .min(1)
    .max(1440)
    .nullable()
    .openapi({description: '预估分钟数'}),
  energy: z
    .enum(['low', 'medium', 'high'])
    .nullable()
    .openapi({description: '所需精力'}),
  subtasks: z
    .array(subtaskInputSchema)
    .max(100)
    .openapi({description: '子任务；整个数组一起覆盖（顺序即显示顺序）'}),
  links: z
    .array(linkInputSchema)
    .max(50)
    .openapi({description: '相关链接（网址、mailto、tel）'}),
  recurrence: recurrenceSchema.nullable(),
  myDay: dateSchema.nullable().openapi({
    description: '加入“我的一天”的日期；只在该日显示于 My Day',
  }),
  myDayOrder: z
    .number()
    .nullable()
    .openapi({description: 'My Day 内排序（小在前）'}),
  sortOrder: z
    .number()
    .openapi({description: '清单内排序（小在前）；插入时取前后两者中点'}),
  completedAt: isoDateTimeSchema.nullable().openapi({
    description: '完成时刻；null = 未完成。完成重复任务时服务器会生成下一期',
  }),
};

/** Partial task update; every field is optional. */
export const taskPatchSchema = z
  .strictObject(taskFields)
  .partial()
  .openapi('TaskPatch');
/** Fields of a partial task update, after parsing. */
export type TaskPatch = z.infer<typeof taskPatchSchema>;
/** New task; only the title is required. */
export const taskCreateSchema = z
  .strictObject({...taskFields, id: idSchema})
  .partial()
  .required({title: true})
  .openapi('TaskCreate');

const listFields = {
  name: z.string().trim().min(1).max(100),
  color: colorSchema.nullable(),
  icon: z
    .string()
    .max(32)
    .nullable()
    .openapi({description: 'emoji 或图标名称'}),
  folderId: idSchema.nullable(),
  sortOrder: z.number(),
  archived: z.boolean(),
};
/** Partial task list update. */
export const listPatchSchema = z
  .strictObject(listFields)
  .partial()
  .openapi('ListPatch');
/** New task list; only the name is required. */
export const listCreateSchema = z
  .strictObject({...listFields, id: idSchema})
  .partial()
  .required({name: true})
  .openapi('ListCreate');

const folderFields = {
  name: z.string().trim().min(1).max(100),
  sortOrder: z.number(),
};
/** Partial folder update. */
export const folderPatchSchema = z
  .strictObject(folderFields)
  .partial()
  .openapi('FolderPatch');
/** New folder; only the name is required. */
export const folderCreateSchema = z
  .strictObject({...folderFields, id: idSchema})
  .partial()
  .required({name: true})
  .openapi('FolderCreate');

const tagFields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[^\s#@]+$/, '标签名称不能含空白、# 或 @')
    .openapi({example: '电脑前'}),
  color: colorSchema.nullable(),
};
/** Partial tag update. */
export const tagPatchSchema = z
  .strictObject(tagFields)
  .partial()
  .openapi('TagPatch');
/** New tag; only the name is required. */
export const tagCreateSchema = z
  .strictObject({...tagFields, id: idSchema})
  .partial()
  .required({name: true})
  .openapi('TagCreate');

/** Partial settings update; every field is optional. */
export const settingsPatchSchema = z
  .strictObject({
    timezone: z
      .string()
      .refine(isValidTimeZone, '不是有效的 IANA 时区')
      .openapi({example: 'Asia/Shanghai'}),
    weekStart: z
      .union([z.literal(0), z.literal(1)])
      .openapi({description: '0 = 周日开始，1 = 周一开始'}),
    defaultReminderTime: timeSchema.openapi({
      description: '只有日期的任务，客户端建议的默认提醒时间',
    }),
    todayIncludesOverdue: z
      .boolean()
      .openapi({description: '今日视图是否列出逾期任务'}),
    locale: z.string().min(2).max(16).openapi({example: 'zh-CN'}),
  })
  .partial()
  .openapi('SettingsPatch');

/** The patch schema that validates each kind's request body. */
export const PATCH_SCHEMAS = {
  task: taskPatchSchema,
  list: listPatchSchema,
  folder: folderPatchSchema,
  tag: tagPatchSchema,
  settings: settingsPatchSchema,
} as const;

const systemFields = {
  id: idSchema,
  rev: z.int().openapi({description: '每次变更 +1'}),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema.openapi({
    description: '服务器最后变更时间（同一用户内严格递增）',
  }),
  deletedAt: isoDateTimeSchema.nullable().openapi({
    description: '非 null 表示在回收站（30 天后永久删除）',
  }),
};

/** Checklist item as stored and returned. */
export const subtaskSchema = z
  .object({id: idSchema, title: z.string(), completed: z.boolean()})
  .openapi('Subtask');
/** Related link as stored and returned. */
export const linkSchema = z
  .object({id: idSchema, url: z.string(), title: z.string().nullable()})
  .openapi('Link');
/** Reminder as stored and returned. */
export const reminderSchema = z
  .object({id: idSchema, at: isoDateTimeSchema})
  .openapi('Reminder');
const recurrenceRuleSchema = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.int(),
    byWeekday: z.array(z.int()).nullable(),
    byMonthDay: z.int().nullable(),
    byMonth: z.int().nullable(),
    until: dateSchema.nullable(),
    count: z.int().nullable(),
    basis: z.enum(['due', 'completion']),
  })
  .openapi('RecurrenceRule');

/** A task entity as returned, read-only fields included. */
export const taskSchema = z
  .object({
    ...systemFields,
    title: z.string(),
    notes: z.string(),
    listId: idSchema.nullable(),
    tagIds: z.array(idSchema),
    priority: z.int(),
    quadrant: z.int().nullable(),
    dueDate: dateSchema.nullable(),
    dueTime: timeSchema.nullable(),
    dueAt: isoDateTimeSchema.nullable().openapi({
      description:
        '只读：dueDate+dueTime 按用户时区换算的时刻；全天任务为 null',
    }),
    reminders: z.array(reminderSchema),
    estimateMinutes: z.int().nullable(),
    energy: z.enum(['low', 'medium', 'high']).nullable(),
    subtasks: z.array(subtaskSchema),
    links: z.array(linkSchema),
    recurrence: recurrenceRuleSchema.nullable(),
    seriesId: idSchema.nullable().openapi({
      description: '只读：同一重复系列共用的 id',
    }),
    myDay: dateSchema.nullable(),
    myDayOrder: z.number().nullable(),
    sortOrder: z.number(),
    completedAt: isoDateTimeSchema.nullable(),
  })
  .openapi('Task');

/** A task list entity as returned. */
export const listSchema = z
  .object({
    ...systemFields,
    name: z.string(),
    color: z.string().nullable(),
    icon: z.string().nullable(),
    folderId: idSchema.nullable(),
    sortOrder: z.number(),
    archived: z.boolean(),
  })
  .openapi('List');
/** A folder entity as returned. */
export const folderSchema = z
  .object({...systemFields, name: z.string(), sortOrder: z.number()})
  .openapi('Folder');
/** A tag entity as returned. */
export const tagSchema = z
  .object({...systemFields, name: z.string(), color: z.string().nullable()})
  .openapi('Tag');
/** A user's settings entity as returned. */
export const settingsSchema = z
  .object({
    ...systemFields,
    timezone: z.string(),
    weekStart: z.union([z.literal(0), z.literal(1)]),
    defaultReminderTime: timeSchema,
    todayIncludesOverdue: z.boolean(),
    locale: z.string(),
  })
  .openapi('Settings');

// Handlers build responses with toApiEntity(), whose ApiEntity type is looser
// than the schemas above. These aliases retype each schema as ApiEntity so
// routes need no casts; the OpenAPI document still uses the precise schemas.
/** Types task responses for route handlers without a cast. */
export const taskEntitySchema: z.ZodType<ApiEntity> = taskSchema;
/** Types list responses for route handlers without a cast. */
export const listEntitySchema: z.ZodType<ApiEntity> = listSchema;
/** Types folder responses for route handlers without a cast. */
export const folderEntitySchema: z.ZodType<ApiEntity> = folderSchema;
/** Types tag responses for route handlers without a cast. */
export const tagEntitySchema: z.ZodType<ApiEntity> = tagSchema;
/** Types settings responses for route handlers without a cast. */
export const settingsEntitySchema: z.ZodType<ApiEntity> = settingsSchema;

/** The error envelope every failing request returns. */
export const errorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({example: 'validation_error'}),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi('Error');

/** One upsert, delete, or restore in a batch request. */
export const mutationSchema = z
  .discriminatedUnion('op', [
    z.strictObject({
      op: z.literal('upsert'),
      type: kindSchema,
      id: idSchema.openapi({description: 'settings 固定为 "main"'}),
      data: z.record(z.string(), z.unknown()).openapi({
        description:
          '按 type 应用 TaskPatch / ListPatch / FolderPatch / TagPatch / SettingsPatch；实体不存在时视为创建（需含必填字段）',
      }),
      at: z.int().min(0).optional().openapi({
        description:
          '用户实际编辑时间（epoch ms）；用于逐字段 LWW。省略 = 服务器当前时间',
      }),
    }),
    z.strictObject({
      op: z.literal('delete'),
      type: kindSchema,
      id: idSchema,
      at: z.int().min(0).optional(),
    }),
    z.strictObject({
      op: z.literal('restore'),
      type: kindSchema,
      id: idSchema,
      at: z.int().min(0).optional(),
    }),
  ])
  .openapi('Mutation');

/** Any one stored entity, matched on its per-kind fields. */
export const entitySchema: z.ZodType<ApiEntity> = z.union([
  taskSchema,
  listSchema,
  folderSchema,
  tagSchema,
  settingsSchema,
]);

/** The outcome of one mutation, carrying the entity's latest state. */
export const mutationResultSchema = z
  .object({
    index: z.int().openapi({description: '对应请求 mutations 数组的索引'}),
    type: kindSchema,
    id: idSchema,
    op: z.enum(['upsert', 'delete', 'restore']),
    status: z.enum(['applied', 'noop', 'rejected']).openapi({
      description:
        'applied 已应用；noop 无变化（已是最新或字段较旧）；rejected 被拒绝（看 error）',
    }),
    entity: entitySchema.nullable().openapi({
      description: '服务器上的最新状态；客户端应以此覆盖本地',
    }),
    spawned: z
      .array(taskEntitySchema)
      .openapi({description: '完成重复任务时生成的下一期'}),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        status: z
          .int()
          .openapi({description: '若用 REST 会得到的 HTTP 状态码'}),
        retryAfter: z
          .int()
          .optional()
          .openapi({description: 'quota_exceeded 时：几秒后配额重置'}),
      })
      .nullable(),
  })
  .openapi('MutationResult');

/** One entity change in a sync pull response. */
export const changeSchema = z
  .object({type: kindSchema, entity: entitySchema})
  .openapi('Change');
