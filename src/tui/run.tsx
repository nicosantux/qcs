import type { Core } from '../core/index.ts'

import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'

import { App } from './app.tsx'

export async function runTui(core: Core): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const closed = new Promise<void>((resolve) => renderer.once('destroy', resolve))

  createRoot(renderer).render(<App core={core} onQuit={() => renderer.destroy()} />)
  await closed
}
