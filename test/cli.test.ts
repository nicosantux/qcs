import { unlinkSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createCore } from '../src/core/index.ts'

import { createTestHome, PERSONAL_DEFAULT_IDENTITIES, type TestHome } from './harness.ts'

const ENTRY = new URL('../src/cli/main.ts', import.meta.url).pathname

let t: TestHome

beforeEach(() => {
  t = createTestHome()
})

afterEach(() => {
  t.cleanup()
})

function qcs(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', ENTRY, ...args], { cwd, env: t.env })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('qcs status', () => {
  test('prints the Effective Identity and that it comes from the Default Identity', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).apply()

    const { code, out } = qcs(repo, 'status')

    expect(code).toBe(0)
    expect(out).toContain('Personal')
    expect(out).toContain('Nico Personal')
    expect(out).toContain('nico@personal.dev')
    expect(out).toContain('Default Identity')
  })

  test('reports an Unknown Identity and exits non-zero', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).apply()
    t.git(repo, 'config', 'user.email', 'stranger@example.com')

    const { code, out } = qcs(repo, 'status')

    expect(code).not.toBe(0)
    expect(out).toContain('Unknown Identity')
    expect(out).toContain('stranger@example.com')
    expect(out).toContain('External Rule')
  })

  test('shows the name of an Unknown Identity even when no email is set', () => {
    const repo = t.makeRepo('code/a')

    t.git(repo, 'config', 'user.name', 'Only Name')

    const { code, out } = qcs(repo, 'status')

    expect(code).toBe(1)
    expect(out).toContain('Only Name <no email>')
  })

  test('says so clearly outside a repository and exits non-zero', () => {
    const outside = t.path('somewhere')

    Bun.spawnSync(['mkdir', '-p', outside])

    const { code, out } = qcs(outside, 'status')

    expect(code).not.toBe(0)
    expect(out).toContain('not inside a git repository')
  })

  test('outside a repository names the Folder Scope that covers the directory', async () => {
    t.writeIdentities(`${PERSONAL_DEFAULT_IDENTITIES}
[identities.work]
label = "Work"
name = "Nico Work"
email = "nico@work.dev"
`)
    Bun.spawnSync(['mkdir', '-p', t.path('work/inner')])
    await createCore({ home: t.home, env: t.env }).assignFolder('~/work', 'work')

    const { code, out } = qcs(t.path('work/inner'), 'status')

    expect(code).toBe(2)
    expect(out).toContain('not inside a git repository')
    expect(out).toContain('Folder Scope ~/work assigns Work')
  })

  test('mentions GIT_SSH_COMMAND when it is set', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).apply()
    t.env.GIT_SSH_COMMAND = 'ssh -v'

    expect(qcs(repo, 'status').out).toContain('GIT_SSH_COMMAND')
  })

  test('fails with a message for an unknown command', () => {
    const { code, err } = qcs(t.home, 'frobnicate')

    expect(code).not.toBe(0)
    expect(err).toContain('frobnicate')
    expect(err).toContain('qcs --help')
  })

  test('prints the usage for --help, -h and help', () => {
    for (const flag of ['--help', '-h', 'help']) {
      const { code, out } = qcs(t.home, flag)

      expect(code).toBe(0)
      expect(out).toContain('use <identity-id>')
    }
  })
})

describe('qcs use', () => {
  const WORK = `${PERSONAL_DEFAULT_IDENTITIES}
[identities.work]
label = "Work"
name = "Nico Work"
email = "nico@work.dev"
`

  test('assigns the current repository to the Identity, applies it and status reports a Repo Scope', async () => {
    t.writeIdentities(WORK)
    const repo = t.makeRepo('code/a')
    const other = t.makeRepo('code/b')

    await createCore({ home: t.home, env: t.env }).apply()

    const { code, out } = qcs(repo, 'use', 'work')

    expect(code).toBe(0)
    expect(out).toContain('Repo Scope')
    expect(t.git(repo, 'config', 'user.email')).toBe('nico@work.dev')
    expect(t.git(other, 'config', 'user.email')).toBe('nico@personal.dev')

    const status = qcs(repo, 'status')

    expect(status.out).toContain('Work')
    expect(status.out).toContain('Repo Scope')
  })

  test('replaces an existing Repo Scope from a nested directory', () => {
    t.writeIdentities(WORK)
    const repo = t.makeRepo('code/a')

    Bun.spawnSync(['mkdir', '-p', `${repo}/src/deep`])
    qcs(repo, 'use', 'work')
    qcs(`${repo}/src/deep`, 'use', 'personal')

    expect(t.git(repo, 'config', 'user.email')).toBe('nico@personal.dev')
    expect(qcs(repo, 'status').out).toContain('Repo Scope')
  })

  test('fails with the valid ids when the Identity is unknown', () => {
    t.writeIdentities(WORK)
    const repo = t.makeRepo('code/a')

    const { code, err } = qcs(repo, 'use', 'nobody')

    expect(code).not.toBe(0)
    expect(err).toContain('nobody')
    expect(err).toContain('personal, work')
  })

  test('fails clearly outside a repository and without an id', () => {
    t.writeIdentities(WORK)
    Bun.spawnSync(['mkdir', '-p', t.path('plain')])

    const outside = qcs(t.path('plain'), 'use', 'work')

    expect(outside.code).not.toBe(0)
    expect(outside.out + outside.err).toContain('not inside a git repository')

    const missing = qcs(t.makeRepo('code/a'), 'use')

    expect(missing.code).not.toBe(0)
    expect(missing.err).toContain('Usage')
  })
})

