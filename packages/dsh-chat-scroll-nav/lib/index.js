/**
 * dsh-chat-scroll-nav — host half.
 *
 * This plugin is pure client-side: the browser half (exports "./client")
 * injects a quick-nav rail into the DSH chat conversation, so the host
 * process has nothing to do. We still export a valid cordis plugin shape
 * (name + apply) so the profile loader registers the plugin and thereby
 * pulls its client half into the web GUI.
 */

/** Stable cordis plugin name. */
export const name = 'chat-scroll-nav'

/** Nothing to inject on the host side. */
export const inject = []

/** No-op host apply: all work happens in the browser half. */
export function apply() {}
