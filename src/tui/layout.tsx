import type { BoxRenderable, RGBA } from '@opentui/core'
import type { InputProps } from '@opentui/react'

import { createContext, useContext, useState, type ReactNode } from 'react'

import { useTerminalDimensions } from '@opentui/react'

import { BOLD, COLORS, SELECTED } from './theme.ts'

/** Below this many columns the side pane is hidden and dialogs take the main pane. */
const SIDE_PANE_MIN_WIDTH = 100

/** Header and the two pane borders. */
const CHROME_ROWS = 3

export interface Pane {
  body: ReactNode
  /** Asks to confirm something that cannot be undone. */
  danger?: boolean
  title: string
}

export function useWide(): boolean {
  return useTerminalDimensions().width >= SIDE_PANE_MIN_WIDTH
}

/** The rows inside the panes, measured once laid out; estimated from the terminal until then. */
export function usePaneRows(): [number, (this: BoxRenderable) => void] {
  const { height } = useTerminalDimensions()
  const [measured, setMeasured] = useState<number | null>(null)

  return [
    Math.max(measured ?? height - CHROME_ROWS, 1),
    function (this: BoxRenderable) {
      setMeasured(this.height - 2)
    },
  ]
}

export interface PanesProps {
  children: ReactNode
  /** Shown beside the main pane on wide terminals. */
  detail?: Pane | null
  /** Takes the side pane on wide terminals and the main pane on narrow ones. */
  dialog?: Pane | null
  footer?: ReactNode
  onSizeChange?: (this: BoxRenderable) => void
  /** Floats centered over both panes. */
  popup?: Pane | null
  title: string
}

const dialogBorder = (pane: Pane) => (pane.danger ? COLORS.error : COLORS.accent)

export function Panes({
  children,
  detail,
  dialog,
  footer,
  onSizeChange,
  popup,
  title,
}: PanesProps) {
  const wide = useWide()
  const main = !wide && dialog ? dialog : { title, body: children }
  const side = wide ? (dialog ?? detail) : null
  const mainActive = main === dialog ? !popup : !dialog && !popup

  const mainBorder =
    main === dialog ? dialogBorder(dialog) : mainActive ? COLORS.text : COLORS.muted

  return (
    <box flexDirection='column' flexGrow={1}>
      <box flexDirection='row' flexGrow={1} onSizeChange={onSizeChange}>
        <box
          border
          title={main.title}
          borderColor={mainBorder}
          flexDirection='column'
          flexGrow={1}
          flexBasis={0}
          paddingX={1}
        >
          <PaneActive value={mainActive}>{main.body}</PaneActive>
        </box>
        {side && (
          <box
            border
            title={side.title}
            borderColor={side === dialog ? dialogBorder(dialog) : COLORS.muted}
            flexDirection='column'
            width='40%'
            paddingX={1}
          >
            <PaneActive value={side === dialog && !popup}>{side.body}</PaneActive>
          </box>
        )}
        {popup && (
          <box
            position='absolute'
            width='100%'
            height='100%'
            alignItems='center'
            justifyContent='center'
            zIndex={1}
          >
            <box
              border
              title={popup.title}
              flexDirection='column'
              paddingX={1}
              width='80%'
              maxWidth={90}
              borderColor={dialogBorder(popup)}
              backgroundColor={COLORS.background}
            >
              {popup.body}
            </box>
          </box>
        )}
      </box>
      {footer}
    </box>
  )
}

const RowSelected = createContext(false)

/** False while a dialog or popup has the keyboard, so the pane's selection steps back. */
const PaneActive = createContext(true)

/** Colored text in a list row; a selected row draws it in its own inverse colors, because inverse would paint the color on itself. */
export function Tint({ children, color }: { children: ReactNode; color: RGBA }) {
  return <span fg={useContext(RowSelected) ? COLORS.text : color}>{children}</span>
}

export function Muted({ children }: { children: ReactNode }) {
  return <Tint color={COLORS.muted}>{children}</Tint>
}

/** A list line marked with `>` and the terminal's inverse colors when selected; clipped at the end, so lead with what matters. */
export function ListRow({ children, selected }: { children: ReactNode; selected: boolean }) {
  const active = useContext(PaneActive)
  const highlighted = selected && active

  return (
    <RowSelected value={highlighted}>
      <text wrapMode='none' fg={COLORS.text}>
        {selected ? '> ' : '  '}
        <span attributes={highlighted ? SELECTED : 0}>{children}</span>
      </text>
    </RowSelected>
  )
}

/** A label and value line for the side panes. */
export function Field({ label, children }: { children: ReactNode; label: string }) {
  return (
    <text wrapMode='none' truncate fg={COLORS.text}>
      <span fg={COLORS.muted}>{`${label.padEnd(9)} `}</span>
      {children}
    </text>
  )
}

/** A line of plain text in the terminal's own foreground. */
export function Line({ children }: { children: ReactNode }) {
  return <text fg={COLORS.text}>{children}</text>
}

/** An input in the terminal's own colors; OpenTUI defaults to hardcoded white and grays. */
export function Input(props: InputProps) {
  return (
    <input
      textColor={COLORS.text}
      focusedTextColor={COLORS.text}
      placeholderColor={COLORS.muted}
      backgroundColor={COLORS.background}
      focusedBackgroundColor={COLORS.background}
      cursorColor={COLORS.text}
      flexGrow={1}
      {...props}
    />
  )
}

/** The closing question of a confirmation, in red when it removes something. */
export function Confirm({ danger = false, question }: { danger?: boolean; question: string }) {
  return (
    <text fg={danger ? COLORS.error : COLORS.accent} attributes={BOLD}>
      {`${question} (y/n)`}
    </text>
  )
}

/** The first of `visible` rows to show so that the selected one stays centered. */
export function windowStart(selected: number, visible: number, total: number): number {
  return Math.max(0, Math.min(selected - Math.floor(visible / 2), total - visible))
}

export const isDown = ({ name }: { name: string }) => name === 'j' || name === 'down'
export const isUp = ({ name }: { name: string }) => name === 'k' || name === 'up'

export type Hint = readonly [keys: string, action: string, color?: RGBA]

/** Key hints that wrap between hints, never inside one. */
export function Hints({ hints }: { hints: readonly Hint[] }) {
  return (
    <box flexDirection='row' flexWrap='wrap' columnGap={2}>
      {hints.map(([keys, action, color = COLORS.muted]) => (
        <text key={keys} fg={COLORS.text} wrapMode='none'>
          <span attributes={BOLD}>{keys}</span>
          <span fg={color}>{` ${action}`}</span>
        </text>
      ))}
    </box>
  )
}

export interface Notice {
  text: string
  tone: 'error' | 'info' | 'success'
}

const TONE_COLORS = { error: COLORS.error, info: COLORS.accent, success: COLORS.success } as const

export function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null

  return (
    <text fg={TONE_COLORS[notice.tone]}>
      {`${notice.tone === 'error' ? 'Error: ' : ''}${notice.text}`}
    </text>
  )
}
