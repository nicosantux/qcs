import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function writeFileAtomic(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`

  writeFileSync(temp, content)
  renameSync(temp, target)
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}

/** Detects it by checking whether the same path with swapped letter case resolves to the same place. */
export function isCaseInsensitiveFileSystem(directory: string): boolean {
  const swapped = [...directory]
    .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    .join('')

  return swapped !== directory && existsSync(swapped)
}

export function isInside(path: string, folder: string): boolean {
  const [target, container] = isCaseInsensitiveFileSystem(folder)
    ? [path.toLowerCase(), folder.toLowerCase()]
    : [path, folder]

  return target === container || target.startsWith(`${container}/`)
}

/** Git matches `gitdir:` patterns against the real path, so symlinks must be resolved first. */
export function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Git matches `gitdir:` patterns against the git directory, which for a linked worktree or submodule lives elsewhere. */
export function gitDirectoryOf(repositoryPath: string): string {
  const dotGit = join(repositoryPath, '.git')

  if (statSync(dotGit, { throwIfNoEntry: false })?.isDirectory() !== false) return dotGit

  try {
    const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]

    return target === undefined ? dotGit : resolve(repositoryPath, target.trim())
  } catch {
    return dotGit
  }
}
