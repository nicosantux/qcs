import { statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { stringify } from 'smol-toml'

import { collapseHome, ConfigError, readTomlFile } from './config-store.ts'
import { isCaseInsensitiveFileSystem, writeFileAtomic } from './fs.ts'
import { configDirectory, expandHome, type Environment } from './paths.ts'

export interface ScanRoot {
  displayPath: string
  maxDepth: number
  path: string
}

export interface FolderScope {
  displayPath: string
  identityId: string
  path: string
}

/** Re-pointing would replace the Assignment that gives `existing.path` to another Identity. */
export class AssignmentConflictError extends ConfigError {
  override name = 'AssignmentConflictError'

  constructor(readonly existing: FolderScope) {
    super(`"${existing.displayPath}" is already assigned to "${existing.identityId}"`)
  }
}

export const DEFAULT_MAX_DEPTH = 4

function isValidDepth(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1
}

export function machineFilePath(environment: Environment): string {
  return join(configDirectory(environment), 'machine.toml')
}

function readDocument(environment: Environment): Record<string, unknown> {
  return readTomlFile(machineFilePath(environment)) ?? {}
}

export function loadScanRoots(environment: Environment): ScanRoot[] {
  const entries = readDocument(environment).scan_roots ?? []

  if (!Array.isArray(entries)) {
    throw new ConfigError('machine.toml: "scan_roots" must be an array of tables')
  }

  return entries.map((entry: Record<string, unknown>) => {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new ConfigError('machine.toml: every scan root needs a non-empty "path"')
    }

    const maxDepth = entry.max_depth ?? DEFAULT_MAX_DEPTH

    if (!isValidDepth(maxDepth)) {
      throw new ConfigError(
        `machine.toml: scan root "${entry.path}" needs a "max_depth" that is a whole number of at least 1`,
      )
    }

    const path = expandHome(entry.path, environment.home)

    return { path, displayPath: collapseHome(path, environment.home), maxDepth }
  })
}

/** Whether the TUI opens on the splash screen; on unless `splash = false`. */
export function loadShowSplash(environment: Environment): boolean {
  const splash = readDocument(environment).splash ?? true

  if (typeof splash !== 'boolean')
    throw new ConfigError('machine.toml: "splash" must be true or false')

  return splash
}

/** `splash` is only written when off, so it stays an optional override. */
export function saveShowSplash(environment: Environment, show: boolean): void {
  const { splash: _splash, ...rest } = readDocument(environment)

  writeFileAtomic(
    machineFilePath(environment),
    stringify({ ...(show ? {} : { splash: false }), ...rest }),
  )
}

/** Identifies a folder for comparison: letter case is ignored where its filesystem ignores it. */
export function pathKey(path: string): string {
  return isCaseInsensitiveFileSystem(path) ? path.toLowerCase() : path
}

/** A single repository, given by the path of its working tree. */
export type RepoScope = FolderScope

type ScopeKind = 'folder' | 'repo'

function loadScopes(environment: Environment, kind: ScopeKind): FolderScope[] {
  const key = `${kind}_scopes`
  const entries = readDocument(environment)[key] ?? []

  if (!Array.isArray(entries)) {
    throw new ConfigError(`machine.toml: "${key}" must be an array of tables`)
  }

  const scopes = new Map<string, FolderScope>()

  for (const entry of entries as Record<string, unknown>[]) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new ConfigError(`machine.toml: every ${kind} scope needs a non-empty "path"`)
    }

    if (typeof entry.identity !== 'string' || entry.identity.length === 0) {
      throw new ConfigError(`machine.toml: ${kind} scope "${entry.path}" needs an "identity"`)
    }

    const expanded = expandHome(entry.path, environment.home)

    if (!isAbsolute(expanded)) {
      throw new ConfigError(
        `machine.toml: ${kind} scope "${entry.path}" must be absolute or start with ~`,
      )
    }

    const path = resolve(expanded)

    scopes.set(pathKey(path), {
      path,
      displayPath: collapseHome(path, environment.home),
      identityId: entry.identity,
    })
  }

  return [...scopes.values()]
}

export function loadFolderScopes(environment: Environment): FolderScope[] {
  return loadScopes(environment, 'folder')
}

