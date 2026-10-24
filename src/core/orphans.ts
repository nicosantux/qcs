import type { FolderScope } from './machine-config.ts'
import type { Environment } from './paths.ts'

import { fileExists } from './fs.ts'
import { loadFolderScopes, loadRepoScopes } from './machine-config.ts'

export interface OrphanedAssignment extends FolderScope {
  /** True for a Repo Scope, false for a Folder Scope. */
  repository: boolean
}

export function findOrphanedAssignments(environment: Environment): OrphanedAssignment[] {
  const orphans = (scopes: FolderScope[], repository: boolean) =>
    scopes.filter(({ path }) => !fileExists(path)).map((scope) => ({ ...scope, repository }))

  return [
    ...orphans(loadFolderScopes(environment), false),
    ...orphans(loadRepoScopes(environment), true),
  ]
}
