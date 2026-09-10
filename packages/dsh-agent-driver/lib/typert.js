/** Generated-style Host descriptor kept in source until this package gains a Typert build step. */
import { importDshModule } from './dsh-runtime.js'

// dsh-typert-loader verifies Host descriptors are backed by actual zod v4
// instances. The Client stays dependency-free because its module table does
// not expose zod, but the Host can obtain DSH's shared runtime dependency.
const { z } = await importDshModule('zod')
const workspaceIdSchema = z.string().min(1)
// DSH 默认会话是 `session-<uuid>`，而本插件创建的原生会话是裸 UUID。
const sessionIdSchema = z.string().regex(/^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
// 两个 driver（Claude Code / Hermes）的权限档位并集；会话级校验由各网关完成。
const permissionModeSchema = z.enum(['plan', 'acceptEdits', 'auto', 'default', 'yolo'])
const createSessionResultSchema = z.object({ sessionId: z.string().uuid() })
const permissionStateResultSchema = z.object({
  permissionMode: permissionModeSchema,
  effectivePermissionMode: z.string().optional(),
  // 展示性字段：CLI 实际使用的模型（Claude init 事件 / Hermes status 探测）。
  model: z.string().optional(),
})

function invocationOf(service, method, parameters, result) {
  return {
    id: `dsh-agent-driver#${service}/${method}`,
    service,
    namespace: service,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result,
    sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
  }
}

function invocationsFor(service) {
  return [
    invocationOf(service, 'getModels', [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema } }], {
      mode: 'strict', typeSymbol: 'dsh-agent-driver#ModelList', schema: z.array(z.object({ id: z.string().min(1), label: z.string(), description: z.string(), providerId: z.string().optional(), providerLabel: z.string().optional(), current: z.boolean().optional() })),
    }),
    invocationOf(service, 'setModel', [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema } },
      { name: 'modelId', wire: 'modelId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#ModelId', schema: z.string().min(1) } },
    ], { mode: 'strict', typeSymbol: 'dsh-agent-driver#PermissionStateResult', schema: permissionStateResultSchema }),
    invocationOf(service, 'createSession', [{
      name: 'workspaceId',
      wire: 'workspaceId',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#WorkspaceId', schema: workspaceIdSchema },
    }], {
      mode: 'strict',
      typeSymbol: 'dsh-agent-driver#CreateSessionResult',
      schema: createSessionResultSchema,
    }),
    invocationOf(service, 'getPermission', [{
      name: 'sessionId',
      wire: 'sessionId',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema },
    }], {
      mode: 'strict',
      typeSymbol: 'dsh-agent-driver#PermissionStateResult',
      schema: permissionStateResultSchema,
    }),
    invocationOf(service, 'setPermission', [
      {
        name: 'sessionId',
        wire: 'sessionId',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema },
      },
      {
        name: 'permissionMode',
        wire: 'permissionMode',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#PermissionMode', schema: permissionModeSchema },
      },
    ], {
      mode: 'strict',
      typeSymbol: 'dsh-agent-driver#PermissionStateResult',
      schema: permissionStateResultSchema,
    }),
  ]
}

export const TYPERT = {
  package: 'dsh-agent-driver',
  face: 'host',
  schemas: [],
  invocations: [
    ...invocationsFor('nativeAgent'),
    ...invocationsFor('hermesAgent'),
  ],
  model: { services: [], events: [], objects: [] },
}

export default TYPERT
