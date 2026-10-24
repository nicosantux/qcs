import { loadIdentitiesConfig, signingKeyOf, type Identity } from './config-store.ts'
import { fileExists, isInside, realPathOrSelf } from './fs.ts'
import { runGit } from './git.ts'
import { loadFolderScopes } from './machine-config.ts'
import {
  folderScopesDirectory,
  generatedDirectory,
  remoteScopesDirectory,
  repoScopesDirectory,
  type Environment,
} from './paths.ts'
import { sshCommandFor, type SshKeyStatus } from './ssh-keys.ts'

export type Origin =
  'default' | 'external-rule' | 'folder-scope' | 'none' | 'remote-scope' | 'repo-scope'

export type Resolution =
  | {
      status: 'not-a-repository'
      /** The deepest Folder Scope containing the directory, which repositories created there would use. */
      folderScope: { displayPath: string; identity: Identity } | null
    }
  | {
      status: 'known'
      repository: string
      identity: Identity
      origin: Origin
      sshCommandOverriddenByEnvironment: boolean
      sshKey: SshKeyStatus
      /** Same states as `sshKey`, for the key git signs commits with. */
      signingKey: SshKeyStatus
    }
  | {
      status: 'unknown'
      repository: string
      name: string | null
      email: string | null
      origin: Origin
      sshCommandOverriddenByEnvironment: boolean
    }

interface ConfigValue {
  originFile: string
  value: string
}

async function readConfigValue(
  environment: Environment,
  repository: string,
  key: string,
): Promise<ConfigValue | null> {
  const result = await runGit(environment, repository, [
    'config',
    '--show-origin',
    '--null',
    '--get',
    key,
  ])

  if (result.exitCode !== 0) return null
  const [origin = '', value = ''] = result.stdout.split('\0')

  return { value, originFile: origin.replace(/^file:/, '') }
}

function classifyOrigin(environment: Environment, emailValue: ConfigValue | null): Origin {
  if (emailValue === null) return 'none'
  const { originFile } = emailValue

  if (originFile.startsWith(`${folderScopesDirectory(environment)}/`)) return 'folder-scope'
  if (originFile.startsWith(`${remoteScopesDirectory(environment)}/`)) return 'remote-scope'
  if (originFile.startsWith(`${repoScopesDirectory(environment)}/`)) return 'repo-scope'

  return originFile.startsWith(`${generatedDirectory(environment)}/`) ? 'default' : 'external-rule'
}

function folderScopeAt(
  environment: Environment,
  directory: string,
): { displayPath: string; identity: Identity } | null {
  const path = realPathOrSelf(directory)

  const scope = loadFolderScopes(environment)
    .filter((candidate) => isInside(path, realPathOrSelf(candidate.path)))
    .toSorted((a, b) => b.path.length - a.path.length)[0]

  const identity = loadIdentitiesConfig(environment).identities.find(
    (candidate) => candidate.id === scope?.identityId,
  )

  return scope && identity ? { displayPath: scope.displayPath, identity } : null
}

/** Whether git in `repository` reads `configKey` as `expected`, the value qcs writes for `key`. */
async function keyStatus(
  environment: Environment,
  repository: string,
  key: string | null,
  configKey: string,
  expected: (key: string) => string,
): Promise<SshKeyStatus> {
  if (key === null) return 'none'

  const value = await readConfigValue(environment, repository, configKey)
  const configured = value?.value === expected(key)

  if (!fileExists(key)) return configured ? 'stale' : 'missing'

  return configured ? 'used' : 'none'
}

/** Several Identities can share an email; the author name and the SSH command git reads tell which one is in effect. */
async function pickSharedEmail(
  environment: Environment,
  repository: string,
  candidates: Identity[],
  name: string | undefined,
): Promise<Identity> {
  const sameName = candidates.filter((candidate) => candidate.name === name)
  const pool = sameName.length > 0 ? sameName : candidates

  if (pool.length === 1) return pool[0]!

  const sshCommand = (await readConfigValue(environment, repository, 'core.sshCommand'))?.value

  const expected = (key: string | null) =>
    key !== null && fileExists(key) ? sshCommandFor(key) : undefined

  return pool.find(({ sshKey }) => expected(sshKey) === sshCommand) ?? pool[0]!
}

export async function resolveEffectiveIdentity(
  environment: Environment,
  directory: string,
): Promise<Resolution> {
  const top = await runGit(environment, directory, ['rev-parse', '--show-toplevel'])

  if (top.exitCode !== 0) {
    return { status: 'not-a-repository', folderScope: folderScopeAt(environment, directory) }
  }

  const repository = top.stdout

  const [email, name] = await Promise.all([
    readConfigValue(environment, repository, 'user.email'),
    readConfigValue(environment, repository, 'user.name'),
  ])

  const origin = classifyOrigin(environment, email)
  const sshCommandOverriddenByEnvironment = Boolean(environment.env.GIT_SSH_COMMAND)

  const { identities } = loadIdentitiesConfig(environment)

  const candidates = identities.filter((candidate) => candidate.email === email?.value)

  const identity =
    candidates.length > 1
      ? await pickSharedEmail(environment, repository, candidates, name?.value)
      : candidates[0]

  if (identity) {
    const [sshKey, signingKey] = await Promise.all([
      keyStatus(environment, repository, identity.sshKey, 'core.sshCommand', sshCommandFor),
      keyStatus(environment, repository, signingKeyOf(identity), 'user.signingkey', (key) => key),
    ])

    return {
      status: 'known',
      repository,
      identity,
      origin,
      sshCommandOverriddenByEnvironment,
      sshKey,
      signingKey,
    }
  }

  return {
    status: 'unknown',
    repository,
    name: name?.value ?? null,
    email: email?.value ?? null,
    origin,
    sshCommandOverriddenByEnvironment,
  }
}
