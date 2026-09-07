/**
 * dsh-desktop-pet — host half.
 *
 * This plugin is pure client-side: the browser half (exports "./client")
 * mounts a desktop pet overlay in the DSH web GUI, so the host process has
 * nothing to do. Pet position/mood are persisted in localStorage by the
 * client half. We still export a valid cordis plugin shape (name + apply)
 * so the profile loader registers the plugin and thereby pulls its client
 * half into the web GUI.
 */

/** Stable cordis plugin name. */
export const name = 'desktop-pet'

/** Nothing to inject on the host side. */
export const inject = []

/** No-op host apply: all work happens in the browser half. */
export function apply() {}
