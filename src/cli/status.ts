import type { Origin, Resolution } from '../core/index.ts'

import { signingKeyOf } from '../core/index.ts'

type KnownResolution = Extract<Resolution, { status: 'known' }>

export interface StatusReport {
  exitCode: number
  lines: string[]
}

const ORIGIN_LABELS: Record<Origin, string> = {
  default: 'Default Identity',
  'external-rule': 'External Rule (git config not managed by qcs)',
  'folder-scope': 'Folder Scope',
  none: 'nothing configures an author',
  'remote-scope': 'Remote Scope',
  'repo-scope': 'Repo Scope',
}

export const NOT_A_REPOSITORY_MESSAGE = 'Current directory is not inside a git repository.'

function describeKey({
  identity,
  sshKey,
  sshCommandOverriddenByEnvironment,
}: KnownResolution): string {
  const path = identity.sshKey ?? ''

  if (sshKey === 'used') {
    return sshCommandOverriddenByEnvironment
      ? `${path} (overridden by GIT_SSH_COMMAND)`
      : `${path} (pushes use it)`
  }

  if (sshKey === 'stale')
    return `${path} is missing on this Machine, pushes fail until you open qcs`
  if (sshKey === 'missing')
    return `${path} is missing on this Machine, pushes use your normal SSH setup`
  if (identity.sshKey !== null) return `${path} is not in effect, pushes use your normal SSH setup`

  return 'none, pushes use your normal SSH setup'
}

function describeSigning(path: string, { signingKey }: KnownResolution): string {
  if (signingKey === 'used') return `${path} (commits are signed)`
  if (signingKey === 'stale')
    return `${path} is missing on this Machine, commits fail until you open qcs`
  if (signingKey === 'missing') return `${path} is missing on this Machine, commits are not signed`

  return `${path} is not in effect, commits are not signed`
}

export function formatStatus(resolution: Resolution): StatusReport {
  if (resolution.status === 'not-a-repository') {
    const { folderScope } = resolution
    const lines = [NOT_A_REPOSITORY_MESSAGE]

    if (folderScope) {
      lines.push(
        `Folder Scope ${folderScope.displayPath} assigns ${folderScope.identity.label} to the repositories inside it.`,
      )
    }

    return { lines, exitCode: 2 }
  }

  const lines: string[] = []
  let exitCode = 0

  if (resolution.status === 'known') {
    const { identity } = resolution

    lines.push(`Identity: ${identity.label}`)
    lines.push(`Author:   ${identity.name} <${identity.email}>`)
    lines.push(`SSH key:  ${describeKey(resolution)}`)

    const signingKey = signingKeyOf(identity)

    if (signingKey !== null) lines.push(`Signing:  ${describeSigning(signingKey, resolution)}`)
  } else {
    exitCode = 1
    const author =
      resolution.name || resolution.email
        ? `${resolution.name ?? '(no name)'} <${resolution.email ?? 'no email'}>`
        : '(none)'

    lines.push('Unknown Identity')
    lines.push(`Author:   ${author}`)
  }

  lines.push(`Origin:   ${ORIGIN_LABELS[resolution.origin]}`)

  if (resolution.sshCommandOverriddenByEnvironment) {
    lines.push('Note:     GIT_SSH_COMMAND is set and overrides core.sshCommand')
  }

  return { lines, exitCode }
}