export function loadRepoScopes(environment: Environment): RepoScope[] {
  return loadScopes(environment, 'repo')
}

function saveScopes(
  environment: Environment,
  kind: ScopeKind,
  scopes: Pick<FolderScope, 'identityId' | 'path'>[],
): void {
  writeFileAtomic(
    machineFilePath(environment),
    stringify({
      ...readDocument(environment),
      [`${kind}_scopes`]: scopes.map((scope) => ({
        path: collapseHome(scope.path, environment.home),
        identity: scope.identityId,
      })),
    }),
  )
}

export function saveFolderScopes(
  environment: Environment,
  scopes: Pick<FolderScope, 'identityId' | 'path'>[],
): void {
  saveScopes(environment, 'folder', scopes)
}

export function saveRepoScopes(
  environment: Environment,
  scopes: Pick<RepoScope, 'identityId' | 'path'>[],
): void {
  saveScopes(environment, 'repo', scopes)
}

/**
 * Rewrites `scan_roots`, keeping any other top-level content of the file.
 * `max_depth` is only written when it differs from the default, so it stays an optional override.
 * shortcut: comments and formatting are lost on save, same limit as identities.toml.
 */
function saveScanRoots(
  environment: Environment,
  roots: Pick<ScanRoot, 'maxDepth' | 'path'>[],
): void {
  const { scan_roots: _scanRoots, ...rest } = readDocument(environment)

  writeFileAtomic(
    machineFilePath(environment),
    stringify({
      ...rest,
      scan_roots: roots.map((root) => ({
        path: collapseHome(root.path, environment.home),
        ...(root.maxDepth === DEFAULT_MAX_DEPTH ? {} : { max_depth: root.maxDepth }),
      })),
    }),
  )
}

export function normalizePath(environment: Environment, path: string): string {
  const trimmed = path.trim()

  if (trimmed.length === 0) throw new ConfigError('Path cannot be empty')
  const expanded = expandHome(trimmed, environment.home)

  if (!isAbsolute(expanded)) throw new ConfigError('Path must be absolute or start with ~')

  return resolve(expanded)
}

export function addScanRoot(
  environment: Environment,
  path: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): void {
  const normalized = normalizePath(environment, path)

  if (!isValidDepth(maxDepth)) {
    throw new ConfigError('Maximum depth must be a whole number of at least 1')
  }

  if (!statSync(normalized, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ConfigError(`"${path.trim()}" is not a directory`)
  }

  const roots = loadScanRoots(environment)

  if (roots.some((root) => pathKey(root.path) === pathKey(normalized))) {
    throw new ConfigError(`"${path.trim()}" is already a Scan Root`)
  }

  saveScanRoots(environment, [...roots, { path: normalized, maxDepth }])
}

/**
 * Adds every path that is a directory and not a Scan Root yet, in a single save.
 * Returns how many were added; the rest are skipped instead of failing the whole batch.
 */
export function addScanRoots(environment: Environment, paths: string[]): number {
  const roots = loadScanRoots(environment)
  const known = new Set(roots.map((root) => pathKey(root.path)))
  const added: ScanRoot[] = []

  for (const path of paths) {
    const normalized = normalizePath(environment, path)

    if (known.has(pathKey(normalized))) continue
    if (!statSync(normalized, { throwIfNoEntry: false })?.isDirectory()) continue
    known.add(pathKey(normalized))
    added.push({
      path: normalized,
      displayPath: collapseHome(normalized, environment.home),
      maxDepth: DEFAULT_MAX_DEPTH,
    })
  }

  if (added.length > 0) saveScanRoots(environment, [...roots, ...added])

  return added.length
}

/** True when either path is the other or sits inside it. */
export function overlaps(first: string, second: string): boolean {
  const [a, b] = [pathKey(first), pathKey(second)]

  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
}

export function removeScanRoot(environment: Environment, path: string): void {
  const normalized = normalizePath(environment, path)
  const roots = loadScanRoots(environment)

  if (!roots.some((root) => root.path === normalized)) {
    throw new ConfigError(`"${path.trim()}" is not a Scan Root`)
  }

  saveScanRoots(
    environment,
    roots.filter((root) => root.path !== normalized),
  )
}
