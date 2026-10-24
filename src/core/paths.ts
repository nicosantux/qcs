import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface Environment {
  env: Record<string, string | undefined>
  home: string
}

export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))

  return path
}

export function xdgConfigHome({ home, env }: Environment): string {
  const configured = env.XDG_CONFIG_HOME

  return configured && configured.length > 0 ? configured : join(home, '.config')
}

export function configDirectory(environment: Environment): string {
  return join(xdgConfigHome(environment), 'qcs')
}

export function generatedDirectory(environment: Environment): string {
  return join(configDirectory(environment), 'generated')
}

export function managedGitConfigPath(environment: Environment): string {
  return join(generatedDirectory(environment), 'managed.gitconfig')
}

export function allowedSignersPath(environment: Environment): string {
  return join(generatedDirectory(environment), 'allowed_signers')
}

export function identityGitConfigPath(environment: Environment, identityId: string): string {
  return join(generatedDirectory(environment), 'identities', `${identityId}.gitconfig`)
}

export function backupsDirectory(environment: Environment): string {
  return join(configDirectory(environment), 'backups')
}

export function folderScopesDirectory(environment: Environment): string {
  return join(generatedDirectory(environment), 'folder-scopes')
}

function scopeFileName(path: string): string {
  return `${createHash('sha1').update(path).digest('hex').slice(0, 16)}.gitconfig`
}

export function folderScopeGitConfigPath(environment: Environment, folder: string): string {
  return join(folderScopesDirectory(environment), scopeFileName(folder))
}

export function repoScopesDirectory(environment: Environment): string {
  return join(generatedDirectory(environment), 'repo-scopes')
}

export function repoScopeGitConfigPath(environment: Environment, repository: string): string {
  return join(repoScopesDirectory(environment), scopeFileName(repository))
}

export function remoteScopesDirectory(environment: Environment): string {
  return join(generatedDirectory(environment), 'remote-scopes')
}

export function remoteScopeGitConfigPath(environment: Environment, pattern: string): string {
  return join(remoteScopesDirectory(environment), scopeFileName(pattern))
}
