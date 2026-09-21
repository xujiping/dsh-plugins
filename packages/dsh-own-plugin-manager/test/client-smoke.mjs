/**
 * Client-half static smoke test for dsh-own-plugin-manager.
 *
 * 静态断言（源码级约束，避免 GUI 环境依赖）：
 *   1. 必须以 window.__ModuleLoader__.load 包裹并导出 apply/inject: ['slots']；
 *   2. 必须注册官方 settings.section slot（设置分区，带 id/order/label）；
 *   3. 必须有 ErrorBoundary 兜底（渲染崩溃不 blank 整个设置对话框）；
 *   4. 配色必须走 --dsw-alias-* / --dsw-specific-* token；
 *   5. 只用纯色：禁止 linear-gradient / radial-gradient；
 *   6. 禁止原生 prompt/alert/confirm（DSH Web GUI 下会静默失败）；
 *   7. 不得残留旧侧边栏方案（sidebar 插槽锚定 / dws-menu 协调 / MutationObserver）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 1. module loader shape + slots service declaration
assert.match(client, /window\.__ModuleLoader__\.load\(\s*\{\s*id: 'dsh-own-plugin-manager'/)
assert.match(client, /require\('react'\)/)
assert.match(client, /module\.exports = \{ apply: applyClient, inject: \['slots'\] \}/)

// 2. registers the official settings.section slot
assert.match(client, /ctx\.slots\.inject\('settings\.section', \(\) => ctx\.slots\.register\(\{/)
assert.match(client, /name: 'settings\.section',\s*id: SECTION_ID,\s*order: 34,\s*label: NavLabel,/)
assert.match(client, /const SECTION_ID = 'own-plugin-manager'/)
assert.match(client, /data-settings-nav-label/)
assert.match(client, /button:has\(\[data-settings-nav-label="\$\{SECTION_ID\}"\]\) > svg:first-child/)

// 3. error boundary wraps the section
assert.match(client, /getDerivedStateFromError/)
assert.match(client, /componentDidCatch/)
assert.match(client, /SectionErrorBoundary, null,/)

// 3b. style tag still plugin-tagged in head; toast outside React tree
assert.match(client, /document\.head\.append\(style\)/)
assert.match(client, /document\.body\.append\(toastEl\)/)

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

// 8. legacy sidebar approach fully removed
assert.doesNotMatch(client, /sidebar\.workspaces/)
assert.doesNotMatch(client, /\.dws-menu/)
assert.doesNotMatch(client, /new MutationObserver\(/)

// 9. React prop hygiene: no raw `class:` props (must be className)
assert.doesNotMatch(client, /\bclass: /)

console.log('client smoke: all ok')
