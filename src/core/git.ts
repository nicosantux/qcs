import type { Environment } from './paths.ts'

export interface GitResult {
  exitCode: number
  stderr: string
  stdout: string
}

const GIT_TIMEOUT_MS = 10_000

export async function runGit(
  environment: Environment,
  cwd: string,
  args: string[],
): Promise<GitResult> {
  const process = Bun.spawn(['git', ...args], {
    cwd,
    env: { ...environment.env, HOME: environment.home },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: GIT_TIMEOUT_MS,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

const MINIMUM_REMOTE_SCOPE_VERSION = [2, 36]

/** Why Remote Scopes cannot work with the installed git (`hasconfig:` needs 2.36), or null when they can. */
export async function remoteScopesUnavailableReason(
  environment: Environment,
): Promise<string | null> {
  const { exitCode, stdout } = await runGit(environment, environment.home, ['--version'])
  const match = /(\d+)\.(\d+)(?:\.\d+)*/.exec(stdout)

  if (exitCode !== 0 || match === null) return null
  const [major, minor] = [Number(match[1]), Number(match[2])]
  const [requiredMajor, requiredMinor] = MINIMUM_REMOTE_SCOPE_VERSION

  if (major > requiredMajor! || (major === requiredMajor && minor >= requiredMinor!)) return null

  return `Remote Scopes need git ${requiredMajor}.${requiredMinor} or newer (found ${match[0]})`
}
