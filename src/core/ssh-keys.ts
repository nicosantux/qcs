import type { Environment } from './paths.ts'

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigError } from './config-store.ts'
import { fileExists } from './fs.ts'

/**
 * `used`: git hands the key to ssh. `missing`: the key file is gone on this Machine.
 * `stale`: the key file is gone but the generated config still hands it to ssh, so pushes fail until qcs applies again.
 */
export type SshKeyStatus = 'missing' | 'none' | 'stale' | 'used'

/** Private keys directly inside `~/.ssh` that have a matching `.pub` file. */
export function listSshKeys({ home }: Environment): string[] {
  const directory = join(home, '.ssh')

  try {
    return readdirSync(directory)
      .filter(
        (name) =>
          !name.endsWith('.pub') &&
          fileExists(join(directory, `${name}.pub`)) &&
          statSync(join(directory, name), { throwIfNoEntry: false })?.isFile(),
      )
      .toSorted()
      .map((name) => join(directory, name))
  } catch {
    return []
  }
}

/** Deletes a key listed by `listSshKeys` and its public key; anything else is refused. */
export function deleteSshKey(environment: Environment, key: string): void {
  if (!listSshKeys(environment).includes(key)) {
    throw new ConfigError(`${key} is not an SSH key in ~/.ssh`)
  }

  rmSync(key)
  rmSync(`${key}.pub`, { force: true })
}

export function sshCommandFor(key: string): string {
  return `ssh -i '${key.replaceAll("'", String.raw`'\''`)}' -o IdentitiesOnly=yes`
}

const taken = (path: string) => fileExists(path) || fileExists(`${path}.pub`)

const KEY_NAME = /^[\w-][\w.-]*$/

/** Files ssh reads from `~/.ssh` that a key must never take the place of. */
const SSH_FILES = new Set([
  'authorized_keys',
  'authorized_keys2',
  'config',
  'environment',
  'known_hosts',
  'rc',
])

/** The path for a key file name chosen by the user; rejects names that leave `~/.ssh` or touch an existing file. */
export function namedKeyPath({ home }: Environment, name: string): string {
  if (!KEY_NAME.test(name) || name.endsWith('.pub') || SSH_FILES.has(name)) {
    throw new ConfigError(
      `Key name "${name}" must be a file name of letters, digits, ".", "_" or "-", not ending in .pub`,
    )
  }

  const path = join(home, '.ssh', name)

  if (taken(path)) throw new ConfigError(`The key ${path} already exists`)

  return path
}

/** The key file name derived from the Identity id; a numeric suffix keeps it from touching an existing key or public key. */
export function freeKeyPath({ home }: Environment, identityId: string): string {
  const directory = join(home, '.ssh')
  let path = join(directory, `id_ed25519_${identityId}`)

  for (let suffix = 2; taken(path); suffix++) {
    path = join(directory, `id_ed25519_${identityId}-${suffix}`)
  }

  return path
}

/** Runs `ssh-keygen` for a new ed25519 key at `path`; the passphrase is empty for no passphrase. */
export async function generateSshKey(
  environment: Environment,
  path: string,
  comment: string,
  passphrase: string,
): Promise<void> {
  mkdirSync(join(environment.home, '.ssh'), { recursive: true, mode: 0o700 })

  // The passphrase travels in the environment, which other users cannot read, instead of `-N` in the arguments.
  const askpassDirectory = mkdtempSync(join(tmpdir(), 'qcs-askpass-'))
  const askpass = join(askpassDirectory, 'askpass')

  writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "$QCS_PASSPHRASE"\n`, { mode: 0o700 })

  try {
    let process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>

    try {
      process = Bun.spawn(['ssh-keygen', '-q', '-t', 'ed25519', '-C', comment, '-f', path], {
        env: {
          ...environment.env,
          HOME: environment.home,
          QCS_PASSPHRASE: passphrase,
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: 'force',
          // OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE and only asks the askpass when DISPLAY is set.
          DISPLAY: environment.env.DISPLAY ?? 'qcs',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch {
      throw new ConfigError('ssh-keygen is not available')
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])

    if (exitCode !== 0) {
      throw new ConfigError(
        `ssh-keygen failed: ${(stderr || stdout).trim() || `exit code ${exitCode}`}`,
      )
    }
  } finally {
    rmSync(askpassDirectory, { recursive: true, force: true })
  }
}

const CLIPBOARD_COMMANDS =
  process.platform === 'darwin'
    ? [['pbcopy']]
    : [['wl-copy'], ['xclip', '-selection', 'clipboard', '-in']]

/** Puts the public key of `key` on the clipboard with the first platform clipboard command that succeeds. */
export async function copyPublicKey(environment: Environment, key: string): Promise<void> {
  let publicKey: string

  try {
    publicKey = readFileSync(`${key}.pub`, 'utf8')
  } catch {
    throw new ConfigError(`The public key ${key}.pub does not exist`)
  }

  let failed: string | null = null

  for (const command of CLIPBOARD_COMMANDS) {
    let process: Bun.Subprocess<Buffer, 'ignore', 'ignore'>

    try {
      // Output is ignored: wl-copy and xclip leave a background process that would keep a pipe open.
      process = Bun.spawn(command, {
        env: environment.env,
        stdin: Buffer.from(publicKey),
        stdout: 'ignore',
        stderr: 'ignore',
      })
    } catch {
      continue
    }

    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: wl-copy fails on X11 sessions, where xclip works
    if ((await process.exited) === 0) return

    failed ??= command[0]!
  }

  if (failed !== null) throw new ConfigError(`${failed} failed to copy the public key`)

  throw new ConfigError(
    `No clipboard command found (needs ${CLIPBOARD_COMMANDS.map(([name]) => name).join(' or ')})`,
  )
}
