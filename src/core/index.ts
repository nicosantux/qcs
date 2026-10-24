import type { Environment } from './paths.ts'

import {
  collapseHome,
  ConfigError,
  loadIdentitiesConfig,
  loadRemoteScopes,
  saveIdentitiesConfig,
  saveRemoteScopes,
  signingKeyOf,
  type IdentitiesConfig,
  type RemoteScope,
} from './config-store.ts'
import {
  previewFolderScope,
  repositoriesIn,
  withFolderScope,
  type ScopeChange,
} from './folder-scopes.ts'
import { fileExists } from './fs.ts'
import { writeGeneratedConfig } from './generator.ts'
import { remoteScopesUnavailableReason } from './git.ts'
import {
  ensureIncludeLine,
  hasIdentitySettingsAfterInclude,
  moveIncludeToEnd,
  rewriteGlobalConfig,
  type EnsureIncludeResult,
} from './global-git-config.ts'
import {
  addIdentity,
  changeIdentity,
  chooseDefaultIdentity,
  removeIdentity,
  requireIdentity,
  type IdentityInput,
} from './identities.ts'
import { buildImport, removeImported, type ImportPlan } from './import-config.ts'
import { loadKeybindingsFile } from './keybindings-file.ts'
import {
  addScanRoot,
  addScanRoots,
  AssignmentConflictError,
  loadFolderScopes,
  loadRepoScopes,
  loadScanRoots,
  loadShowSplash,
  pathKey,
  removeScanRoot,
  saveFolderScopes,
  saveRepoScopes,
  saveShowSplash,
  type FolderScope,
  type RepoScope,
  type ScanRoot,
} from './machine-config.ts'
import { findOrphanedAssignments, type OrphanedAssignment } from './orphans.ts'
import { managedGitConfigPath } from './paths.ts'
import { suggestRemotePattern, withRemoteScope } from './remote-scopes.ts'
import { withRepoScope } from './repo-scopes.ts'
import { resolveEffectiveIdentity, type Resolution } from './resolver.ts'
import {
  completeDirectory,
  scanRoots,
  suggestScanRoots,
  type RepositoryNode,
  type ScanResult,
  type SuggestedScanRoot,
} from './scanner.ts'
import {
  copyPublicKey,
  deleteSshKey,
  freeKeyPath,
  generateSshKey,
  listSshKeys,
  namedKeyPath,
} from './ssh-keys.ts'

export type { Identity, IdentitiesConfig, RemoteScope } from './config-store.ts'
export { ConfigError, SIGN_WITH_SSH_KEY, signingKeyOf } from './config-store.ts'
export type { IdentityInput } from './identities.ts'
export { DELETE_DEFAULT_IDENTITY_MESSAGE } from './identities.ts'
export type { ScopeChange } from './folder-scopes.ts'
export { repositoriesIn } from './folder-scopes.ts'
export { realPathOrSelf } from './fs.ts'
export type { ImportedFolder, ImportPlan } from './import-config.ts'
export type { FolderScope, RepoScope, ScanRoot } from './machine-config.ts'
export { AssignmentConflictError } from './machine-config.ts'
export type { OrphanedAssignment } from './orphans.ts'
export type { Origin, Resolution } from './resolver.ts'
export type { SshKeyStatus } from './ssh-keys.ts'
export type {
  Classification,
  FolderNode,
  RepositoryNode,
  ScanResult,
  SuggestedScanRoot,
  TreeNode,
} from './scanner.ts'

export type KeyPurpose = 'signing' | 'ssh'