describe('qcs status with a Remote Scope', () => {
  test('reports the Remote Scope as the origin', async () => {
    t.writeIdentities(`${PERSONAL_DEFAULT_IDENTITIES}
[identities.work]
label = "Work"
name = "Nico Work"
email = "nico@work.dev"
`)
    const repo = t.makeRepo('code/a')

    t.git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/a.git')
    await createCore({ home: t.home, env: t.env }).assignRemote('git@github.com:acme/**', 'work')

    const { code, out } = qcs(repo, 'status')

    expect(code).toBe(0)
    expect(out).toContain('Work')
    expect(out).toContain('Origin:   Remote Scope')
  })
})

describe('qcs status SSH key', () => {
  const work = { label: 'Work', name: 'Nico Work', email: 'nico@work.dev' }

  test('says whether pushes use the Identity key and when it is missing', async () => {
    const key = t.write('.ssh/id_work', 'PRIVATE')
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, sshKey: key })
    expect(qcs(repo, 'status').out).toContain(`SSH key:  ${key} (pushes use it)`)

    unlinkSync(key)
    expect(qcs(repo, 'status').out).toContain('is missing on this Machine, pushes fail')

    await core.apply()
    expect(qcs(repo, 'status').out).toContain(
      'is missing on this Machine, pushes use your normal SSH setup',
    )
  })

  test('does not claim pushes use the key when GIT_SSH_COMMAND overrides it', async () => {
    const key = t.write('.ssh/id_work', 'PRIVATE')
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).createIdentity({ ...work, sshKey: key })
    t.env.GIT_SSH_COMMAND = 'ssh -v'

    expect(qcs(repo, 'status').out).toContain(`SSH key:  ${key} (overridden by GIT_SSH_COMMAND)`)
  })

  test('says whether commits are signed and when the signing key is missing', async () => {
    const key = t.write('.ssh/id_work', 'PRIVATE')
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(work)
    expect(qcs(repo, 'status').out).not.toContain('Signing:')

    await core.editIdentity('work', { ...work, signingKey: key })
    expect(qcs(repo, 'status').out).toContain(`Signing:  ${key} (commits are signed)`)

    unlinkSync(key)
    await core.apply()
    expect(qcs(repo, 'status').out).toContain('is missing on this Machine, commits are not signed')
  })

  test('says there is no key for an Identity without one', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).apply()

    expect(qcs(repo, 'status').out).toContain('SSH key:  none')
  })
})

describe('qcs add', () => {
  const roots = () =>
    createCore({ home: t.home, env: t.env })
      .loadScanRoots()
      .map((root) => root.displayPath)

  test('registers the current directory as a Scan Root without a path', () => {
    t.makeRepo('code/a')

    const { code, out } = qcs(t.path('code'), 'add')

    expect(code).toBe(0)
    expect(out).toContain('Added Scan Root ~/code')
    expect(roots()).toEqual(['~/code'])
  })

  test('resolves a relative path against the current directory and expands a quoted ~', () => {
    t.makeRepo('code/a')
    t.makeRepo('work/b')

    expect(qcs(t.home, 'add', 'code').code).toBe(0)
    expect(qcs(t.path('code'), 'add', '~/work').code).toBe(0)
    expect(roots()).toEqual(['~/code', '~/work'])
  })

  test('rejects an empty path instead of adding the current directory', () => {
    t.makeRepo('code/a')

    const { code, err } = qcs(t.path('code'), 'add', '')

    expect(code).not.toBe(0)
    expect(err).toContain('Path cannot be empty')
    expect(roots()).toEqual([])
  })
})
