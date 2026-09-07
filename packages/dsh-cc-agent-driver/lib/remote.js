/** Client Typert descriptor. Keep this in sync with ./typert.js. */
import { createSessionResultSchema, workspaceIdSchema } from './contract.js'

export const TYPERT_REMOTE = {
  package: 'dsh-cc-agent-driver',
  descriptors: [
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
}

export default TYPERT_REMOTE