export interface Core {
  /** `maxDepth` overrides the default scan depth for this root. */
  addScanRoot: (path: string, maxDepth?: number) => Promise<void>
  /** Adds every valid path that is not a Scan Root yet and returns how many were added. */
  addScanRoots: (paths: string[]) => Promise<number>
  apply: () => Promise<EnsureIncludeResult>
  assignFolder: (path: string, identityId: string) => Promise<EnsureIncludeResult>
  /** Creates or replaces the Remote Scope of `pattern`, a git glob matched against remote URLs. */
  assignRemote: (pattern: string, identityId: string) => Promise<EnsureIncludeResult>
  /** Creates or replaces the Repo Scope of the repository whose working tree is at `path`. */
  assignRepository: (path: string, identityId: string) => Promise<EnsureIncludeResult>
  /** Directories completing the last segment of `partial`, a path as typed (absolute or starting with `~/`). */
  completeDirectory: (partial: string) => Promise<string[]>
  /** Copies `<key>.pub` of a key from `listSshKeys` to the clipboard. */
  copyPublicKey: (key: string) => Promise<void>
  /** Copies the public key of the Identity's SSH key to the clipboard; rejects when no clipboard command is installed. */
  copySshPublicKey: (id: string) => Promise<void>
  createIdentity: (input: IdentityInput) => Promise<EnsureIncludeResult>
  /** Rejects when Folder, Remote or Repo Scopes still use the Identity, unless `removeAssignments` is set. */
  deleteIdentity: (
    id: string,
    options?: { removeAssignments?: boolean },
  ) => Promise<EnsureIncludeResult>
  /** Deletes a key from `listSshKeys` and its public key; rejects while an Identity uses it to push or sign. */
  deleteSshKey: (key: string) => Promise<void>
  /** The Orphaned Assignments, and whether the global git config sets identity after the managed include (overriding every Assignment). */
  diagnostics: () => Promise<{ includeOverridden: boolean; orphans: OrphanedAssignment[] }>
  /** `path` with the home directory shown as `~`. */
  displayPath: (path: string) => string
  editIdentity: (id: string, input: IdentityInput) => Promise<EnsureIncludeResult>
  /**
   * Generates an ed25519 key in `~/.ssh`, never over an existing file, and attaches it as the SSH key,
   * or as the signing key with `purpose: 'signing'`.
   * Without a `name` the key is named after the Identity. Without a passphrase the key is not protected.
   */
  generateSshKey: (
    id: string,
    passphrase?: string,
    name?: string,
    purpose?: KeyPurpose,
  ) => Promise<EnsureIncludeResult>
  /**
   * Takes the global `[user]` block and folder `includeIf` rules into qcs, then removes only those
   * blocks from the global git config after a backup. Rejects when there is nothing to import.
   */
  importConfiguration: () => Promise<{ backupPath: string | null }>
  /** Private keys in `~/.ssh` that have a matching public key. */
  listSshKeys: () => string[]
  load: () => IdentitiesConfig
  loadFolderScopes: () => FolderScope[]
  /** The parsed `keybindings.toml`, empty when it does not exist; the TUI validates its content. */
  loadKeybindings: () => Record<string, unknown>
  loadRemoteScopes: () => RemoteScope[]
  loadRepoScopes: () => RepoScope[]
  loadScanRoots: () => ScanRoot[]
  /** Whether the TUI opens on the splash screen, stored in `machine.toml`. */
  loadShowSplash: () => boolean
  /** Ids of the Identities whose signing key file does not exist on this Machine. */
  missingSigningKeys: () => string[]
  /** Ids of the Identities whose key file does not exist on this Machine. */
  missingSshKeys: () => string[]
  /** Moves the managed include to the end of the global git config after a backup, so it wins again. */
  moveIncludeToEnd: () => Promise<{ backupPath: string | null }>
  previewFolderAssignment: (path: string, identityId: string | null) => Promise<ScopeChange[]>
  /** What an import would do, or null when there is nothing to import; `firstRunOnly` also needs an empty qcs configuration. */
  previewImport: (options?: { firstRunOnly?: boolean }) => Promise<ImportPlan | null>
  /** Why Remote Scopes cannot be used with the installed git, or null when they can. */
  remoteScopesUnavailable: () => Promise<string | null>
  removeScanRoot: (path: string) => Promise<void>
  /**
   * Moves the Folder Scope Assignment at `path` to `newPath`, which must be an existing directory.
   * Throws AssignmentConflictError when `newPath` is assigned to another Identity, unless `replace`.
   */
  repointFolder: (
    path: string,
    newPath: string,
    options?: { replace?: boolean },
  ) => Promise<EnsureIncludeResult>
  /** Moves the Repo Scope Assignment at `path` to the repository at `newPath`; conflicts as in `repointFolder`. */
  repointRepository: (
    path: string,
    newPath: string,
    options?: { replace?: boolean },
  ) => Promise<EnsureIncludeResult>
  /** The repositories under the Scan Roots whose Effective Identity is each Identity, by Identity id. */
  repositoriesByIdentity: () => Promise<Map<string, RepositoryNode[]>>
  resolve: (directory: string) => Promise<Resolution>
  scan: () => Promise<ScanResult[]>
  setDefaultIdentity: (id: string) => Promise<EnsureIncludeResult>
  setShowSplash: (show: boolean) => Promise<void>
  /** A pattern covering the owner in the repository's remote; rejects when it has no remote. */
  suggestRemotePattern: (path: string) => Promise<string>
  /** Folders under the home directory that contain repositories and are not Scan Roots yet. */
  suggestScanRoots: () => Promise<SuggestedScanRoot[]>
  unassignFolder: (path: string) => Promise<EnsureIncludeResult>
  unassignRemote: (pattern: string) => Promise<EnsureIncludeResult>
  unassignRepository: (path: string) => Promise<EnsureIncludeResult>
}

