import { constants, copyFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { fileExists, writeFileAtomic } from './fs.ts'
import { backupsDirectory, xdgConfigHome, type Environment } from './paths.ts'

/** Locates the global git config the way git does: home file first, XDG file otherwise. */
export function globalGitConfigPath(environment: Environment): string {
  const homeFile = join(environment.home, '.gitconfig')

  if (fileExists(homeFile)) return homeFile
  const xdgFile = join(xdgConfigHome(environment), 'git', 'config')

  if (fileExists(xdgFile)) return xdgFile

  return homeFile
}

function includedPath(line: string): string | null {
  const match = /^\s*path\s*=\s*(.*?)\s*$/.exec(line)

  return match ? match[1]!.replace(/^"(.*)"$/, '$1') : null
}

function hasInclude(content: string, managedPath: string): boolean {
  return content.split('\n').some((line) => includedPath(line) === managedPath)
}

export interface EnsureIncludeResult {
  backupPath: string | null
  changed: boolean
  globalConfigPath: string
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backUp(environment: Environment, source: string): string {
  const directory = backupsDirectory(environment)

  mkdirSync(directory, { recursive: true })

  // Never overwrite an earlier backup taken in the same millisecond.
  for (let attempt = 0; ; attempt++) {
    const backupPath = join(
      directory,
      `gitconfig-${timestamp()}${attempt === 0 ? '' : `-${attempt}`}`,
    )

    try {
      copyFileSync(source, backupPath, constants.COPYFILE_EXCL)

      return backupPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** Rewrites the existing global git config after taking a backup; returns the backup path, or null when nothing changed. */
export function rewriteGlobalConfig(
  environment: Environment,
  transform: (content: string) => string,
): string | null {
  const globalConfigPath = globalGitConfigPath(environment)
  const content = readFileSync(globalConfigPath, 'utf8')
  const rewritten = transform(content)

  if (rewritten === content) return null
  const backupPath = backUp(environment, globalConfigPath)

  writeFileAtomic(realpathSync(globalConfigPath), rewritten)

  return backupPath
}

/** Appends the single include of the managed file, backing the config up first when it already exists. */
export function ensureIncludeLine(
  environment: Environment,
  managedPath: string,
): EnsureIncludeResult {
  const globalConfigPath = globalGitConfigPath(environment)
  const existed = fileExists(globalConfigPath)
  const current = existed ? readFileSync(globalConfigPath, 'utf8') : ''

  if (hasInclude(current, managedPath))
    return { globalConfigPath, changed: false, backupPath: null }

  const backupPath = existed ? backUp(environment, globalConfigPath) : null

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  const include = `[include]\n\tpath = ${JSON.stringify(managedPath)}\n`
  const writeTarget = existed ? realpathSync(globalConfigPath) : globalConfigPath

  writeFileAtomic(writeTarget, `${current}${separator}${include}`)

  return { globalConfigPath, changed: true, backupPath }
}

/**
 * True when the global config sets the author or includes another file after the managed include,
 * so that setting wins over every Assignment.
 */
export function hasIdentitySettingsAfterInclude(
  environment: Environment,
  managedPath: string,
): boolean {
  const configPath = globalGitConfigPath(environment)

  if (!fileExists(configPath)) return false

  const lines = readFileSync(configPath, 'utf8').split('\n')
  const at = lines.findLastIndex((line) => includedPath(line) === managedPath)

  if (at < 0) return false

  let section = 'include'

  return lines.slice(at + 1).some((line) => {
    const header = /^\s*\[\s*([A-Za-z0-9.-]+)/.exec(line)

    if (header) {
      section = header[1]!.toLowerCase()

      return false
    }

    const key = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=/.exec(line)?.[1]?.toLowerCase()

    if (section === 'user') return key === 'name' || key === 'email'

    return (section === 'include' || section === 'includeif') && key === 'path'
  })
}

/** Moves the managed include to the end of the global config after a backup; returns the backup path. */
export function moveIncludeToEnd(environment: Environment, managedPath: string): string | null {
  return rewriteGlobalConfig(environment, (content) => {
    // The emptied `[include]` header stays: dropping it could move the user's next lines into another section.
    const body = content
      .split('\n')
      .filter((line) => includedPath(line) !== managedPath)
      .join('\n')

    return `${body}${body.endsWith('\n') || body.length === 0 ? '' : '\n'}[include]\n\tpath = ${JSON.stringify(managedPath)}\n`
  })
}
