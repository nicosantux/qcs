import type { IdentitiesConfig, RemoteScope } from './config-store.ts'
import type { Environment } from './paths.ts'

import {
  assertIdentityExists,
  ConfigError,
  loadRemoteScopes,
  parseRemotePattern,
} from './config-store.ts'
import { runGit } from './git.ts'

/** Remote Scopes after assigning `identityId` to `pattern`, or after removing the Assignment when null. */
export function withRemoteScope(
  environment: Environment,
  config: IdentitiesConfig,
  pattern: string,
  identityId: string | null,
): RemoteScope[] {
  const parsed = parseRemotePattern(pattern)
  const existing = loadRemoteScopes(environment)

  if (identityId === null) {
    if (!existing.some((scope) => scope.pattern === parsed)) {
      throw new ConfigError(`"${parsed}" is not a Remote Scope`)
    }

    return existing.filter((scope) => scope.pattern !== parsed)
  }

  assertIdentityExists(config, identityId)

  // A replaced pattern keeps its position: Remote Scopes that both match are applied in file order.
  return existing.some((scope) => scope.pattern === parsed)
    ? existing.map((scope) => (scope.pattern === parsed ? { pattern: parsed, identityId } : scope))
    : [...existing, { pattern: parsed, identityId }]
}

/** A pattern covering every repository of the owner (or organization) in the repository's remote. */
export async function suggestRemotePattern(
  environment: Environment,
  repositoryPath: string,
): Promise<string> {
  const { stdout } = await runGit(environment, repositoryPath, [
    'config',
    '--get-regexp',
    String.raw`^remote\..*\.url$`,
  ])

  const urls = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ key: line.split(' ')[0]!, url: line.slice(line.indexOf(' ') + 1) }))

  const url = (urls.find(({ key }) => key === 'remote.origin.url') ?? urls[0])?.url

  if (url === undefined) throw new ConfigError(`"${repositoryPath}" has no remote`)

  // The pattern is stored in the shareable file, so a password or token in the URL becomes a wildcard.
  const safeUrl = url.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*:[^/@]*@/i, '$1*@')
  const owner = /^(?:[a-z][a-z\d+.-]*:\/\/[^/]+\/|[^/:]+:)[^/]+(?=\/)/i.exec(safeUrl)?.[0]

  return owner === undefined ? safeUrl : `${owner}/**`
}
