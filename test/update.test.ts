import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { type Fetch, installationOf, isNewer, update, updateNotice } from '../src/cli/update.ts'

const RELEASES = 'https://github.com/nicosantux/qcs/releases'
const COMPILED_MAIN = '/$bunfs/root/qcs'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qcs-update-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A release of `version` whose linux-x64 archive holds a `qcs` file with `content`. */
function fakeGitHub(version: string, content: string, { corruptSums = false } = {}) {
  const source = mkdtempSync(join(directory, 'release-'))

  writeFileSync(join(source, 'qcs'), content)
  Bun.spawnSync(['tar', '-czf', 'qcs-linux-x64.tar.gz', 'qcs'], { cwd: source })

  const archive = readFileSync(join(source, 'qcs-linux-x64.tar.gz'))

  const hash = corruptSums
    ? '0'.repeat(64)
    : new Bun.CryptoHasher('sha256').update(archive).digest('hex')

  const files: Record<string, string | Uint8Array> = {
    [`${RELEASES}/download/v${version}/SHA256SUMS`]: `${hash}  qcs-linux-x64.tar.gz\n`,
    [`${RELEASES}/download/v${version}/qcs-linux-x64.tar.gz`]: archive,
  }

  const respond = (url: string) => {
    if (url === `${RELEASES}/latest`) {
      return new Response(null, {
        status: 302,
        headers: { location: `${RELEASES}/tag/v${version}` },
      })
    }

    const body = files[url]

    return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body)
  }

  const fetch: Fetch = (url) => Promise.resolve(respond(url))

  return fetch
}

function installedBinary() {
  const binary = join(directory, 'qcs')

  writeFileSync(binary, 'old binary')

  return binary
}

describe('installationOf', () => {
  test('tells a release binary from one run from source', () => {
    expect(installationOf('/home/nico/.local/bin/qcs', COMPILED_MAIN)).toEqual({
      kind: 'standalone',
      binary: '/home/nico/.local/bin/qcs',
    })
    expect(installationOf('/opt/homebrew/bin/bun', '/home/nico/qcs/src/cli/main.ts')).toEqual({
      kind: 'source',
    })
  })

  test.each([
    ['/opt/homebrew/Cellar/qcs/1.1.0/bin/qcs', 'run "brew upgrade qcs"'],
    ['/home/linuxbrew/.linuxbrew/Cellar/qcs/1.1.0/bin/qcs', 'run "brew upgrade qcs"'],
    [
      '/home/nico/.local/share/mise/installs/github-nicosantux-qcs/1.1.0/qcs',
      'run "mise upgrade github:nicosantux/qcs"',
    ],
    ['/usr/bin/qcs', 'update it with your package manager'],
  ])('leaves %s to its package manager', (binary, upgradeHint) => {
    expect(installationOf(binary, COMPILED_MAIN)).toEqual({ kind: 'managed', upgradeHint })
  })
})

test('isNewer compares each part as a number', () => {
  expect(isNewer('1.10.0', '1.9.0')).toBe(true)
  expect(isNewer('2.0.0', '1.99.99')).toBe(true)
  expect(isNewer('1.1.0', '1.1.0')).toBe(false)
  expect(isNewer('1.0.9', '1.1.0')).toBe(false)
})

describe('update', () => {
  test('replaces the binary with the newer release', async () => {
    const binary = installedBinary()

    const updated = await update({
      binary,
      current: '1.1.0',
      fetch: fakeGitHub('1.2.0', 'new binary'),
      target: 'linux-x64',
    })

    expect(updated).toBe('1.2.0')
    expect(readFileSync(binary, 'utf8')).toBe('new binary')
    expect(statSync(binary).mode & 0o777).toBe(0o755)
  })

  test.each(['1.1.0', '1.0.0'])('leaves the binary alone when the latest is %s', async (latest) => {
    const binary = installedBinary()

    const updated = await update({
      binary,
      current: '1.1.0',
      fetch: fakeGitHub(latest, 'other binary'),
      target: 'linux-x64',
    })

    expect(updated).toBeNull()
    expect(readFileSync(binary, 'utf8')).toBe('old binary')
  })

  test('refuses an archive that does not match SHA256SUMS', async () => {
    const binary = installedBinary()

    const updating = update({
      binary,
      current: '1.1.0',
      fetch: fakeGitHub('1.2.0', 'tampered binary', { corruptSums: true }),
      target: 'linux-x64',
    })

    expect(await updating.then(String, (error: Error) => error.message)).toContain('checksum')
    expect(readFileSync(binary, 'utf8')).toBe('old binary')
  })

  test('fails when the release has no archive for the platform', async () => {
    const binary = installedBinary()

    const updating = update({
      binary,
      current: '1.1.0',
      fetch: fakeGitHub('1.2.0', 'new binary'),
      target: 'linux-riscv64',
    })

    expect(await updating.then(String, (error: Error) => error.message)).toContain(
      'no build for linux-riscv64',
    )
    expect(readFileSync(binary, 'utf8')).toBe('old binary')
  })
})

describe('updateNotice', () => {
  const standalone = { kind: 'standalone', binary: '/home/nico/.local/bin/qcs' } as const

  test('suggests qcs update, or the package manager that owns the binary', async () => {
    expect(await updateNotice(standalone, '1.1.0', fakeGitHub('1.2.0', ''))).toBe(
      'qcs 1.2.0 is available: run "qcs update"',
    )
    expect(
      await updateNotice(
        { kind: 'managed', upgradeHint: 'run "mise upgrade github:nicosantux/qcs"' },
        '1.1.0',
        fakeGitHub('1.2.0', ''),
      ),
    ).toBe('qcs 1.2.0 is available: run "mise upgrade github:nicosantux/qcs"')
  })

  test('is null when up to date or GitHub cannot be reached', async () => {
    expect(await updateNotice(standalone, '1.2.0', fakeGitHub('1.2.0', ''))).toBeNull()
    expect(
      await updateNotice(standalone, '1.1.0', () => Promise.reject(new Error('offline'))),
    ).toBeNull()
  })
})
