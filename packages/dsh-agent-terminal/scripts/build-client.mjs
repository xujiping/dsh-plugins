/**
 * Build the browser half into lib/client.js in dsh's client-module format.
 *
 * dsh does NOT load plugin client bundles as ES modules. Executing the
 * bundle must only REGISTER a factory — everything else (CSS injection
 * included) runs at materialization:
 *
 *   window.__ModuleLoader__.load({ id: "<pkg name>", factory: (require) => {
 *     var module = { exports: {} }
 *     var exports = module.exports
 *     // … bundle body (CJS interop assigns exports.apply / exports.inject)
 *     return module.exports
 *   }})
 *
 * So we bundle as CJS and wrap with the registration banner/footer —
 * identical shape to the official @deepseek-ai/dsh-client-ui-* bundles.
 * Building with `--format=esm` instead yields a module that never calls
 * __ModuleLoader__.load, and dsh fails with:
 *   "bundle … loaded without registering … via __ModuleLoader__.load".
 *
 * Run: node scripts/build-client.mjs   (esbuild from node_modules, dev-only)
 */

import { build } from 'esbuild'

const banner = `window.__ModuleLoader__.load({
	id: "dsh-agent-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`

const footer = `		return module.exports;
	},
});`

await build({
  entryPoints: ['src/client.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  minify: true,
  loader: { '.css': 'text' },
  banner: { js: banner },
  footer: { js: footer },
  outfile: 'lib/client.js',
  logLevel: 'info',
})
