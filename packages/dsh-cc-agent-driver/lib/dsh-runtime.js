import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// An installed package resolves peer dependencies normally. A local `link:`
// package is realpathed by Node, however, which makes direct source tests miss
// the profile's node_modules. This fallback keeps local development honest
// without changing the production resolution path.
export async function importDshModule(specifier) {
  try {
    return await import(specifier)
  } catch (primaryError) {
    const root = process.env.DSH_PROFILE_NODE_MODULES ?? '/Users/xujiping/.dsh/profiles/node_modules'
    try {
      const resolveFromProfile = createRequire(join(root, '__dsh_cc_agent_driver__.cjs'))
      return await import(pathToFileURL(resolveFromProfile.resolve(specifier)).href)
    } catch {
      throw primaryError
    }
  }
}
