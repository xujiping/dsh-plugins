/**
 * Browser-half smoke test: the memory editor must register as a first-level
 * Settings section, rather than relying on a sidebar DOM injection.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let definition = null
const context = {
  console,
  Symbol,
  window: {
    __ModuleLoader__: {
      load(value) { definition = value },
    },
  },
}
vm.runInNewContext(source, context, { filename: 'client.js' })
assert.ok(definition, 'client module should register with the DSH module loader')

const React = {
  createElement() { return null },
  useEffect() {},
  useRef() { return { current: null } },
}
const client = definition.factory((name) => {
  assert.equal(name, 'react')
  return React
})
assert.deepEqual([...client.inject], ['slots'])

let registration = null
client.apply({
  slots: {
    inject(name, callback) {
      assert.equal(name, 'settings.section')
      return callback()
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
  effect() {},
})

assert.equal(registration?.options.name, 'settings.section')
assert.equal(registration?.options.id, 'global-memory')
assert.equal(registration?.options.order, 120)
assert.equal(registration?.options.label(), '全局记忆')
assert.equal(typeof registration?.component, 'function')
console.log('CLIENT SETTINGS SMOKE TEST PASSED')
