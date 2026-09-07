/** Generated-style Host descriptor kept in source until this package gains a Typert build step. */
import { importDshModule } from './dsh-runtime.js'

// dsh-typert-loader verifies Host descriptors are backed by actual zod v4
// instances. The Client stays dependency-free because its module table does
// not expose zod, but the Host can obtain DSH's shared runtime dependency.
const { z } = await importDshModule('zod')
const workspaceIdSchema = z.string().min(1)
const createSessionResultSchema = z.object({ sessionId: z.string().uuid() })

export const TYPERT = {
  package: 'dsh-cc-agent-driver',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-cc-agent-driver#ccNative/createSession',
      service: 'ccNative',
      namespace: 'ccNative',
      method: 'createSession',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'workspaceId',
          wire: 'workspaceId',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-cc-agent-driver#WorkspaceId', schema: workspaceIdSchema },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-cc-agent-driver#CreateSessionResult',
        schema: createSessionResultSchema,
      },
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    },
  ],
  model: { services: [], events: [], objects: [] },
}

export default TYPERT
