import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const RELEASES_URL = 'https://github.com/nicosantux/qcs/releases'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** How this binary was installed: only a `standalone` one may replace itself. */
export type Installation =
  | { kind: 'source' }
  | { kind: 'managed'; upgradeHint: string }
  | { kind: 'standalone'; binary: string }

const MANAGED_PATHS = [
  { matches: (path: string) => path.includes('/Cellar/'), upgradeHint: 'run "brew upgrade qcs"' },
  {
    matches: (path: string) => path.includes('/mise/installs/'),
    upgradeHint: 'run "mise upgrade github:nicosantux/qcs"',
  },
  {
    matches: (path: string) => path.startsWith('/usr/bin/'),
    upgradeHint: 'update it with your package manager',
  },
]

/**
 * Tells a release binary from `bun run` (where `execPath` is bun itself) and from one owned by a package manager.
 * `binary` must be the real path, with symlinks resolved.
 */
export function installationOf(binary: string, main: string): Installation {
  if (!main.startsWith('/$bunfs/')) return { kind: 'source' }

  const managed = MANAGED_PATHS.find(({ matches }) => matches(binary))

  return managed === undefined
    ? { kind: 'standalone', binary }
    : { kind: 'managed', upgradeHint: managed.upgradeHint }
}

/** The version of the latest GitHub release, read from the redirect of `releases/latest` so no API rate limit applies. */
export async function latestVersion(fetch: Fetch, timeoutMs = 10_000): Promise<string> {
  const response = await fetch(`${RELEASES_URL}/latest`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })

  const version = /\/tag\/v(\d+\.\d+\.\d+)$/.exec(response.headers.get('location') ?? '')?.[1]

  if (version === undefined) {
    throw new Error(`could not read the latest version from GitHub (HTTP ${response.status})`)
  }

  return version
}

export function isNewer(candidate: string, current: string): boolean {
  const [a, b] = [candidate, current].map((version) => version.split('.').map(Number)) as [
    number[],
    number[],
  ]

  const differs = a.findIndex((part, index) => part !== b[index])

  return differs >= 0 && a[differs]! > b[differs]!
}

/** The footer notice of the TUI, or null when there is nothing newer or GitHub can't be reached. */
export async function updateNotice(
  installation: Installation,
  current: string,
  fetch: Fetch,
): Promise<string | null> {
  try {
    const latest = await latestVersion(fetch, 3000)

    if (!isNewer(latest, current)) return null

    const hint = installation.kind === 'managed' ? installation.upgradeHint : 'run "qcs update"'

    return `qcs ${latest} is available: ${hint}`
  } catch {
    return null
  }
}

interface UpdateOptions {
  binary: string
  current: string
  fetch: Fetch
  target: string
}

/** Replaces `binary` with the latest release when it is newer, and returns that version (null when already up to date). */
export async function update({
  binary,
  current,
  fetch,
  target,
}: UpdateOptions): Promise<string | null> {
  const latest = await latestVersion(fetch)

  if (!isNewer(latest, current)) return null

  const asset = `qcs-${target}.tar.gz`

  const download = async (name: string) => {
    const response = await fetch(`${RELEASES_URL}/download/v${latest}/${name}`)

    if (!response.ok) throw new Error(`could not download ${name} (HTTP ${response.status})`)

    return response
  }

  const sums = await (await download('SHA256SUMS')).text()

  const expected = sums
    .split('\n')
    .find((line) => line.endsWith(` ${asset}`))
    ?.split(' ')[0]

  if (expected === undefined) throw new Error(`qcs ${latest} has no build for ${target}`)

  const archive = new Uint8Array(await (await download(asset)).arrayBuffer())
  const actual = new Bun.CryptoHasher('sha256').update(archive).digest('hex')

  if (expected !== actual) {
    throw new Error(`the checksum of ${asset} does not match SHA256SUMS`)
  }

  // Extracted next to the binary, so the final rename stays on one file system and is atomic.
  const staging = mkdtempSync(join(dirname(binary), '.qcs-update-'))

  try {
    writeFileSync(join(staging, asset), archive)

    const extract = Bun.spawnSync(['tar', '--no-same-owner', '-xzf', asset], { cwd: staging })

    if (extract.exitCode !== 0) {
      throw new Error(`could not extract ${asset}: ${extract.stderr.toString().trim()}`)
    }

    chmodSync(join(staging, 'qcs'), 0o755)
    renameSync(join(staging, 'qcs'), binary)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  return latest
}
