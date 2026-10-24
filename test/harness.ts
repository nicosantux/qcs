import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TestHome {
  cleanup: () => void
  configDir: string
  env: Record<string, string>
  git: (cwd: string, ...args: string[]) => string
  home: string
  makeRepo: (relativePath: string) => string
  path: (...segments: string[]) => string
  write: (relativePath: string, content: string) => string
  writeIdentities: (toml: string) => void
}

const GIT_ENV_TO_CLEAR = [
  'GIT_CONFIG_GLOBAL',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_SYSTEM',
  'XDG_CONFIG_HOME',
]

/**
 * Creates an isolated home directory and a process environment that keeps git
 * from reading anything of the developer's machine.
 */
export function createTestHome(): TestHome {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'qcs-test-')))
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !GIT_ENV_TO_CLEAR.includes(key)) env[key] = value
  }

  env.HOME = home
  env.XDG_CONFIG_HOME = join(home, '.config')
  env.GIT_CONFIG_NOSYSTEM = '1'
  const configDir = join(env.XDG_CONFIG_HOME, 'qcs')

  const path = (...segments: string[]) => join(home, ...segments)

  const git = (cwd: string, ...args: string[]): string => {
    const result = Bun.spawnSync(['git', ...args], { cwd, env })

    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
    }

    return result.stdout.toString().trim()
  }

  const write = (relativePath: string, content: string): string => {
    const target = path(relativePath)

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)

    return target
  }

  return {
    home,
    env,
    configDir,
    path,
    write,
    git,
    makeRepo(relativePath) {
      const repo = path(relativePath)

      mkdirSync(repo, { recursive: true })
      git(repo, 'init', '--quiet')

      return repo
    },
    writeIdentities(toml) {
      mkdirSync(configDir, { recursive: true })
      writeFileSync(join(configDir, 'identities.toml'), toml)
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export const PERSONAL_DEFAULT_IDENTITIES = `
default = "personal"

[identities.personal]
label = "Personal"
name = "Nico Personal"
email = "nico@personal.dev"
`
