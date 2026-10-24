import type { Identity } from './config-store.ts'
import type { ScanRoot } from './machine-config.ts'
import type { Environment } from './paths.ts'
import type { SshKeyStatus } from './ssh-keys.ts'

import { readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { collapseHome } from './config-store.ts'
import { DEFAULT_MAX_DEPTH, overlaps } from './machine-config.ts'
import { expandHome } from './paths.ts'
import { resolveEffectiveIdentity, type Origin } from './resolver.ts'

export type Classification =
  | 'default-identity'
  | 'external-rule'
  | 'folder-scope'
  | 'remote-scope'
  | 'repo-scope'
  | 'unknown-identity'

export interface RepositoryNode {
  classification: Classification
  email: string | null
  identity: Identity | null
  kind: 'repository'
  name: string
  path: string
  signingKey: SshKeyStatus
  sshKey: SshKeyStatus
  /** True when git could not read the repository (broken `.git`, foreign owner, timeout). */
  unreadable: boolean
}

export interface FolderNode {
  children: TreeNode[]
  kind: 'folder'
  name: string
  path: string
}

export type TreeNode = FolderNode | RepositoryNode

export interface ScanResult {
  children: TreeNode[]
  displayPath: string
  maxDepth: number
  missing: boolean
  path: string
}

type Discovered =
  | { kind: 'folder'; name: string; path: string; children: Discovered[] }
  | { kind: 'repository'; name: string; path: string }

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
  'vendor',
  'venv',
])

const RESOLVE_CONCURRENCY = 8

const SKIPPED_HOME_DIRECTORIES = new Set(['Library'])

// Reading these on macOS triggers the system privacy prompts.
const MACOS_PRIVACY_DIRECTORIES = new Set(['Desktop', 'Documents', 'Downloads'])

export interface SuggestedScanRoot {
  displayPath: string
  path: string
}

const CLASSIFICATION_BY_ORIGIN = {
  default: 'default-identity',
  'external-rule': 'external-rule',
  'folder-scope': 'folder-scope',
  none: 'external-rule',
  'remote-scope': 'remote-scope',
  'repo-scope': 'repo-scope',
} as const satisfies Record<Origin, Classification>

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
}

async function discover(directory: string, depthLeft: number): Promise<Discovered[]> {
  const entries = (await readDirectory(directory)) ?? []

  const nodes = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(async ({ name }): Promise<Discovered | null> => {
        const path = join(directory, name)
        const children = await readDirectory(path)

        if (children?.some((child) => child.name === '.git'))
          return { kind: 'repository', name, path }
        if (depthLeft <= 1) return null

        const nested = await discover(path, depthLeft - 1)

        return nested.length === 0 ? null : { kind: 'folder', name, path, children: nested }
      }),
  )

  return nodes.filter((node) => node !== null)
}

async function hasRepository(directory: string, depthLeft: number): Promise<boolean> {
  const entries = (await readDirectory(directory)) ?? []

  /* eslint-disable no-await-in-loop -- sequential on purpose: stop at the first repository */
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue

    const path = join(directory, entry.name)
    const children = await readDirectory(path)

    if (children?.some((child) => child.name === '.git')) return true
    if (depthLeft > 1 && (await hasRepository(path, depthLeft - 1))) return true
  }
  /* eslint-enable no-await-in-loop */

  return false
}

function createLimiter(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active++

    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

async function describeRepository(
  environment: Environment,
  node: { name: string; path: string },
): Promise<RepositoryNode> {
  const base = { kind: 'repository', name: node.name, path: node.path } as const
  const resolution = await resolveEffectiveIdentity(environment, node.path)

  if (resolution.status === 'known') {
    return {
      ...base,
      identity: resolution.identity,
      email: resolution.identity.email,
      classification: CLASSIFICATION_BY_ORIGIN[resolution.origin],
      sshKey: resolution.sshKey,
      signingKey: resolution.signingKey,
      unreadable: false,
    }
  }

  return {
    ...base,
    identity: null,
    email: resolution.status === 'unknown' ? resolution.email : null,
    classification: 'unknown-identity',
    sshKey: 'none',
    signingKey: 'none',
    unreadable: resolution.status === 'not-a-repository',
  }
}

export async function scanRoots(
  environment: Environment,
  roots: ScanRoot[],
): Promise<ScanResult[]> {
  const limit = createLimiter(RESOLVE_CONCURRENCY)

  const describe = (nodes: Discovered[]): Promise<TreeNode[]> =>
    Promise.all(
      nodes.map(async (node): Promise<TreeNode> => {
        if (node.kind === 'repository') return limit(() => describeRepository(environment, node))

        return { ...node, children: await describe(node.children) }
      }),
    )

  return Promise.all(
    roots.map(async (root): Promise<ScanResult> => {
      const { path, displayPath, maxDepth } = root
      const missing = (await readDirectory(path)) === null

      return {
        path,
        displayPath,
        maxDepth,
        missing,
        children: missing ? [] : await describe(await discover(path, maxDepth)),
      }
    }),
  )
}

/**
 * Direct children of the home directory that contain repositories, minus the ones already used as Scan Roots.
 */
export async function suggestScanRoots(
  environment: Environment,
  existing: ScanRoot[],
): Promise<SuggestedScanRoot[]> {
  const { home } = environment

  const candidates = ((await readDirectory(home)) ?? [])
    .filter(
      ({ name }) =>
        !name.startsWith('.') &&
        !SKIPPED_DIRECTORIES.has(name) &&
        !SKIPPED_HOME_DIRECTORIES.has(name) &&
        !(process.platform === 'darwin' && MACOS_PRIVACY_DIRECTORIES.has(name)),
    )
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => a.name.localeCompare(b.name))

  const suggestions = await Promise.all(
    candidates.map(async ({ name }): Promise<SuggestedScanRoot | null> => {
      const path = join(home, name)
      const contents = await readDirectory(path)

      if (
        existing.some((root) => overlaps(root.path, path)) ||
        contents === null ||
        contents.some((c) => c.name === '.git')
      ) {
        return null
      }

      if (!(await hasRepository(path, DEFAULT_MAX_DEPTH))) return null

      return { path, displayPath: collapseHome(path, home) }
    }),
  )

  return suggestions.filter((suggestion) => suggestion !== null)
}

/**
 * Directories that complete the last segment of `partial`, a path as typed: case-insensitive
 * matches anywhere in the name, those starting with it first. Each keeps the typed parent and ends in `/`.
 */
export async function completeDirectory(
  environment: Environment,
  partial: string,
): Promise<string[]> {
  const parent = partial.slice(0, partial.lastIndexOf('/') + 1)
  const fragment = partial.slice(parent.length).toLowerCase()
  const directory = expandHome(parent, environment.home)

  if (!isAbsolute(directory)) return []

  const starts = (name: string) => name.toLowerCase().startsWith(fragment)

  return ((await readDirectory(directory)) ?? [])
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (fragment.startsWith('.') || !entry.name.startsWith('.')) &&
        entry.name.toLowerCase().includes(fragment),
    )
    .map(({ name }) => name)
    .toSorted((a, b) => Number(starts(b)) - Number(starts(a)) || a.localeCompare(b))
    .map((name) => `${parent}${name}/`)
}
