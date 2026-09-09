/** Client Typert descriptor. Keep this in sync with ./typert.js. */
import {
  createSessionResultSchema,
  permissionModeSchema,
  permissionStateResultSchema,
  sessionIdSchema,
  workspaceIdSchema,
} from './contract.js'

function descriptorOf(service, method, parameters, result) {
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

function descriptorsFor(service) {
  return [
    descriptorOf(service, 'createSession', [{
      name: 'workspaceId',
      wire: 'workspaceId',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#WorkspaceId', schema: workspaceIdSchema },
    }], {
      mode: 'strict',
      typeSymbol: 'dsh-agent-driver#CreateSessionResult',
      schema: createSessionResultSchema,
    }),
    descriptorOf(service, 'getPermission', [{
      name: 'sessionId',
      wire: 'sessionId',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: 'dsh-agent-driver#SessionId', schema: sessionIdSchema },
    }], {
      mode: 'strict',
      typeSymbol: 'dsh-agent-driver#PermissionStateResult',
      schema: permissionStateResultSchema,
    }),
    descriptorOf(service, 'setPermission', [
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

export const TYPERT_REMOTE = {
  package: 'dsh-agent-driver',
  descriptors: [
    ...descriptorsFor('nativeAgent'),
    ...descriptorsFor('hermesAgent'),
  ],
}

export default TYPERT_REMOTE
