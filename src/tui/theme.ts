import { RGBA, TextAttributes } from '@opentui/core'

/**
 * ANSI palette slots and the terminal's default colors, so the TUI follows the user's terminal theme.
 * Never pass a hex or RGB color: OpenTUI falls back to hardcoded white when a color prop is omitted, so set one on every text, border and input.
 */
export const COLORS = {
  /** Dialogs and informational notices. */
  accent: RGBA.fromIndex(4),
  background: RGBA.defaultBackground(),
  error: RGBA.fromIndex(1),
  muted: RGBA.fromIndex(8),
  success: RGBA.fromIndex(2),
  text: RGBA.defaultForeground(),
  /** Alerts that need attention but are not errors. */
  warning: RGBA.fromIndex(3),
} as const

/** Swaps the terminal's own foreground and background, so a selection stays legible in any theme. */
export const SELECTED = TextAttributes.INVERSE

export const BOLD = TextAttributes.BOLD
