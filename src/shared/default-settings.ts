import type { AppSettings } from './ipc-contracts'
import { DEFAULT_COUNCIL_CONFIG } from './council-config'
import { DEFAULT_SIDEBAR_WIDTH } from './sidebar-width'
import { SYSTEM_LANGUAGE } from './i18n/languages'

/**
 * The single source of truth for default app settings. Used by the main process
 * to seed settings.json on first run, and by the renderer's Settings panel for
 * its "Reset to defaults" action and initial field values. Change a default here
 * and it applies everywhere.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  piExecutablePath: 'pi',
  piEngine: 'auto',
  defaultArgs: [],
  theme: 'system',
  systemLightTheme: 'light',
  systemDarkTheme: 'dark',
  defaultModel: null,
  defaultProvider: null,
  defaultCwd: null,
  fontSize: 16,
  terminalFontSize: 12,
  codeEditorFontSize: 14,
  showThinking: true,
  autoScroll: true,
  permissionMode: 'ask-edits',
  permissionRulesAckWorkspaces: [],
  resumeLastSession: true,
  collapsedSessionGroups: [],
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  // Boot Pi with the app rather than waiting for a first action from Home.
  // Starting on the Home screen left the agent unstarted with no visible reason,
  // which reads as a broken app rather than a deliberate lazy start.
  openToHomeOnLaunch: false,
  runOnStartup: false,
  minimizeToTrayOnClose: false,
  hasSeenTrayHint: false,
  desktopNotifications: true,
  language: SYSTEM_LANGUAGE,
  council: DEFAULT_COUNCIL_CONFIG,
}
