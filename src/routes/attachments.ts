import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {blobKey, type BlobMetadata} from '../domain/model';
import {attachmentSchema, idSchema, taskEntitySchema} from '../domain/schemas';
import {
  configFor,
  hubFor,
  openReadSession,
  type AppContext,
  type AppEnv,
} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {signFileUrl, verifyFileUrl} from '../lib/crypto';
import {AppError, unwrap} from '../lib/errors';

const SIGNED_URL_TTL_SECONDS = 3600;
/** Slack over the file limit for multipart boundaries and headers. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_FILE_NAME_LENGTH = 200;
const MAX_CONTENT_TYPE_LENGTH = 100;
const USER_ID_RE = /^\d{1,20}$/;
/** Types safe to render inline; everything else downloads. */
const INLINE_TYPES =
  /^(image\/(png|jpeg|gif|webp|avif|heic)|application\/pdf|text\/plain|audio\/|video\/)/;

function contentDisposition(name: string, inline: boolean): string {
  const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const disposition = inline ? 'inline' : 'attachment';
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Streams an attachment. Files are served under a sandbox CSP so uploaded
 * HTML or SVG cannot run on the API origin.
 */
async function serveBlob(
  c: AppContext,
  userId: string,
  attachmentId: string,
  forceDownload: boolean,
): Promise<Response> {
  const {value, metadata} = await c.env.DATA.getWithMetadata<BlobMetadata>(
    blobKey(userId, attachmentId),
    'stream',
  );
  if (!value || !metadata) throw new AppError(404, 'not_found', '附件不存在');
  const inline = !forceDownload && INLINE_TYPES.test(metadata.contentType);
  const name = decodeURIComponent(metadata.name);
  return new Response(value, {
    headers: {
      'Content-Type': inline
        ? metadata.contentType
        : 'application/octet-stream',
      'Content-Length': String(metadata.size),
      'Content-Disposition': contentDisposition(name, inline),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

interface UploadedFile {
  name: string;
  contentType: string;
  bytes: ArrayBuffer;
}

/** Reads an upload sent as multipart `file` or as a raw body with `?name=`. */
async function readUpload(
  c: AppContext,
  rawName: string | undefined,
): Promise<UploadedFile> {
  const contentType =
    c.req.header('content-type') ?? 'application/octet-stream';
  if (contentType.startsWith('multipart/form-data')) {
    const file = (await c.req.formData()).get('file');
    if (!(file instanceof File)) {
      throw new AppError(400, 'bad_request', 'multipart 需要 file 欄位');
    }
    return {
      name: file.name || 'file',
      contentType: file.type || 'application/octet-stream',
      bytes: await file.arrayBuffer(),
    };
  }
  if (!rawName) {
    throw new AppError(400, 'bad_request', 'raw body 上傳需要 ?name=檔名');
  }
  return {
    name: rawName,
    contentType: contentType.replace(/;.*$/, '').trim(),
    bytes: await c.req.arrayBuffer(),
  };
}

const attachmentParamSchema = z.object({attachmentId: idSchema});

export function registerAttachmentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/tasks/{id}/attachments',
      tags: ['Attachments'],
      summary: '上傳附件',
      description:
        '兩種方式：(1) multipart/form-data，欄位名 file；(2) 直接把檔案當 body，Content-Type 為檔案類型並帶 ?name=檔名。單檔上限與總容量見 /v1/usage。',
      security: BEARER_SECURITY,
      request: {
        params: z.object({id: idSchema}),
        query: z.object({
          name: z
            .string()
            .max(MAX_FILE_NAME_LENGTH)
            .optional()
            .openapi({description: 'raw body 上傳時的檔名'}),
        }),
      },
      responses: {
        201: jsonContent(
          z.object({attachment: attachmentSchema, task: taskEntitySchema}),
          '已上傳',
        ),
        ...errorResponses(400, 401, 403, 404, 409, 413, 429),
      },
    }),
    async c => {
      const {maxFileBytes} = configFor(c.env);
      const declaredBytes = Number(c.req.header('content-length') ?? 0);
      if (declaredBytes > maxFileBytes + MULTIPART_OVERHEAD_BYTES) {
        throw new AppError(
          413,
          'payload_too_large',
          `單檔上限 ${maxFileBytes} bytes`,
        );
      }
      const upload = await readUpload(c, c.req.valid('query').name);
      const {hub, sessionId} = c.get('auth');
      const result = unwrap(
        await hub.addAttachment(sessionId, c.req.valid('param').id, {
          name: upload.name.slice(0, MAX_FILE_NAME_LENGTH),
          contentType: upload.contentType.slice(0, MAX_CONTENT_TYPE_LENGTH),
          bytes: upload.bytes,
        }),
      );
      return c.json(result, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/tasks/{id}/attachments/{attachmentId}',
      tags: ['Attachments'],
      summary: '刪除附件',
      security: BEARER_SECURITY,
      request: {params: z.object({id: idSchema, attachmentId: idSchema})},
      responses: {
        200: jsonContent(z.object({task: taskEntitySchema}), '刪除後的任務'),
        ...errorResponses(401, 403, 404, 429),
      },
    }),
    async c => {
      const {id, attachmentId} = c.req.valid('param');
      const {hub, sessionId} = c.get('auth');
      return c.json(
        unwrap(await hub.removeAttachment(sessionId, id, attachmentId)),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/attachments/{attachmentId}',
      tags: ['Attachments'],
      summary: '下載附件（需 Bearer）',
      security: BEARER_SECURITY,
      request: {
        params: attachmentParamSchema,
        query: z.object({download: z.enum(['1', '0']).optional()}),
      },
      responses: {
        200: {description: '檔案內容（圖片/PDF/文字/影音以 inline 回傳）'},
        ...errorResponses(401, 403, 404, 429),
      },
    }),
    async c => {
      const session = await openReadSession(c, {
        journal: {mode: 'none'},
        reserveReads: 1,
      });
      await session.meter.charge('reads', 1);
      return serveBlob(
        c,
        session.userId,
        c.req.valid('param').attachmentId,
        c.req.valid('query').download === '1',
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/attachments/{attachmentId}/url',
      tags: ['Attachments'],
      summary: '取得 1 小時有效的簽章網址（可直接放進 <img src>）',
      security: BEARER_SECURITY,
      request: {params: attachmentParamSchema},
      responses: {
        200: jsonContent(
          z.object({url: z.string(), expiresAt: z.string()}),
          '簽章網址',
        ),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {userId} = c.get('auth');
      // Authorizes the session and charges the request.
      await openReadSession(c, {journal: {mode: 'none'}});
      const attachmentId = c.req.valid('param').attachmentId;
      const expiresAtSeconds =
        Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
      const signature = await signFileUrl(
        c.env.TOKEN_SECRET,
        userId,
        attachmentId,
        expiresAtSeconds,
      );
      const query = new URLSearchParams({
        exp: String(expiresAtSeconds),
        sig: signature,
      });
      const {publicBaseUrl} = configFor(c.env);
      return c.json(
        {
          url: `${publicBaseUrl}/v1/files/${userId}/${attachmentId}?${query}`,
          expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/files/{userId}/{attachmentId}',
      tags: ['Attachments'],
      summary: '以簽章網址下載附件（不需 Bearer）',
      request: {
        params: z.object({
          userId: z.string().regex(USER_ID_RE),
          attachmentId: idSchema,
        }),
        query: z.object({
          exp: z.coerce.number().int(),
          sig: z.string().max(100),
          download: z.enum(['1', '0']).optional(),
        }),
      },
      responses: {
        200: {description: '檔案內容'},
        ...errorResponses(403, 404, 429),
      },
    }),
    async c => {
      const {userId, attachmentId} = c.req.valid('param');
      const query = c.req.valid('query');
      const expired = query.exp < Date.now() / 1000;
      if (
        expired ||
        !(await verifyFileUrl(
          c.env.TOKEN_SECRET,
          userId,
          attachmentId,
          query.exp,
          query.sig,
        ))
      ) {
        throw new AppError(403, 'forbidden', '簽章網址無效或已過期');
      }
      unwrap(await hubFor(c.env, userId).chargeSignedFileRead());
      return serveBlob(c, userId, attachmentId, query.download === '1');
    },
  );
}
