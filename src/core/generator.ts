import type { IdentitiesConfig, Identity, RemoteScope } from './config-store.ts'
import type { FolderScope, RepoScope } from './machine-config.ts'

import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

import { signingKeyOf } from './config-store.ts'
import {
  fileExists,
  gitDirectoryOf,
  isCaseInsensitiveFileSystem,
  realPathOrSelf,
  writeFileAtomic,
} from './fs.ts'
import {
  allowedSignersPath,
  folderScopeGitConfigPath,
  folderScopesDirectory,
  identityGitConfigPath,
  managedGitConfigPath,
  remoteScopeGitConfigPath,
  remoteScopesDirectory,
  repoScopeGitConfigPath,
  repoScopesDirectory,
  type Environment,
} from './paths.ts'
import { sshCommandFor } from './ssh-keys.ts'

/** The key that signs the Identity's commits when its file exists on this Machine. */
function activeSigningKey(identity: Identity): string | null {
  const key = signingKeyOf(identity)

  return key !== null && fileExists(key) ? key : null
}

function identityFileContent(identity: Identity): string {
  const signingKey = activeSigningKey(identity)

  const user = `[user]\n\tname = ${JSON.stringify(identity.name)}\n\temail = ${JSON.stringify(identity.email)}\n${
    signingKey === null ? '' : `\tsigningkey = ${JSON.stringify(signingKey)}\n`
  }`

  const core =
    identity.sshKey !== null && fileExists(identity.sshKey)
      ? `[core]\n\tsshCommand = ${JSON.stringify(sshCommandFor(identity.sshKey))}\n`
      : ''

  const signing =
    signingKey === null
      ? ''
      : '[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n'

  return `${user}${core}${signing}`
}

/** Lines mapping each signing Identity's email to its public key, so git can verify those signatures locally. */
function allowedSigners(config: IdentitiesConfig): string {
  return config.identities
    .flatMap((identity) => {
      const key = activeSigningKey(identity)

      if (key === null || !fileExists(`${key}.pub`)) return []

      return [`${identity.email} namespaces="git" ${readFileSync(`${key}.pub`, 'utf8').trim()}\n`]
    })
    .join('')
}

function depth(path: string): number {
  return path.split('/').length
}

