/**
 * Client-half static smoke test for dsh-own-plugin-manager.
 *
 * 静态断言（源码级约束，避免 GUI 环境依赖）：
 *   1. 必须以 window.__ModuleLoader__.load 包裹并导出 apply/inject；
 *   2. 面板/菜单/弹层必须挂 document.body（React 树外）；
 *   3. 必须有 MutationObserver 自愈与挂载失败只 warn 的兜底；
 *   4. 配色必须走 --dsw-alias-* / --dsw-specific-* token；
 *   5. 只用纯色：禁止 linear-gradient / radial-gradient；
 *   6. 禁止原生 prompt/alert/confirm（DSH Web GUI 下会静默失败）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 1. module loader shape
assert.match(client, /window\.__ModuleLoader__\.load\(\s*\{\s*id: 'dsh-own-plugin-manager'/)
assert.match(client, /module\.exports = \{ apply: applyClient, inject: \[\] \}/)

// 2. overlays live outside the React tree
assert.match(client, /document\.body\.append\(menuEl\)/)
assert.match(client, /document\.body\.append\(panelEl\)/)
assert.match(client, /document\.head\.append\(style\)/)

// 3. self-healing observer + never-fatal mounting
assert.match(client, /new MutationObserver\(/)
assert.match(client, /console\.warn\('\[own-plugin-manager\]/)

// 4. official design tokens only
assert.match(client, /--dsw-alias-label-primary/)
assert.match(client, /--dsw-alias-button-info-fill/)
assert.match(client, /--dsw-specific-sidebar-fill/)
assert.match(client, /--dsw-alias-state-warn-primary/)

// 5. solid colors only — no gradients
assert.doesNotMatch(client, /linear-gradient|radial-gradient|conic-gradient/)

// 6. no native blocking dialogs
assert.doesNotMatch(client, /window\.(prompt|alert|confirm)\(/)
assert.doesNotMatch(client, /(^|[^.\w])(prompt|alert|confirm)\(/)

// 7. hits the host routes defined in lib/index.js
assert.match(client, /\/api\/dsh-opm\/state/)
assert.match(client, /\/api\/dsh-opm\/refresh/)
assert.match(client, /\/api\/dsh-opm\/toggle/)
assert.match(client, /\/api\/dsh-opm\/ack/)

// 8. coexists with dsh-web-sites in the same sidebar slot
assert.match(client, /\.dws-menu/)

console.log('client smoke: 8/8 ok')
