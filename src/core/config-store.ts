import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parse, stringify } from 'smol-toml'

import { fileExists, writeFileAtomic } from './fs.ts'
import { nextIdentityColor } from './identity-colors.ts'
import { configDirectory, expandHome, type Environment } from './paths.ts'

export interface Identity {
  /** An ANSI palette index, so the color follows the terminal theme; kept in the file so it never changes. */
  color: number
  email: string
  id: string
  label: string
  name: string
  /** `SIGN_WITH_SSH_KEY` signs with `sshKey`; otherwise the path of a dedicated key, or null for no signing. */
  signingKey: string | null
  sshKey: string | null
}

/** The `signing_key` value that signs commits with the Identity's own SSH key; key paths are always absolute or `~`. */
export const SIGN_WITH_SSH_KEY = 'ssh_key'

/** The key that signs the Identity's commits, or null when it does not sign. */
export function signingKeyOf({ signingKey, sshKey }: Identity): string | null {
  return signingKey === SIGN_WITH_SSH_KEY ? sshKey : signingKey
}

export interface IdentitiesConfig {
  defaultIdentityId: string | null
  identities: Identity[]
}

export interface RemoteScope {
  identityId: string
  /** A git glob matched against every remote URL of a repository. */
  pattern: string
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function requireValidId(id: string): string {
  if (!IDENTITY_ID_PATTERN.test(id)) {
    throw new ConfigError(
      `identities.toml: identity id "${id}" may only contain letters, digits, "_" and "-"`,
    )
  }

  return id
}

export function assertIdentityExists({ identities }: IdentitiesConfig, id: string): void {
  if (identities.some((identity) => identity.id === id)) return

  throw new ConfigError(
    `Identity "${id}" does not exist. Valid ids: ${identities.map((identity) => identity.id).join(', ') || '(none)'}`,
  )
}

export function identitiesFilePath(environment: Environment): string {
  return join(configDirectory(environment), 'identities.toml')
}

function requireString(value: unknown, field: string, identityId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`identities.toml: identity "${identityId}" needs a non-empty "${field}"`)
  }

  return value
}

const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** The parsed TOML file, or null when it does not exist. */
export function readTomlFile(file: string): Record<string, unknown> | null {
  if (!fileExists(file)) return null

  try {
    return parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ConfigError(`${basename(file)} is not valid TOML: ${(error as Error).message}`)
  }
}

function readDocument(environment: Environment): Record<string, unknown> | null {
  return readTomlFile(identitiesFilePath(environment))
}

export function collapseHome(path: string, home: string): string {
  if (path === home) return '~'

  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * Rewrites `default` and `identities`, keeping any other top-level content of the file.
 * shortcut: comments and formatting are lost on save, switch to a comment-preserving TOML editor if users hand-edit the file.
 */
export function saveIdentitiesConfig(environment: Environment, config: IdentitiesConfig): void {
  const { default: _default, identities: _identities, ...rest } = readDocument(environment) ?? {}

  const identities = Object.fromEntries(
    config.identities.map((identity) => [
      identity.id,
      {
        label: identity.label,
        name: identity.name,
        email: identity.email,
        color: identity.color,
        ...(identity.sshKey === null
          ? {}
          : { ssh_key: collapseHome(identity.sshKey, environment.home) }),
        ...(identity.signingKey === null
          ? {}
          : {
              signing_key:
                identity.signingKey === SIGN_WITH_SSH_KEY
                  ? SIGN_WITH_SSH_KEY
                  : collapseHome(identity.signingKey, environment.home),
            }),
      },
    ]),
  )

  const document = {
    ...(config.defaultIdentityId === null ? {} : { default: config.defaultIdentityId }),
    ...rest,
    identities,
  }

  writeFileAtomic(identitiesFilePath(environment), stringify(document))
}

export function loadIdentitiesConfig(environment: Environment): IdentitiesConfig {
  const document = readDocument(environment)

  if (document === null) return { identities: [], defaultIdentityId: null }

  const table = (document.identities ?? {}) as Record<string, Record<string, unknown>>

  const identities = Object.entries(table).reduce<Identity[]>((loaded, [id, fields]) => {
    const stored = fields.color

    const color =
      typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 && stored <= 255
        ? stored
        : nextIdentityColor(loaded)

    return [
      ...loaded,
      {
        id: requireValidId(id),
        color,
        label: typeof fields.label === 'string' && fields.label.length > 0 ? fields.label : id,
        name: requireString(fields.name, 'name', id),
        email: requireString(fields.email, 'email', id),
        sshKey:
          typeof fields.ssh_key === 'string' ? expandHome(fields.ssh_key, environment.home) : null,
        signingKey:
          typeof fields.signing_key !== 'string'
            ? null
            : fields.signing_key === SIGN_WITH_SSH_KEY
              ? SIGN_WITH_SSH_KEY
              : expandHome(fields.signing_key, environment.home),
      },
    ]
  }, [])

  const defaultIdentityId = typeof document.default === 'string' ? document.default : null

  if (
    defaultIdentityId !== null &&
    !identities.some((identity) => identity.id === defaultIdentityId)
  ) {
    throw new ConfigError(`identities.toml: default identity "${defaultIdentityId}" is not defined`)
  }

  return { identities, defaultIdentityId }
}

export function parseRemotePattern(pattern: unknown): string {
  const trimmed = typeof pattern === 'string' ? pattern.trim() : ''

  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) {
    throw new ConfigError('Pattern must be a non-empty single line')
  }

  return trimmed
}

export function loadRemoteScopes(environment: Environment): RemoteScope[] {
  const entries = readDocument(environment)?.remote_scopes ?? []

  if (!Array.isArray(entries)) {
    throw new ConfigError('identities.toml: "remote_scopes" must be an array of tables')
  }

  const scopes = new Map<string, RemoteScope>()

  for (const entry of entries as Record<string, unknown>[]) {
    if (typeof entry.identity !== 'string' || entry.identity.length === 0) {
      throw new ConfigError(
        `identities.toml: remote scope "${String(entry.pattern)}" needs an "identity"`,
      )
    }

    const pattern = parseRemotePattern(entry.pattern)

    scopes.set(pattern, { pattern, identityId: entry.identity })
  }

  return [...scopes.values()]
}

/** Rewrites `remote_scopes`, keeping any other top-level content of the file. */
export function saveRemoteScopes(environment: Environment, scopes: readonly RemoteScope[]): void {
  const { remote_scopes: _remoteScopes, ...rest } = readDocument(environment) ?? {}

  writeFileAtomic(
    identitiesFilePath(environment),
    stringify({
      ...rest,
      ...(scopes.length === 0
        ? {}
        : {
            remote_scopes: scopes.map((scope) => ({
              pattern: scope.pattern,
              identity: scope.identityId,
            })),
          }),
    }),
  )
}
