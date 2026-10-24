import type { IdentitiesConfig, Identity } from './config-store.ts'
import type { FolderScope } from './machine-config.ts'
import type { Environment } from './paths.ts'
import type { RepositoryNode, TreeNode } from './scanner.ts'

import { statSync } from 'node:fs'

import { assertIdentityExists, ConfigError, loadIdentitiesConfig } from './config-store.ts'
import { gitDirectoryOf, isInside, realPathOrSelf } from './fs.ts'
import {
  loadFolderScopes,
  loadScanRoots,
  normalizePath,
  pathKey,
  type ScanRoot,
} from './machine-config.ts'
import { scanRoots } from './scanner.ts'

export interface ScopeChange {
  current: Identity | null
  name: string
  path: string
  resulting: Identity | null
}

type ScopeRef = Pick<FolderScope, 'identityId' | 'path'>

/** Scopes after assigning `identityId` to `folder`, or after removing the Assignment when null. */
export function withFolderScope(
  environment: Environment,
  config: IdentitiesConfig,
  folderPath: string,
  identityId: string | null,
): { folder: string; scopes: ScopeRef[] } {
  const folder = normalizePath(environment, folderPath)

  const others: ScopeRef[] = loadFolderScopes(environment).filter(
    (scope) => pathKey(scope.path) !== pathKey(folder),
  )

  if (identityId === null) return { folder, scopes: others }

  assertIdentityExists(config, identityId)

  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ConfigError(`"${folderPath.trim()}" is not a directory`)
  }

  return { folder, scopes: [...others, { path: folder, identityId }] }
}

/** The part of each overlapping Scan Root that lies under `folder`, with the depth left for it. */
function rootsUnder(folder: string, roots: ScanRoot[]): ScanRoot[] {
  return roots.flatMap((root) => {
    if (isInside(root.path, folder)) return [root]
    if (!isInside(folder, root.path)) return []

    const levels = folder === root.path ? 0 : folder.slice(root.path.length + 1).split('/').length
    const maxDepth = root.maxDepth - levels

    return maxDepth < 1 ? [] : [{ path: folder, displayPath: folder, maxDepth }]
  })
}

/** Repositories that qcs controls: not an External Rule, and not an Unknown Identity set elsewhere. */
function isControlled({ classification, email, unreadable }: RepositoryNode): boolean {
  if (classification === 'default-identity' || classification === 'folder-scope') return true

  return classification === 'unknown-identity' && email === null && !unreadable
}

export function repositoriesIn(nodes: TreeNode[]): RepositoryNode[] {
  return nodes.flatMap((node) =>
    node.kind === 'repository' ? [node] : repositoriesIn(node.children),
  )
}

/**
 * Lists the repositories under `folderPath` whose Effective Identity would change.
 */
export async function previewFolderScope(
  environment: Environment,
  folderPath: string,
  identityId: string | null,
): Promise<ScopeChange[]> {
  const config = loadIdentitiesConfig(environment)
  const { folder, scopes } = withFolderScope(environment, config, folderPath, identityId)

  const repositories = repositoriesIn(
    (await scanRoots(environment, rootsUnder(folder, loadScanRoots(environment)))).flatMap(
      (result) => result.children,
    ),
  )

  const identityById = (id: string | null) =>
    config.identities.find((identity) => identity.id === id) ?? null

  const changes: ScopeChange[] = []

  for (const repository of repositories) {
    if (!isControlled(repository)) continue
    const { name, path, identity } = repository

    const gitDirectory = realPathOrSelf(gitDirectoryOf(path))

    const deepest = scopes
      .filter((scope) => isInside(gitDirectory, realPathOrSelf(scope.path)))
      .toSorted((a, b) => b.path.length - a.path.length)[0]

    const resulting = identityById(deepest?.identityId ?? config.defaultIdentityId)

    if (resulting?.id !== identity?.id) changes.push({ name, path, current: identity, resulting })
  }

  return changes
}
