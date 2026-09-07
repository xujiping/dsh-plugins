/**
 * dsh-new-session-route — host half.
 *
 * Pure client-side plugin: the browser half (exports "./client") hooks the
 * sidebar「新会话」button and shows a route dropdown, then starts the new
 * session through the standard client services (workspaces.connectWorkspace +
 * api.sessions.selectModel). The host process has nothing to do, but we still
 * export a valid cordis plugin shape so the profile loader registers the
 * plugin and pulls its client half into the web GUI.
 */

/** Stable cordis plugin name. */
export const name = 'new-session-route'

/** Nothing to inject on the host side. */
export const inject = []

/** No-op host apply: all work happens in the browser half. */
export function apply() {}
