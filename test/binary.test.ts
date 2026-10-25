import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import packageJson from '../package.json' with { type: 'json' }
import { createCore } from '../src/core/index.ts'

import { createTestHome, PERSONAL_DEFAULT_IDENTITIES, type TestHome } from './harness.ts'

const BUILD_SCRIPT = new URL('../scripts/build.ts', import.meta.url).pathname
const host = `${process.platform}-${process.arch}`
const outDirectory = mkdtempSync(join(tmpdir(), 'qcs-dist-'))

let t: TestHome

beforeAll(() => {
  // bun --compile can leave a large temp file in its cwd; keep it inside the removed out dir.
  const build = Bun.spawnSync(['bun', BUILD_SCRIPT, '--out-dir', outDirectory, host], {
    cwd: outDirectory,
  })

  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`)
}, 60_000)

afterAll(() => {
  rmSync(outDirectory, { recursive: true, force: true })
})

beforeEach(() => {
  t = createTestHome()
})

afterEach(() => {
  t.cleanup()
})

function qcs(cwd: string, ...args: string[]) {
  const binary = join(outDirectory, host, 'qcs')
  const result = Bun.spawnSync([binary, ...args], { cwd, env: t.env })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('compiled qcs binary', () => {
  test('prints the Effective Identity without Bun on the command line', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).apply()

    const { code, out } = qcs(repo, 'status')

    expect(code).toBe(0)
    expect(out).toContain('Personal')
    expect(out).toContain('nico@personal.dev')
  })

  test('exits non-zero outside a repository', () => {
    const outside = t.path('somewhere')

    mkdirSync(outside)

    const { code, out } = qcs(outside, 'status')

    expect(code).not.toBe(0)
    expect(out).toContain('not inside a git repository')
  })

  test('rejects unknown commands with exit code 64', () => {
    const { code, err } = qcs(t.home, 'bogus')

    expect(code).toBe(64)
    expect(err).toContain('unknown command')
  })

  test('prints the version it was built from', () => {
    expect(qcs(t.home, '--version')).toMatchObject({ code: 0, out: `${packageJson.version}\n` })
  })
})
