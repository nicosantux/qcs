import type { Core } from '../core/index.ts'

import { useEffect, useState } from 'react'

import { measureText } from '@opentui/core'

import art from './splash.txt' with { type: 'text' }
import { COLORS } from './theme.ts'

const TITLE = 'quien chota sos?'
const TITLE_FONT = 'tiny'
const TITLE_SIZE = measureText({ text: TITLE, font: TITLE_FONT })

const ART = art.trimEnd()
const ART_LINES = ART.split('\n')

export const ART_WIDTH = Math.max(...ART_LINES.map((line) => line.length))
export const ART_HEIGHT = ART_LINES.length

const TITLE_CHAR_MS = 20

export function SplashArt() {
  return (
    <text wrapMode='none' fg={COLORS.text}>
      {ART}
    </text>
  )
}

/** Whether the TUI opens on the splash; an unreadable setting keeps it on. */
export function showsSplash(core: Core): boolean {
  try {
    return core.loadShowSplash()
  } catch {
    return true
  }
}

/** Rows the splash needs besides the art: the two-row title and a blank line. */
export const SPLASH_EXTRA_ROWS = 3

/** Types the title inside a fixed-size box so the centered layout never shifts. */
export function Splash() {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (step >= TITLE.length) return

    const timer = setTimeout(() => setStep(step + 1), TITLE_CHAR_MS)

    return () => clearTimeout(timer)
  }, [step])

  const title = TITLE.slice(0, step)

  return (
    <box flexDirection='column' flexGrow={1} alignItems='center' justifyContent='center'>
      <box width={TITLE_SIZE.width} height={TITLE_SIZE.height}>
        {title !== '' && <ascii-font text={title} font={TITLE_FONT} color={COLORS.text} />}
      </box>
      <box height={1} />
      <SplashArt />
    </box>
  )
}
