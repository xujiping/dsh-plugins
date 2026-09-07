/** Client Typert descriptor. Keep this in sync with ./typert.js. */
import {
  createSessionResultSchema,
  permissionModeSchema,
  permissionStateResultSchema,
  sessionIdSchema,
  workspaceIdSchema,
} from './contract.js'

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
    {
      id: 'dsh-cc-agent-driver#ccNative/getPermission',
      service: 'ccNative',
      namespace: 'ccNative',
      method: 'getPermission',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionId',
          wire: 'sessionId',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-cc-agent-driver#SessionId', schema: sessionIdSchema },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-cc-agent-driver#PermissionStateResult',
        schema: permissionStateResultSchema,
      },
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    },
    {
      id: 'dsh-cc-agent-driver#ccNative/setPermission',
      service: 'ccNative',
      namespace: 'ccNative',
      method: 'setPermission',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionId',
          wire: 'sessionId',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-cc-agent-driver#SessionId', schema: sessionIdSchema },
        },
        {
          name: 'permissionMode',
          wire: 'permissionMode',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-cc-agent-driver#PermissionMode', schema: permissionModeSchema },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-cc-agent-driver#PermissionStateResult',
        schema: permissionStateResultSchema,
      },
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    },
  ],
}

export default TYPERT_REMOTE
