import type { ImportPlan } from '../core/index.ts'

import type { ReactNode } from 'react'

import { Line } from './layout.tsx'
import { COLORS } from './theme.ts'

export interface ImportPreviewProps {
  error: string | null
  footer: ReactNode
  plan: ImportPlan
  /** Rows available; folders that do not fit are summed up in one line. */
  rows: number
}

/** The body of the import dialog; the caller titles it "Import existing configuration". */
export function ImportPreview({ plan, footer, error, rows }: ImportPreviewProps) {
  // The note can wrap to two lines on narrow terminals.
  const fixed = (plan.defaultIdentity === null ? 0 : 1) + 3 + (error === null ? 0 : 1)
  const room = Math.max(rows - fixed, 1)
  const shown = plan.folders.length > room ? room - 1 : room

  return (
    <>
      {plan.defaultIdentity !== null && (
        <Line>{`Default Identity  ${plan.defaultIdentity.name} <${plan.defaultIdentity.email}>`}</Line>
      )}
      {plan.folders.slice(0, shown).map(({ path, displayPath, name, email, removed }) => (
        <text key={path} wrapMode='none' truncate fg={COLORS.text}>
          {`${displayPath}  ${name} <${email}>`}
          {!removed && <span fg={COLORS.muted}>{'  (rule stays: it sets other things too)'}</span>}
        </text>
      ))}
      {plan.folders.length > shown && (
        <text fg={COLORS.muted}>{`...and ${plan.folders.length - shown} more`}</text>
      )}
      <text fg={COLORS.muted}>
        {'Imported blocks are removed from your git config after a backup. Anything else stays.'}
      </text>
      {error !== null && <text fg={COLORS.error}>{`Error: ${error}`}</text>}
      {footer}
    </>
  )
}
