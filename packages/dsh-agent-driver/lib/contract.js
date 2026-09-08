/**
 * Typert only requires a synchronous parse() boundary for strict codecs.
 * Keeping these tiny, isomorphic schemas in source avoids a client-module
 * external dependency: DSH's browser module table intentionally does not
 * expose zod to arbitrary plugins.
 */
function invalid(subject) {
  return new TypeError(`agent-driver: invalid ${subject}`)
}

export const workspaceIdSchema = Object.freeze({
  parse(value) {
    if (typeof value !== 'string' || value.length === 0) throw invalid('workspaceId')
    return value
  },
})

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const CLAUDE_PERMISSION_MODES = Object.freeze(['plan', 'acceptEdits', 'auto'])

export const sessionIdSchema = Object.freeze({
  parse(value) {
    if (typeof value !== 'string' || !uuid.test(value)) throw invalid('sessionId')
    return value
  },
})

export const permissionModeSchema = Object.freeze({
  parse(value) {
    if (!CLAUDE_PERMISSION_MODES.includes(value)) throw invalid('permissionMode')
    return value
  },
})

export const createSessionResultSchema = Object.freeze({
  parse(value) {
    if (value === null || typeof value !== 'object' || !uuid.test(value.sessionId)) {
      throw invalid('createSession result')
    }
    // Match z.object({ sessionId: z.string().uuid() }): retain the contract
    // field and do not let untyped transport fields enter the client surface.
    return { sessionId: value.sessionId }
  },
})

export const permissionStateResultSchema = Object.freeze({
  parse(value) {
    if (value === null || typeof value !== 'object') throw invalid('permission state result')
    const permissionMode = permissionModeSchema.parse(value.permissionMode)
    const effectivePermissionMode = value.effectivePermissionMode
    if (effectivePermissionMode !== undefined && typeof effectivePermissionMode !== 'string') {
      throw invalid('permission state result')
    }
    return effectivePermissionMode === undefined ? { permissionMode } : { permissionMode, effectivePermissionMode }
  },
})