/** Escapes glob characters for git's pattern matching, then quotes for the config subsection. */
export function gitdirCondition(
  caseInsensitive: boolean,
  folder: string,
  recursive = true,
): string {
  const keyword = caseInsensitive ? 'gitdir/i' : 'gitdir'
  const pattern = folder.replaceAll(/[\\*?[]/g, String.raw`\$&`)

  return `${keyword}:${pattern}${recursive ? '/' : ''}`.replaceAll(/[\\"]/g, String.raw`\$&`)
}

/** Quotes the pattern for the config subsection; glob characters stay active on purpose. */
function remoteCondition(pattern: string): string {
  return `hasconfig:remote.*.url:${pattern}`.replaceAll(/[\\"]/g, String.raw`\$&`)
}

function managedFileContent(
  environment: Environment,
  signers: string,
  config: IdentitiesConfig,
  scopes: readonly FolderScope[],
  remoteScopes: readonly RemoteScope[],
  repoScopes: readonly RepoScope[],
): string {
  const defaultInclude =
    config.defaultIdentityId === null
      ? ''
      : `[include]\n\tpath = ${JSON.stringify(identityGitConfigPath(environment, config.defaultIdentityId))}\n`

  // The last definition wins in git, so Folder Scopes go from shallowest to deepest.
  const folderIncludes = scopes
    .map((scope) => ({ scope, realPath: realPathOrSelf(scope.path) }))
    .toSorted(
      (a, b) => depth(a.realPath) - depth(b.realPath) || a.realPath.localeCompare(b.realPath),
    )
    .map(
      ({ scope, realPath }) =>
        `[includeIf "${gitdirCondition(isCaseInsensitiveFileSystem(realPath), realPath)}"]\n\tpath = ${JSON.stringify(folderScopeGitConfigPath(environment, scope.path))}\n`,
    )

  const remoteIncludes = remoteScopes.map(
    (scope) =>
      `[includeIf "${remoteCondition(scope.pattern)}"]\n\tpath = ${JSON.stringify(remoteScopeGitConfigPath(environment, scope.pattern))}\n`,
  )

  // The git directory itself needs an exact match: the recursive pattern only covers what lives inside it,
  // which is where linked worktrees and submodules keep their own git directories.
  const repoIncludes = repoScopes
    .map((scope) => ({ scope, gitDirectory: realPathOrSelf(gitDirectoryOf(scope.path)) }))
    .toSorted(
      (a, b) =>
        depth(a.gitDirectory) - depth(b.gitDirectory) ||
        a.gitDirectory.localeCompare(b.gitDirectory),
    )
    .flatMap(({ scope, gitDirectory }) =>
      [false, true].map(
        (recursive) =>
          `[includeIf "${gitdirCondition(isCaseInsensitiveFileSystem(gitDirectory), gitDirectory, recursive)}"]\n\tpath = ${JSON.stringify(repoScopeGitConfigPath(environment, scope.path))}\n`,
      ),
    )

  const signersSetting =
    signers === ''
      ? ''
      : `[gpg "ssh"]\n\tallowedSignersFile = ${JSON.stringify(allowedSignersPath(environment))}\n`

  return [
    signersSetting,
    defaultInclude,
    ...folderIncludes,
    ...remoteIncludes,
    ...repoIncludes,
  ].join('')
}

/**
 * Each Scope gets its own file with the Identity values, so the origin git reports
 * tells a Folder Scope or Repo Scope apart from the Default Identity.
 */
function writeScopeFiles<T extends { identityId: string }>(
  config: IdentitiesConfig,
  scopes: readonly T[],
  directory: string,
  filePath: (scope: T) => string,
): void {
  const written = new Set<string>()

  for (const scope of scopes) {
    const identity = config.identities.find((candidate) => candidate.id === scope.identityId)!
    const file = filePath(scope)

    writeFileAtomic(file, identityFileContent(identity))
    written.add(basename(file))
  }

  for (const name of fileExists(directory) ? readdirSync(directory) : []) {
    if (!written.has(name)) rmSync(join(directory, name), { force: true })
  }
}

export function writeGeneratedConfig(
  environment: Environment,
  config: IdentitiesConfig,
  scopes: readonly FolderScope[],
  remoteScopes: readonly RemoteScope[],
  repoScopes: readonly RepoScope[],
): string {
  for (const identity of config.identities) {
    writeFileAtomic(identityGitConfigPath(environment, identity.id), identityFileContent(identity))
  }

  // A scope whose Identity no longer exists is ignored, so it cannot block every other change.
  const isActive = (scope: { identityId: string }) =>
    config.identities.some((identity) => identity.id === scope.identityId)

  const active = scopes.filter(isActive)
  const activeRemotes = remoteScopes.filter(isActive)
  const activeRepos = repoScopes.filter(isActive)

  writeScopeFiles(config, active, folderScopesDirectory(environment), (scope) =>
    folderScopeGitConfigPath(environment, scope.path),
  )
  writeScopeFiles(config, activeRemotes, remoteScopesDirectory(environment), (scope) =>
    remoteScopeGitConfigPath(environment, scope.pattern),
  )
  writeScopeFiles(config, activeRepos, repoScopesDirectory(environment), (scope) =>
    repoScopeGitConfigPath(environment, scope.path),
  )

  const signers = allowedSigners(config)

  if (signers === '') rmSync(allowedSignersPath(environment), { force: true })
  else writeFileAtomic(allowedSignersPath(environment), signers)

  const managedPath = managedGitConfigPath(environment)

  writeFileAtomic(
    managedPath,
    managedFileContent(environment, signers, config, active, activeRemotes, activeRepos),
  )

  return managedPath
}
