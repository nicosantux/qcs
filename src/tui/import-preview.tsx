import type { ImportPlan } from '../core/index.ts'

import type { ReactNode } from 'react'

import { Line } from './layout.tsx'
import { COLORS } from './theme.ts'

export interface ImportPreviewProps {
  error: string | null
  footer: ReactNode
  plan: ImportPlan
}

/** The body of the import dialog; the caller titles it "Import existing configuration". */
export function ImportPreview({ plan, footer, error }: ImportPreviewProps) {
  return (
    <>
      {plan.defaultIdentity !== null && (
        <Line>{`Default Identity  ${plan.defaultIdentity.name} <${plan.defaultIdentity.email}>`}</Line>
      )}
      {plan.folders.map(({ path, displayPath, name, email, removed }) => (
        <text key={path} fg={COLORS.text}>
          {`${displayPath}  ${name} <${email}>`}
          {!removed && <span fg={COLORS.muted}>{'  (rule stays: it sets other things too)'}</span>}
        </text>
      ))}
      <text fg={COLORS.muted}>
        {'Imported blocks are removed from your git config after a backup. Anything else stays.'}
      </text>
      {error !== null && <text fg={COLORS.error}>{`Error: ${error}`}</text>}
      {footer}
    </>
  )
}