export function createCore(environment: Environment): Core {
  // The installed git does not change while the process runs, so it is asked only once.
  let gitSupport: Promise<string | null> | undefined
  const remoteScopesUnavailable = () => (gitSupport ??= remoteScopesUnavailableReason(environment))

  const apply = () =>
    Promise.try(async () => {
      const remoteScopes =
        (await remoteScopesUnavailable()) === null ? loadRemoteScopes(environment) : []

      const managedPath = writeGeneratedConfig(
        environment,
        loadIdentitiesConfig(environment),
        loadFolderScopes(environment),
        remoteScopes,
        loadRepoScopes(environment),
      )

      return ensureIncludeLine(environment, managedPath)
    })

  const setFolderScope = (path: string, identityId: string | null) =>
    Promise.try(() => {
      saveFolderScopes(
        environment,
        withFolderScope(environment, loadIdentitiesConfig(environment), path, identityId).scopes,
      )

      return apply()
    })

  const setRemoteScope = (pattern: string, identityId: string | null) =>
    Promise.try(async () => {
      const unavailable = identityId === null ? null : await remoteScopesUnavailable()

      if (unavailable !== null) throw new ConfigError(unavailable)

      saveRemoteScopes(
        environment,
        withRemoteScope(environment, loadIdentitiesConfig(environment), pattern, identityId),
      )

      return apply()
    })

  const setRepoScope = (path: string, identityId: string | null) =>
    Promise.try(() => {
      saveRepoScopes(
        environment,
        withRepoScope(environment, loadIdentitiesConfig(environment), path, identityId),
      )

      return apply()
    })

  const repointScope = (path: string, newPath: string, repository: boolean, replace = false) =>
    Promise.try(() => {
      const config = loadIdentitiesConfig(environment)
      const current = repository ? loadRepoScopes(environment) : loadFolderScopes(environment)
      const isOld = (candidate: { path: string }) => pathKey(candidate.path) === pathKey(path)
      const scope = current.find(isOld)

      if (scope === undefined) throw new ConfigError(`"${path}" has no Assignment`)

      const moved = repository
        ? withRepoScope(environment, config, newPath, scope.identityId)
        : withFolderScope(environment, config, newPath, scope.identityId).scopes

      // The new Assignment comes last, so re-pointing to the same path keeps it.
      const others = moved.slice(0, -1).filter((candidate) => !isOld(candidate))

      const replaced = current.find(
        (candidate) =>
          candidate.identityId !== scope.identityId &&
          !isOld(candidate) &&
          !others.some((other) => other.path === candidate.path),
      )

      if (replaced !== undefined && !replace) throw new AssignmentConflictError(replaced)

      const scopes = [...others, moved.at(-1)!]

      if (repository) saveRepoScopes(environment, scopes)
      else saveFolderScopes(environment, scopes)

      return apply()
    })

  const change = (update: (config: IdentitiesConfig) => IdentitiesConfig) =>
    Promise.try(() => {
      saveIdentitiesConfig(environment, update(loadIdentitiesConfig(environment)))

      return apply()
    })

  const buildCurrentImport = () =>
    buildImport(environment, loadIdentitiesConfig(environment), loadFolderScopes(environment))

  return {
    previewImport: ({ firstRunOnly = false } = {}) =>
      Promise.try(() =>
        firstRunOnly && loadIdentitiesConfig(environment).identities.length > 0
          ? null
          : (buildCurrentImport()?.plan ?? null),
      ),
    importConfiguration: () =>
      Promise.try(async () => {
        const build = buildCurrentImport()

        if (build === null) throw new ConfigError('There is nothing to import')

        const previousConfig = loadIdentitiesConfig(environment)
        const previousScopes = loadFolderScopes(environment)

        try {
          saveIdentitiesConfig(environment, build.config)
          saveFolderScopes(environment, build.scopes)
          // The managed file is in place before the old blocks go, so no repository changes author in between.
          const { backupPath } = await apply()

          const rewriteBackupPath = rewriteGlobalConfig(environment, (content) =>
            removeImported(environment, content, build.plan),
          )

          // The first backup holds the config as it was before qcs touched it.
          return { backupPath: backupPath ?? rewriteBackupPath }
        } catch (error) {
          // Otherwise a retry finds the scopes already saved and sees nothing to import.
          saveIdentitiesConfig(environment, previousConfig)
          saveFolderScopes(environment, previousScopes)
          await apply().catch(() => undefined)

          throw error
        }
      }),
    load: () => loadIdentitiesConfig(environment),
    loadKeybindings: () => loadKeybindingsFile(environment),
    displayPath: (path) => collapseHome(path, environment.home),
    diagnostics: () =>
      Promise.try(() => ({
        orphans: findOrphanedAssignments(environment),
        includeOverridden: hasIdentitySettingsAfterInclude(
          environment,
          managedGitConfigPath(environment),
        ),
      })),
    moveIncludeToEnd: () =>
      Promise.try(async () => {
        // The managed file must exist before the include points at it.
        await apply()

        return { backupPath: moveIncludeToEnd(environment, managedGitConfigPath(environment)) }
      }),
    repointFolder: (path, newPath, options) => repointScope(path, newPath, false, options?.replace),
    repointRepository: (path, newPath, options) =>
      repointScope(path, newPath, true, options?.replace),
    repositoriesByIdentity: () =>
      Promise.try(async () => {
        const repositories = repositoriesIn(
          (await scanRoots(environment, loadScanRoots(environment))).flatMap(
            ({ children }) => children,
          ),
        )

        return Map.groupBy(
          repositories.filter(({ identity }) => identity !== null),
          ({ identity }) => identity!.id,
        )
      }),
    listSshKeys: () => listSshKeys(environment),
    missingSshKeys: () =>
      loadIdentitiesConfig(environment)
        .identities.filter(({ sshKey }) => sshKey !== null && !fileExists(sshKey))
        .map(({ id }) => id),
    missingSigningKeys: () =>
      loadIdentitiesConfig(environment)
        .identities.filter((identity) => {
          const key = signingKeyOf(identity)

          return key !== null && !fileExists(key)
        })
        .map(({ id }) => id),
    loadFolderScopes: () => loadFolderScopes(environment),
    assignFolder: (path, identityId) => setFolderScope(path, identityId),
    unassignFolder: (path) => setFolderScope(path, null),
    loadRemoteScopes: () => loadRemoteScopes(environment),
    assignRemote: (pattern, identityId) => setRemoteScope(pattern, identityId),
    unassignRemote: (pattern) => setRemoteScope(pattern, null),
    remoteScopesUnavailable,
    suggestRemotePattern: (path) => suggestRemotePattern(environment, path),
    loadRepoScopes: () => loadRepoScopes(environment),
    assignRepository: (path, identityId) => setRepoScope(path, identityId),
    unassignRepository: (path) => setRepoScope(path, null),
    previewFolderAssignment: (path, identityId) =>
      previewFolderScope(environment, path, identityId),
    loadScanRoots: () => loadScanRoots(environment),
    loadShowSplash: () => loadShowSplash(environment),
    setShowSplash: (show) => Promise.try(() => saveShowSplash(environment, show)),
    addScanRoot: (path, maxDepth) => Promise.try(() => addScanRoot(environment, path, maxDepth)),
    addScanRoots: (paths) => Promise.try(() => addScanRoots(environment, paths)),
    suggestScanRoots: () =>
      Promise.try(() => loadScanRoots(environment)).then((roots) =>
        suggestScanRoots(environment, roots),
      ),
    completeDirectory: (partial) => completeDirectory(environment, partial),
    removeScanRoot: (path) => Promise.try(() => removeScanRoot(environment, path)),
    scan: () => Promise.try(() => scanRoots(environment, loadScanRoots(environment))),
    resolve: (directory) => resolveEffectiveIdentity(environment, directory),
    apply,
    createIdentity: (input) => change((config) => addIdentity(config, input)),
    editIdentity: (id, input) => change((config) => changeIdentity(config, id, input)),
    generateSshKey: (id, passphrase = '', name = '', purpose = 'ssh') =>
      Promise.try(async () => {
        const identity = requireIdentity(loadIdentitiesConfig(environment), id)

        const path =
          name !== ''
            ? namedKeyPath(environment, name)
            : freeKeyPath(environment, purpose === 'signing' ? `${id}-signing` : id)

        await generateSshKey(environment, path, identity.email, passphrase)

        return change((config) =>
          changeIdentity(config, id, {
            ...identity,
            ...(purpose === 'signing' ? { signingKey: path } : { sshKey: path }),
          }),
        )
      }),
    deleteSshKey: (key) =>
      Promise.try(() => {
        const user = loadIdentitiesConfig(environment).identities.find((identity) =>
          [identity.sshKey, signingKeyOf(identity)].some(
            (used) => used !== null && pathKey(used) === pathKey(key),
          ),
        )

        if (user)
          throw new ConfigError(`"${user.label}" uses ${collapseHome(key, environment.home)}`)

        deleteSshKey(environment, key)
      }),
    copyPublicKey: (key) =>
      Promise.try(() => {
        if (!listSshKeys(environment).includes(key)) {
          throw new ConfigError(`${key} is not an SSH key in ~/.ssh`)
        }

        return copyPublicKey(environment, key)
      }),
    copySshPublicKey: (id) =>
      Promise.try(() => {
        const { sshKey } = requireIdentity(loadIdentitiesConfig(environment), id)

        if (sshKey === null) throw new ConfigError(`Identity "${id}" has no SSH key`)

        return copyPublicKey(environment, sshKey)
      }),
    deleteIdentity: (id, { removeAssignments = false } = {}) =>
      Promise.try(() => {
        const config = removeIdentity(loadIdentitiesConfig(environment), id)
        const scopes = loadFolderScopes(environment)
        const repoScopes = loadRepoScopes(environment)
        const remoteScopes = loadRemoteScopes(environment)

        const assigned = [
          ...[...scopes, ...repoScopes]
            .filter((scope) => scope.identityId === id)
            .map((scope) => scope.displayPath),
          ...remoteScopes.filter((scope) => scope.identityId === id).map((scope) => scope.pattern),
        ]

        if (assigned.length > 0 && !removeAssignments) {
          throw new ConfigError(`Identity "${id}" is still assigned to: ${assigned.join(', ')}`)
        }

        // Identities first: a leftover Assignment of a missing Identity is ignored, a lost one is not recoverable.
        saveIdentitiesConfig(environment, config)
        saveFolderScopes(
          environment,
          scopes.filter((scope) => scope.identityId !== id),
        )
        saveRepoScopes(
          environment,
          repoScopes.filter((scope) => scope.identityId !== id),
        )
        saveRemoteScopes(
          environment,
          remoteScopes.filter((scope) => scope.identityId !== id),
        )

        return apply()
      }),
    setDefaultIdentity: (id) => change((config) => chooseDefaultIdentity(config, id)),
  }
}
