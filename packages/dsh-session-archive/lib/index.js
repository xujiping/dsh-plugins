/**
 * dsh-session-archive — host half.
 *
 * Pure client-side plugin: the browser half (exports "./client") injects a
 * one-click "archive idle sessions" button onto every sidebar workspace row
 * and batch-archives idle sessions through the standard client services
 * (workspaces.archiveSession). The host process has nothing to do, but we
 * still export a valid cordis plugin shape so the profile loader registers
 * the plugin and pulls its client half into the web GUI.
 */

/** Stable cordis plugin name. */
export const name = 'session-archive'

/** Nothing to inject on the host side. */
export const inject = []

/** No-op host apply: all work happens in the browser half. */
export function apply() {}
