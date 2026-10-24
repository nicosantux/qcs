import type { IdentitiesConfig } from './config-store.ts'
import type { RepoScope } from './machine-config.ts'
import type { Environment } from './paths.ts'

import { statSync } from 'node:fs'
import { join } from 'node:path'

import { assertIdentityExists, ConfigError } from './config-store.ts'
import { realPathOrSelf } from './fs.ts'
import { loadRepoScopes, normalizePath, pathKey } from './machine-config.ts'

type ScopeRef = Pick<RepoScope, 'identityId' | 'path'>

/** Repo Scopes after assigning `identityId` to `repositoryPath`, or after removing the Assignment when null. */
export function withRepoScope(
  environment: Environment,
  config: IdentitiesConfig,
  repositoryPath: string,
  identityId: string | null,
): ScopeRef[] {
  const repository = normalizePath(environment, repositoryPath)
  const key = (path: string) => pathKey(realPathOrSelf(path))

  // The same repository can arrive through a symlink (scan) or as its real path (`git rev-parse`).
  const others: ScopeRef[] = loadRepoScopes(environment).filter(
    (scope) => key(scope.path) !== key(repository),
  )

  if (identityId === null) return others

  assertIdentityExists(config, identityId)

  if (!statSync(join(repository, '.git'), { throwIfNoEntry: false })) {
    throw new ConfigError(`"${repositoryPath.trim()}" is not a git repository`)
  }

  return [...others, { path: repository, identityId }]
}
