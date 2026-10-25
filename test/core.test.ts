import { chmodSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { isCaseInsensitiveFileSystem } from '../src/core/fs.ts'
import { gitdirCondition } from '../src/core/generator.ts'
import { AssignmentConflictError, createCore, SIGN_WITH_SSH_KEY } from '../src/core/index.ts'

import { createTestHome, PERSONAL_DEFAULT_IDENTITIES, type TestHome } from './harness.ts'

let t: TestHome

beforeEach(() => {
  t = createTestHome()
})

afterEach(() => {
  t.cleanup()
})

describe('Default Identity', () => {
  test('after apply, git in any repository reports the Default Identity with the managed file as origin', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repoA = t.makeRepo('code/a')
    const repoB = t.makeRepo('elsewhere/deep/b')

    await createCore({ home: t.home, env: t.env }).apply()

    for (const repo of [repoA, repoB]) {
      expect(t.git(repo, 'config', 'user.email')).toBe('nico@personal.dev')
      expect(t.git(repo, 'config', 'user.name')).toBe('Nico Personal')
      expect(t.git(repo, 'config', '--show-origin', 'user.email')).toContain(t.configDir)
    }
  })
})

describe('global git config', () => {
  test('applying twice leaves exactly one include and keeps existing content before it', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const gitconfig = t.write('.gitconfig', '[core]\n\teditor = vim')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()
    await core.apply()

    const content = await Bun.file(gitconfig).text()

    expect(content.match(/\[include\]/g)).toHaveLength(1)
    expect(content.startsWith('[core]\n\teditor = vim\n')).toBe(true)
    expect(content.trimEnd().split('\n').at(-1)).toContain(t.configDir)
  })

  test('a timestamped backup of the previous content is taken only when the config changes', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.write('.gitconfig', '[core]\n\teditor = vim\n')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()
    await core.apply()

    const backups = [...new Bun.Glob('*').scanSync(`${t.configDir}/backups`)]

    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^gitconfig-\d{4}-\d{2}-\d{2}T/)
    expect(await Bun.file(`${t.configDir}/backups/${backups[0]}`).text()).toBe(
      '[core]\n\teditor = vim\n',
    )
  })

  test('creates the home global config when none exists', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    await createCore({ home: t.home, env: t.env }).apply()
    expect(await Bun.file(t.path('.gitconfig')).exists()).toBe(true)
  })

  test('uses the XDG global config when the home file does not exist', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const xdgConfig = t.write('.config/git/config', '[core]\n\teditor = vim\n')
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).apply()

    expect(await Bun.file(t.path('.gitconfig')).exists()).toBe(false)
    expect(await Bun.file(xdgConfig).text()).toContain(t.configDir)
    expect(t.git(repo, 'config', 'user.email')).toBe('nico@personal.dev')
  })

  test('writes through a symlinked global config instead of replacing the link', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const target = t.write('dotfiles/gitconfig', '[core]\n\teditor = vim\n')

    symlinkSync(target, t.path('.gitconfig'))

    await createCore({ home: t.home, env: t.env }).apply()

    expect(lstatSync(t.path('.gitconfig')).isSymbolicLink()).toBe(true)
    expect(await Bun.file(target).text()).toContain(t.configDir)
  })

  test('keeps the include last so it overrides earlier identity settings', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.write('.gitconfig', '[user]\n\temail = old@example.com\n')
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).apply()

    expect(t.git(repo, 'config', 'user.email')).toBe('nico@personal.dev')
  })
})

describe('configuration directory', () => {
  test('respects XDG_CONFIG_HOME and expands it from a custom location', async () => {
    const customConfigHome = t.path('custom-config')
    const env = { ...t.env, XDG_CONFIG_HOME: customConfigHome }
    const identitiesFile = `${customConfigHome}/qcs/identities.toml`

    await Bun.write(identitiesFile, PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env }).apply()

    expect(
      Bun.spawnSync(['git', 'config', 'user.email'], { cwd: repo, env }).stdout.toString().trim(),
    ).toBe('nico@personal.dev')
  })
})

describe('resolve', () => {
  test('reports the Default Identity with its label and the default origin', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()

    const resolution = await core.resolve(repo)

    expect(resolution).toMatchObject({
      status: 'known',
      identity: {
        id: 'personal',
        label: 'Personal',
        name: 'Nico Personal',
        email: 'nico@personal.dev',
      },
      origin: 'default',
    })
  })

  test('resolves from a nested directory inside the repository', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')
    const nested = t.path('code/a/src/deep')

    await Bun.write(`${nested}/file.txt`, 'x')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()

    expect(await core.resolve(nested)).toMatchObject({ status: 'known', repository: repo })
  })

  test('reports an Unknown Identity when the email matches no Identity', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()
    t.git(repo, 'config', 'user.email', 'stranger@example.com')
    t.git(repo, 'config', 'user.name', 'Stranger')

    expect(await core.resolve(repo)).toMatchObject({
      status: 'unknown',
      name: 'Stranger',
      email: 'stranger@example.com',
      origin: 'external-rule',
    })
  })

  test('reports an External Rule when a matching email comes from config qcs does not manage', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()
    t.git(repo, 'config', 'user.email', 'nico@personal.dev')

    expect(await core.resolve(repo)).toMatchObject({
      status: 'known',
      identity: { id: 'personal' },
      origin: 'external-rule',
    })
  })

  test('reports an Unknown Identity with no email when nothing sets one', async () => {
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    expect(await core.resolve(repo)).toMatchObject({
      status: 'unknown',
      email: null,
      origin: 'none',
    })
  })

  test('reports that the directory is not inside a repository', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()

    const outside = t.path('somewhere')

    await Bun.write(`${outside}/note.txt`, 'x')

    expect(await core.resolve(outside)).toEqual({ status: 'not-a-repository', folderScope: null })
  })

  test('tells apart Identities sharing an email by the SSH key git uses', async () => {
    const github = t.write('.ssh/github', 'PRIVATE')
    const gitlab = t.write('.ssh/gitlab', 'PRIVATE')
    const repo = t.makeRepo('code/gl/lib')
    const core = createCore({ home: t.home, env: t.env })
    const author = { name: 'Nico', email: 'nico@personal.dev' }

    await core.createIdentity({ ...author, label: 'GitHub', sshKey: github })
    await core.createIdentity({ ...author, label: 'GitLab', sshKey: gitlab })
    await core.assignFolder(t.path('code/gl'), 'gitlab')

    expect(await core.resolve(repo)).toMatchObject({
      status: 'known',
      identity: { id: 'gitlab' },
      sshKey: 'used',
    })
  })

  test('flags GIT_SSH_COMMAND in the environment because it overrides core.sshCommand', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: { ...t.env, GIT_SSH_COMMAND: 'ssh -v' } })

    await core.apply()

    expect(await core.resolve(repo)).toMatchObject({ sshCommandOverriddenByEnvironment: true })
  })
})

describe('loading', () => {
  test('expands ~ in an attached SSH key path', () => {
    t.writeIdentities(`${PERSONAL_DEFAULT_IDENTITIES}ssh_key = "~/.ssh/id_personal"\n`)
    const [identity] = createCore({ home: t.home, env: t.env }).load().identities

    expect(identity?.sshKey).toBe(t.path('.ssh/id_personal'))
  })

  test('rejects an identity id that is not a safe file name', () => {
    t.writeIdentities('[identities."../escape"]\nname = "X"\nemail = "x@example.com"\n')
    expect(() => createCore({ home: t.home, env: t.env }).load()).toThrow(/\.\.\/escape/)
  })

  test('rejects a Default Identity that is not defined', () => {
    t.writeIdentities('default = "ghost"\n')
    expect(() => createCore({ home: t.home, env: t.env }).load()).toThrow(/ghost/)
  })
})

describe('Identities management', () => {
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    )

  const work = { label: 'Work', name: 'Nico Work', email: 'nico@work.dev' }

  test('creating Identities derives unique slug ids and persists them', async () => {
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(work)
    await core.createIdentity({ ...work, label: 'work!' })
    await core.createIdentity({ ...work, label: '  Work ' })

    expect(core.load().identities.map((identity) => identity.id)).toEqual([
      'work',
      'work-2',
      'work-3',
    ])
  })

  test('rejects an empty name and a malformed email', async () => {
    const core = createCore({ home: t.home, env: t.env })

    expect(await rejection(core.createIdentity({ ...work, name: '  ' }))).toContain('Name')
    expect(await rejection(core.createIdentity({ ...work, email: 'nope' }))).toContain(
      'valid email',
    )
    expect(core.load().identities).toEqual([])
  })

  test('editing and changing the Default Identity change what git reports', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(work)
    await core.editIdentity('personal', {
      label: 'Personal',
      name: 'Nico P',
      email: 'new@personal.dev',
    })
    expect(t.git(repo, 'config', 'user.email')).toBe('new@personal.dev')

    await core.setDefaultIdentity('work')
    expect(t.git(repo, 'config', 'user.email')).toBe('nico@work.dev')
    expect(core.load().defaultIdentityId).toBe('work')
  })

  test('editing never changes the id, even when the label changes', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const core = createCore({ home: t.home, env: t.env })

    await core.editIdentity('personal', { label: 'Home', name: 'Nico', email: 'nico@home.dev' })

    expect(core.load().identities).toMatchObject([{ id: 'personal', label: 'Home' }])
  })

  test('the first Identity becomes the Default Identity, later ones do not', async () => {
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(work)
    await core.createIdentity({ ...work, label: 'Other' })

    expect(core.load().defaultIdentityId).toBe('work')
  })

  test('deleting the Default Identity is blocked, any other one is removed', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(work)

    expect(await rejection(core.deleteIdentity('personal'))).toContain('Default Identity')
    await core.deleteIdentity('work')
    expect(core.load().identities.map((identity) => identity.id)).toEqual(['personal'])
  })

  test('keeps the SSH key and unrelated content of identities.toml', async () => {
    t.writeIdentities(
      `${PERSONAL_DEFAULT_IDENTITIES}ssh_key = "~/.ssh/personal"\n\n[remotes]\nfoo = "bar"\n`,
    )
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(work)

    const saved = await Bun.file(`${t.configDir}/identities.toml`).text()

    expect(saved).toContain('ssh_key = "~/.ssh/personal"')
    expect(saved).toContain('foo = "bar"')
    expect(core.load().identities[0]!.sshKey).toBe(`${t.home}/.ssh/personal`)
  })
})

describe('Scan Roots', () => {
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    )

  test('are stored in machine.toml with ~ paths and loaded back expanded', async () => {
    t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code', 3)

    expect(await Bun.file(`${t.configDir}/machine.toml`).text()).toContain('path = "~/code"')
    expect(core.loadScanRoots()).toEqual([
      { path: t.path('code'), displayPath: '~/code', maxDepth: 3 },
    ])
  })

  test('can be removed', async () => {
    t.makeRepo('code/a')
    t.makeRepo('work/b')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code', 3)
    await core.addScanRoot(t.path('work'), 2)
    await core.removeScanRoot(t.path('code'))

    expect(core.loadScanRoots()).toEqual([
      { path: t.path('work'), displayPath: '~/work', maxDepth: 2 },
    ])
  })

  test('reject missing directories, duplicates and invalid depths', async () => {
    t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    expect(await rejection(core.addScanRoot('~/nope', 3))).toContain('not a directory')
    expect(await rejection(core.addScanRoot('~/code', 0))).toContain('depth')
    expect(await rejection(core.addScanRoot('~/code', 1.5))).toContain('depth')
    expect(await rejection(core.addScanRoot('', 2))).toContain('Path')

    await core.addScanRoot('~/code', 2)

    expect(await rejection(core.addScanRoot('~/code/', 2))).toContain('already')
  })

  test('default to depth 4 and only store max_depth as an override', async () => {
    t.makeRepo('code/a')
    t.makeRepo('work/b')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code')
    await core.addScanRoot('~/work', 2)

    expect(core.loadScanRoots().map((root) => root.maxDepth)).toEqual([4, 2])
    expect(await Bun.file(`${t.configDir}/machine.toml`).text()).not.toContain('max_depth = 4')
  })

  test('keep the splash screen on unless machine.toml turns it off', async () => {
    t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code')
    expect(core.loadShowSplash()).toBe(true)

    await core.setShowSplash(false)
    expect(core.loadShowSplash()).toBe(false)
    expect(core.loadScanRoots()).toHaveLength(1)

    await core.setShowSplash(true)
    expect(await Bun.file(`${t.configDir}/machine.toml`).text()).not.toContain('splash')

    writeFileSync(join(t.configDir, 'machine.toml'), 'splash = "no"')
    expect(() => core.loadShowSplash()).toThrow('splash')
  })

  test('reject a hand-edited machine.toml with an invalid shape', () => {
    const core = createCore({ home: t.home, env: t.env })

    const load = (toml: string) => {
      mkdirSync(t.configDir, { recursive: true })
      writeFileSync(join(t.configDir, 'machine.toml'), toml)

      try {
        core.loadScanRoots()
      } catch (error) {
        return (error as Error).message
      }

      return null
    }

    expect(load('scan_roots = "~/code"')).toContain('array')
    expect(load('[[scan_roots]]\npath = "~/code"\nmax_depth = 0')).toContain('max_depth')
    expect(load('[[scan_roots]]\npath = "~/code"\nmax_depth = "3"')).toContain('max_depth')
    expect(load('[[scan_roots]]\npath = "~/code"')).toBeNull()
  })
})

describe('suggested Scan Roots', () => {
  const suggested = async () =>
    (await createCore({ home: t.home, env: t.env }).suggestScanRoots()).map((s) => s.displayPath)

  test('are the home folders holding repositories, skipping hidden, heavy, Library and repository folders', async () => {
    t.makeRepo('dev/alpha')
    t.makeRepo('work/team/beta')
    t.makeRepo('.hidden/gamma')
    t.makeRepo('node_modules/delta')
    t.makeRepo('Library/epsilon')
    t.makeRepo('standalone')
    t.write('empty/readme.md', '')
    t.makeRepo('deep/a/b/c/d/zeta')

    expect(await suggested()).toEqual(['~/dev', '~/work'])
  })

  test('leave out macOS folders behind privacy prompts only on macOS', async () => {
    t.makeRepo('Desktop/alpha')
    t.makeRepo('Documents/beta')
    t.makeRepo('Downloads/gamma')

    expect(await suggested()).toEqual(
      process.platform === 'darwin' ? [] : ['~/Desktop', '~/Documents', '~/Downloads'],
    )
  })

  test('leave out folders that contain or sit inside a Scan Root', async () => {
    t.makeRepo('dev/work/alpha')
    t.makeRepo('code/beta')
    t.makeRepo('lab/gamma')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/dev/work')
    await core.addScanRoot('~/code/')

    expect(await suggested()).toEqual(['~/lab'])
  })

  test('are added in a single save, skipping invalid and duplicate paths', async () => {
    t.makeRepo('dev/alpha')
    t.makeRepo('work/beta')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/dev')

    expect(await core.addScanRoots(['~/dev', '~/work', '~/work/', '~/nope'])).toBe(1)
    expect(core.loadScanRoots().map((root) => root.displayPath)).toEqual(['~/dev', '~/work'])
  })

  test('leave out folders that are already Scan Roots', async () => {
    t.makeRepo('dev/alpha')
    t.makeRepo('work/beta')
    await createCore({ home: t.home, env: t.env }).addScanRoot('~/dev')

    expect(await suggested()).toEqual(['~/work'])
  })
})

describe('scan', () => {
  const names = (nodes: { name: string }[]) => nodes.map((node) => node.name)

  test('reports folders and repositories, without descending into repositories or heavy directories', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/a')
    t.makeRepo('code/a/vendored-copy')
    t.makeRepo('code/group/b')
    t.makeRepo('code/node_modules/dep')
    t.write('code/docs-only/readme.md', 'no repositories in here')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()
    await core.addScanRoot('~/code', 3)

    const [result] = await core.scan()

    expect(result!.missing).toBe(false)
    expect(names(result!.children)).toEqual(['a', 'group'])
    expect(result!.children[0]).toMatchObject({ kind: 'repository', path: t.path('code/a') })
    expect(result!.children[1]).toMatchObject({ kind: 'folder', path: t.path('code/group') })
    expect(names((result!.children[1] as { children: { name: string }[] }).children)).toEqual(['b'])
  })

  test('respects the maximum depth', async () => {
    t.makeRepo('code/one')
    t.makeRepo('code/x/two')
    t.makeRepo('code/x/y/three')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code', 2)

    const [result] = await core.scan()

    const folder = result!.children.find((node) => node.name === 'x') as {
      children: { name: string }[]
    }

    expect(names(result!.children)).toEqual(['one', 'x'])
    expect(names(folder.children)).toEqual(['two'])
  })

  test('finds repositories whose .git is a file', async () => {
    const repo = t.path('code/linked')

    t.makeRepo('code/linked-seed')
    mkdirSync(repo, { recursive: true })
    mkdirSync(t.path('gitdirs'))
    t.git(repo, 'init', '--quiet', '--separate-git-dir', t.path('gitdirs/linked'))
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code', 2)

    const [result] = await core.scan()

    expect(names(result!.children)).toEqual(['linked', 'linked-seed'])
  })

  test('classifies each repository as Default Identity, External Rule or Unknown Identity', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/plain')
    const external = t.makeRepo('code/external')
    const stranger = t.makeRepo('code/stranger')

    t.git(external, 'config', 'user.email', 'nico@personal.dev')
    t.git(stranger, 'config', 'user.email', 'someone@else.dev')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()
    await core.addScanRoot('~/code', 2)

    const [result] = await core.scan()
    const byName = Object.fromEntries(result!.children.map((node) => [node.name, node]))

    expect(byName.plain).toMatchObject({
      classification: 'default-identity',
      identity: { id: 'personal' },
    })
    expect(byName.external).toMatchObject({
      classification: 'external-rule',
      identity: { id: 'personal' },
    })
    expect(byName.stranger).toMatchObject({
      classification: 'unknown-identity',
      identity: null,
      email: 'someone@else.dev',
    })
  })

  test('marks a repository git cannot read as unreadable', async () => {
    t.makeRepo('code/fine')
    mkdirSync(t.path('code/broken/.git'), { recursive: true })
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code', 2)

    const [result] = await core.scan()
    const byName = Object.fromEntries(result!.children.map((node) => [node.name, node]))

    expect(byName.broken).toMatchObject({ classification: 'unknown-identity', unreadable: true })
    expect(byName.fine).toMatchObject({ unreadable: false })
  })

  test('reports a Scan Root whose directory disappeared', async () => {
    t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/code', 2)
    rmSync(t.path('code'), { recursive: true })

    const [result] = await core.scan()

    expect(result).toMatchObject({ missing: true, children: [] })
  })
})

describe('Folder Scopes', () => {
  const identities = `${PERSONAL_DEFAULT_IDENTITIES}
[identities.work]
label = "Work"
name = "Nico Work"
email = "nico@work.dev"

[identities.client]
label = "Client"
name = "Nico Client"
email = "nico@client.dev"
`

  const email = (repo: string) => t.git(repo, 'config', 'user.email')

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    )

  test('every repository inside the folder, at any depth, uses the Identity', async () => {
    t.writeIdentities(identities)
    const shallow = t.makeRepo('work/a')
    const deep = t.makeRepo('work/teams/x/b')
    const outside = t.makeRepo('code/c')
    const core = createCore({ home: t.home, env: t.env })

    await core.assignFolder('~/work', 'work')

    expect(email(shallow)).toBe('nico@work.dev')
    expect(email(deep)).toBe('nico@work.dev')
    expect(email(outside)).toBe('nico@personal.dev')
    expect(await Bun.file(`${t.configDir}/machine.toml`).text()).toContain('path = "~/work"')
  })

  test('the deeper nested folder wins, and removing it falls back to the next Scope', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/client/app')
    const sibling = t.makeRepo('work/other')
    const core = createCore({ home: t.home, env: t.env })

    await core.assignFolder('~/work/client', 'client')
    await core.assignFolder('~/work', 'work')

    expect(email(repo)).toBe('nico@client.dev')
    expect(email(sibling)).toBe('nico@work.dev')

    await core.unassignFolder('~/work/client')
    expect(email(repo)).toBe('nico@work.dev')

    await core.unassignFolder('~/work')
    expect(email(repo)).toBe('nico@personal.dev')
    expect(core.loadFolderScopes()).toEqual([])
  })

  test('changing the Identity of an Assignment updates git immediately', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.assignFolder('~/work', 'work')
    await core.assignFolder('~/work', 'client')

    expect(email(repo)).toBe('nico@client.dev')
    expect(core.loadFolderScopes()).toMatchObject([{ displayPath: '~/work', identityId: 'client' }])
  })

  test('editing an Identity updates the repositories under its Folder Scopes', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.assignFolder('~/work', 'work')
    await core.editIdentity('work', { label: 'Work', name: 'Nico W', email: 'new@work.dev' })

    expect(email(repo)).toBe('new@work.dev')
  })

  test('handles folders whose names contain glob characters', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('clients/acme [prod]/a')
    const other = t.makeRepo('clients/acme p/b')
    const core = createCore({ home: t.home, env: t.env })

    await core.assignFolder('~/clients/acme [prod]', 'client')

    expect(email(repo)).toBe('nico@client.dev')
    expect(email(other)).toBe('nico@personal.dev')
  })

  test.if(isCaseInsensitiveFileSystem(import.meta.dir))(
    'matches the folder regardless of letter case on case-insensitive filesystems',
    async () => {
      t.writeIdentities(identities)
      const repo = t.makeRepo('Work/a')
      const core = createCore({ home: t.home, env: t.env })

      await core.assignFolder(t.path('work'), 'work')

      expect(email(repo)).toBe('nico@work.dev')
    },
  )

  test('uses the case-insensitive gitdir keyword only when asked, and escapes the folder', () => {
    expect(gitdirCondition(false, '/home/me/work')).toBe('gitdir:/home/me/work/')
    expect(gitdirCondition(true, '/home/me/work')).toBe('gitdir/i:/home/me/work/')
    expect(gitdirCondition(false, '/home/me/a [b]')).toBe(String.raw`gitdir:/home/me/a \\[b]/`)
  })

  test('the preview skips a linked worktree whose git directory is outside the folder', async () => {
    t.writeIdentities(identities)
    const main = t.makeRepo('code/main')
    const regular = t.makeRepo('work/regular')
    const core = createCore({ home: t.home, env: t.env })

    await core.apply()
    t.git(main, 'commit', '--allow-empty', '-m', 'init')
    t.git(main, 'worktree', 'add', join(t.home, 'work', 'linked'), '-b', 'linked')
    await core.addScanRoot('~/work', 2)

    const changes = await core.previewFolderAssignment('~/work', 'work')

    expect(changes.map((change) => change.path)).toEqual([regular])
  })

  test('applies to a folder reached through a symlink', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('volume/work/a')
    const core = createCore({ home: t.home, env: t.env })

    symlinkSync(t.path('volume/work'), t.path('work'))
    await core.addScanRoot('~/work', 2)
    await core.apply()

    expect((await core.previewFolderAssignment('~/work', 'work')).map((c) => c.name)).toEqual(['a'])

    await core.assignFolder('~/work', 'work')

    expect(email(repo)).toBe('nico@work.dev')
    expect(email(t.path('work/a'))).toBe('nico@work.dev')
  })

  test('rejects unknown Identities and folders that do not exist', async () => {
    t.writeIdentities(identities)
    t.makeRepo('work/a')
    const core = createCore({ home: t.home, env: t.env })

    expect(await rejection(core.assignFolder('~/work', 'nobody'))).toContain('does not exist')
    expect(await rejection(core.assignFolder('~/nowhere', 'work'))).toContain('not a directory')
    expect(core.loadFolderScopes()).toEqual([])
  })

  test('previews the repositories that would change, without touching git', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')
    const nested = t.makeRepo('work/client/b')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/work', 3)
    await core.assignFolder('~/work/client', 'client')

    const changes = await core.previewFolderAssignment('~/work', 'work')

    expect(changes).toMatchObject([
      { path: repo, current: { id: 'personal' }, resulting: { id: 'work' } },
    ])
    expect(email(repo)).toBe('nico@personal.dev')
    expect(email(nested)).toBe('nico@client.dev')

    const removal = await core.previewFolderAssignment('~/work/client', null)

    expect(removal).toMatchObject([
      { path: nested, current: { id: 'client' }, resulting: { id: 'personal' } },
    ])
  })

  test('the scan and resolve report the Folder Scope as the origin', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.addScanRoot('~/work', 2)
    await core.assignFolder('~/work', 'work')

    expect(await core.resolve(repo)).toMatchObject({
      status: 'known',
      identity: { id: 'work' },
      origin: 'folder-scope',
    })

    const [result] = await core.scan()

    expect(result!.children).toMatchObject([{ name: 'a', classification: 'folder-scope' }])
  })

  test('deleting an Identity with Assignments is blocked and lists them, unless they are removed too', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.assignFolder('~/work', 'work')

    expect(await rejection(core.deleteIdentity('work'))).toContain('~/work')
    expect(core.load().identities.map((identity) => identity.id)).toContain('work')

    await core.deleteIdentity('work', { removeAssignments: true })

    expect(core.loadFolderScopes()).toEqual([])
    expect(email(repo)).toBe('nico@personal.dev')
  })

  test('ignores a scope whose Identity no longer exists instead of blocking every change', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')

    mkdirSync(t.configDir, { recursive: true })
    writeFileSync(
      `${t.configDir}/machine.toml`,
      '[[folder_scopes]]\npath = "~/work"\nidentity = "ghost"\n',
    )
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ label: 'Other', name: 'Other', email: 'other@dev.io' })

    expect(email(repo)).toBe('nico@personal.dev')
  })

  test('treats a hand-written path with a trailing slash as the same folder', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')

    mkdirSync(t.configDir, { recursive: true })
    writeFileSync(
      `${t.configDir}/machine.toml`,
      '[[folder_scopes]]\npath = "~/work/"\nidentity = "work"\n',
    )
    const core = createCore({ home: t.home, env: t.env })

    await core.assignFolder('~/work', 'client')

    expect(core.loadFolderScopes()).toMatchObject([{ identityId: 'client' }])
    expect(email(repo)).toBe('nico@client.dev')
  })

  test('previews repositories with no author configured when there is no Default Identity', async () => {
    const repo = t.makeRepo('work/a')
    const core = createCore({ home: t.home, env: t.env })

    t.writeIdentities(
      '[identities.work]\nlabel = "Work"\nname = "Nico Work"\nemail = "nico@work.dev"\n',
    )
    await core.addScanRoot('~/work', 2)

    expect(await core.previewFolderAssignment('~/work', 'work')).toMatchObject([
      { path: repo, current: null, resulting: { id: 'work' } },
    ])
  })
})

describe('import of existing configuration', () => {
  const core = () => createCore({ home: t.home, env: t.env })

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    )

  function writeDeveloperSetup() {
    t.write(
      '.gitconfig',
      [
        '[core]',
        '\teditor = vim',
        '[user]',
        '\tname = Nico Personal',
        '\temail = nico@personal.dev',
        '\tsigningkey = ABC123',
        '[includeIf "gitdir:~/work/"]',
        '\tpath = ~/.gitconfig-work',
        '[includeIf "gitdir:~/work/oss/"]',
        '\tpath = ~/.gitconfig-oss',
        '',
      ].join('\n'),
    )
    t.write('.gitconfig-work', '[user]\n\tname = Nico Work\n\temail = nico@work.dev\n')
    t.write('.gitconfig-oss', '[user]\n\tname = Nico Personal\n\temail = nico@personal.dev\n')

    return ['code/a', 'work/b', 'work/client/c', 'work/oss/d'].map((path) => t.makeRepo(path))
  }

  const authorOf = (repo: string) =>
    `${t.git(repo, 'config', 'user.name')} <${t.git(repo, 'config', 'user.email')}>`

  test('every repository resolves to the same author before and after, and imported blocks are gone', async () => {
    const repos = writeDeveloperSetup()
    const before = repos.map(authorOf)

    await core().importConfiguration()

    expect(repos.map(authorOf)).toEqual(before)
    expect(before).toEqual([
      'Nico Personal <nico@personal.dev>',
      'Nico Work <nico@work.dev>',
      'Nico Work <nico@work.dev>',
      'Nico Personal <nico@personal.dev>',
    ])

    const { identities, defaultIdentityId } = core().load()

    expect(identities.map((identity) => identity.email)).toEqual([
      'nico@personal.dev',
      'nico@work.dev',
    ])
    expect(defaultIdentityId).toBe(identities[0]!.id)
    expect(
      core()
        .loadFolderScopes()
        .map((scope) => scope.displayPath),
    ).toEqual(['~/work', '~/work/oss'])

    const content = await Bun.file(t.path('.gitconfig')).text()

    expect(content).not.toContain('includeIf')
    expect(content).not.toContain('nico@personal.dev')
    expect(content).toContain('editor = vim')
    expect(content).toContain('signingkey = ABC123')
    expect(t.git(repos[1]!, 'config', '--show-origin', 'user.email')).toContain(t.configDir)
  })

  test('the preview lists everything and changes nothing; the import takes a backup first', async () => {
    writeDeveloperSetup()
    const original = await Bun.file(t.path('.gitconfig')).text()
    const plan = await core().previewImport({ firstRunOnly: true })

    expect(plan?.defaultIdentity).toEqual({ name: 'Nico Personal', email: 'nico@personal.dev' })
    expect(plan?.folders.map((folder) => folder.displayPath)).toEqual(['~/work', '~/work/oss'])
    expect(await Bun.file(t.path('.gitconfig')).text()).toBe(original)
    expect(await Bun.file(`${t.configDir}/identities.toml`).exists()).toBe(false)

    const { backupPath } = await core().importConfiguration()

    expect(await Bun.file(backupPath!).text()).toBe(original)
    expect(await core().previewImport()).toBeNull()
  })

  test('the first run offer needs an empty qcs configuration', async () => {
    writeDeveloperSetup()
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)

    expect(await core().previewImport({ firstRunOnly: true })).toBeNull()
    expect(await core().previewImport()).not.toBeNull()
  })

  test('imports `/**` folder rules whose files set only the email, keeping the global name', async () => {
    t.write(
      '.gitconfig',
      [
        '[user]',
        '\tname = Nico Personal',
        '\temail = nico@personal.dev',
        '[includeIf "gitdir:~/work/**"]',
        '\tpath = ~/work/.gitconfig',
        '[includeIf "gitdir:~/work/oss/**"]',
        '\tpath = ~/work/oss/.gitconfig',
        '',
      ].join('\n'),
    )
    t.write('work/.gitconfig', '[user]\n\temail = nico@work.dev\n')
    t.write('work/oss/.gitconfig', '[user]\n\temail = nico@oss.dev\n')

    const repos = ['code/a', 'work/b', 'work/oss/c'].map((path) => t.makeRepo(path))
    const before = repos.map(authorOf)

    await core().importConfiguration()

    expect(repos.map(authorOf)).toEqual(before)
    expect(before).toEqual([
      'Nico Personal <nico@personal.dev>',
      'Nico Personal <nico@work.dev>',
      'Nico Personal <nico@oss.dev>',
    ])
    expect(
      core()
        .loadFolderScopes()
        .map((scope) => scope.displayPath),
    ).toEqual(['~/work', '~/work/oss'])
    expect(await Bun.file(t.path('.gitconfig')).text()).not.toContain('includeIf')
  })

  test('rules it cannot import stay untouched and keep resolving as External Rules', async () => {
    t.write(
      '.gitconfig',
      [
        '[user]',
        '\tname = Nico Personal',
        '\temail = nico@personal.dev',
        '[includeIf "gitdir:~/glob/*/"]',
        '\tpath = ~/.gitconfig-glob',
        '[includeIf "gitdir:~/first/"]',
        '\tpath = ~/.gitconfig-first',
        '[includeIf "gitdir:~/second/"]',
        '\tpath = ~/.gitconfig-second',
        '[includeIf "gitdir:~/ssh/"]',
        '\tpath = ~/.gitconfig-ssh',
        '',
      ].join('\n'),
    )
    t.write('.gitconfig-glob', '[user]\n\tname = Glob\n\temail = glob@x.dev\n')
    t.write('.gitconfig-first', '[user]\n\tname = First\n\temail = same@x.dev\n')
    t.write('.gitconfig-second', '[user]\n\tname = Second\n\temail = same@x.dev\n')
    t.write(
      '.gitconfig-ssh',
      '[user]\n\tname = Nico Ssh\n\temail = ssh@x.dev\n[core]\n\tsshCommand = ssh -i key\n',
    )

    const repos = ['glob/x/a', 'first/b', 'second/c', 'ssh/d'].map((path) => t.makeRepo(path))
    const before = repos.map(authorOf)

    await core().importConfiguration()

    expect(repos.map(authorOf)).toEqual(before)

    const content = await Bun.file(t.path('.gitconfig')).text()

    expect(content).toContain('gitdir:~/glob/*/')
    expect(content).not.toContain('gitdir:~/first/')
    expect(content).toContain('gitdir:~/second/')
    expect(content).toContain('gitdir:~/ssh/')
    expect(await core().resolve(repos[0]!)).toMatchObject({ origin: 'external-rule' })
    expect(
      core()
        .loadFolderScopes()
        .map((scope) => scope.displayPath),
    ).toEqual(['~/first', '~/ssh'])
  })

  test('a folder listed before a rule it cannot import is left alone, so the later rule keeps winning', async () => {
    t.write(
      '.gitconfig',
      [
        '[includeIf "gitdir:~/work/"]',
        '\tpath = ~/.gitconfig-a',
        '[includeIf "gitdir:~/work/cl*/"]',
        '\tpath = ~/.gitconfig-b',
        '',
      ].join('\n'),
    )
    t.write('.gitconfig-a', '[user]\n\tname = A\n\temail = a@x.dev\n')
    t.write('.gitconfig-b', '[user]\n\tname = B\n\temail = b@x.dev\n')

    const repo = t.makeRepo('work/client/repo')
    const before = authorOf(repo)

    expect(await core().previewImport()).toBeNull()
    expect(await rejection(core().importConfiguration())).toContain('nothing to import')
    expect(authorOf(repo)).toEqual(before)
  })

  test('a failed import leaves qcs as it was, so it can be retried', async () => {
    writeDeveloperSetup()
    await Bun.write(`${t.configDir}/backups`, 'not a directory')

    expect(await rejection(core().importConfiguration())).not.toBeNull()
    expect(core().load().identities).toEqual([])
    expect(core().loadFolderScopes()).toEqual([])

    await Bun.$`rm ${t.configDir}/backups`
    await core().importConfiguration()
    expect(core().loadFolderScopes()).not.toEqual([])
  })

  test('rejects when there is nothing to import', async () => {
    t.write('.gitconfig', '[core]\n\teditor = vim\n')
    expect(await rejection(core().importConfiguration())).toContain('nothing to import')
  })
})

describe('Repo Scopes', () => {
  const identities = `${PERSONAL_DEFAULT_IDENTITIES}
[identities.work]
label = "Work"
name = "Nico Work"
email = "nico@work.dev"

[identities.client]
label = "Client"
name = "Nico Client"
email = "nico@client.dev"
`

  const email = (repo: string) => t.git(repo, 'config', 'user.email')
  const core = () => createCore({ home: t.home, env: t.env })

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    )

  const commit = (repo: string) =>
    t.git(
      repo,
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x.io',
      'commit',
      '--allow-empty',
      '-m',
      'x',
    )

  test('overrides the Folder Scope for that repository only, and removing it falls back', async () => {
    t.writeIdentities(identities)
    const exception = t.makeRepo('work/a')
    const sibling = t.makeRepo('work/b')

    await core().assignFolder('~/work', 'work')
    await core().assignRepository(exception, 'client')

    expect(email(exception)).toBe('nico@client.dev')
    expect(email(sibling)).toBe('nico@work.dev')
    expect(await Bun.file(`${t.configDir}/machine.toml`).text()).toContain('[[repo_scopes]]')

    await core().unassignRepository(exception)

    expect(email(exception)).toBe('nico@work.dev')
    expect(core().loadRepoScopes()).toEqual([])
    expect(core().loadFolderScopes()).toHaveLength(1)
  })

  test('assigning again replaces the Identity of the Repo Scope', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('code/a')

    await core().assignRepository(repo, 'work')
    await core().assignRepository(repo, 'client')

    expect(core().loadRepoScopes()).toMatchObject([{ identityId: 'client' }])
    expect(email(repo)).toBe('nico@client.dev')
  })

  test('assigning through a symlink replaces the Repo Scope of the real path', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('volume/a')

    symlinkSync(t.path('volume'), t.path('code'))

    await core().assignRepository(repo, 'work')
    await core().assignRepository(t.path('code/a'), 'client')

    expect(core().loadRepoScopes()).toMatchObject([{ identityId: 'client' }])
    expect(email(repo)).toBe('nico@client.dev')
  })

  test('linked worktrees outside the repository and submodules follow its Repo Scope', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('code/main')
    const library = t.makeRepo('elsewhere/library')

    commit(library)
    commit(repo)
    t.git(repo, 'worktree', 'add', t.path('trees/feature'))
    t.git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'lib')

    await core().assignRepository(repo, 'work')

    expect(email(t.path('trees/feature'))).toBe('nico@work.dev')
    expect(email(join(repo, 'lib'))).toBe('nico@work.dev')
    expect(email(library)).toBe('nico@personal.dev')
  })

  test('a Repo Scope wins over a Folder Scope assigned later', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('work/a')

    await core().assignRepository(repo, 'client')
    await core().assignFolder('~/work', 'work')

    expect(email(repo)).toBe('nico@client.dev')
  })

  test('rejects unknown Identities, listing the valid ones, and folders that are not repositories', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('code/a')

    mkdirSync(t.path('code/plain'))

    const unknown = await rejection(core().assignRepository(repo, 'nobody'))

    expect(unknown).toContain('does not exist')
    expect(unknown).toContain('personal, work, client')
    expect(await rejection(core().assignRepository(t.path('code/plain'), 'work'))).toContain(
      'not a git repository',
    )
    expect(core().loadRepoScopes()).toEqual([])
  })

  test('the scan and resolve report the Repo Scope as the origin', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('code/a')

    await core().addScanRoot('~/code', 2)
    await core().assignRepository(repo, 'work')

    expect(await core().resolve(repo)).toMatchObject({
      status: 'known',
      identity: { id: 'work' },
      origin: 'repo-scope',
    })

    const [result] = await core().scan()

    expect(result!.children).toMatchObject([{ name: 'a', classification: 'repo-scope' }])
  })

  test('never writes to the repository-local git config', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('code/a')
    const before = await Bun.file(`${repo}/.git/config`).text()

    await core().assignRepository(repo, 'work')

    expect(await Bun.file(`${repo}/.git/config`).text()).toBe(before)
  })

  test('deleting an Identity with a Repo Scope is blocked unless the Assignment is removed too', async () => {
    t.writeIdentities(identities)
    const repo = t.makeRepo('code/a')

    await core().assignRepository(repo, 'work')

    expect(await rejection(core().deleteIdentity('work'))).toContain('~/code/a')

    await core().deleteIdentity('work', { removeAssignments: true })

    expect(core().loadRepoScopes()).toEqual([])
    expect(email(repo)).toBe('nico@personal.dev')
  })

  test('a Folder Scope preview leaves repositories with a Repo Scope out', async () => {
    t.writeIdentities(identities)
    const exception = t.makeRepo('work/a')

    t.makeRepo('work/b')
    await core().addScanRoot('~/work', 2)
    await core().assignRepository(exception, 'client')

    const changes = await core().previewFolderAssignment('~/work', 'work')

    expect(changes.map((change) => change.name)).toEqual(['b'])
  })
})

describe('Remote Scopes', () => {
  const identities = `${PERSONAL_DEFAULT_IDENTITIES}
[identities.work]
label = "Work"
name = "Nico Work"
email = "nico@work.dev"

[identities.client]
label = "Client"
name = "Nico Client"
email = "nico@client.dev"
`

  const email = (repo: string) => t.git(repo, 'config', 'user.email')
  const core = () => createCore({ home: t.home, env: t.env })

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    )

  const makeRepoWithRemote = (relativePath: string, url: string) => {
    const repo = t.makeRepo(relativePath)

    t.git(repo, 'remote', 'add', 'origin', url)

    return repo
  }

  const coreWithGitVersion = (version: string) => {
    const bin = t.path('fake-bin')

    mkdirSync(bin, { recursive: true })
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\n[ "$1" = "--version" ] && echo "git version ${version}" && exit 0\nexec ${Bun.which('git')} "$@"\n`,
      { mode: 0o755 },
    )

    return createCore({ home: t.home, env: { ...t.env, PATH: `${bin}:${t.env.PATH}` } })
  }

  test('applies to every repository with a matching remote, wherever it lives', async () => {
    t.writeIdentities(identities)
    const inside = makeRepoWithRemote('code/a', 'git@github.com:acme/a.git')
    const nested = makeRepoWithRemote('elsewhere/deep/b', 'git@github.com:acme/team/b.git')
    const other = makeRepoWithRemote('code/c', 'git@github.com:other/c.git')

    await core().assignRemote('git@github.com:acme/**', 'work')

    expect(email(inside)).toBe('nico@work.dev')
    expect(email(nested)).toBe('nico@work.dev')
    expect(email(other)).toBe('nico@personal.dev')
  })

  test('is stored in identities.toml and survives other identity changes', async () => {
    t.writeIdentities(identities)
    await core().assignRemote('git@github.com:acme/**', 'work')
    await core().createIdentity({ label: 'Extra', name: 'E', email: 'e@e.io' })

    const content = await Bun.file(`${t.configDir}/identities.toml`).text()

    expect(content).toContain('[[remote_scopes]]')
    expect(core().loadRemoteScopes()).toEqual([
      { pattern: 'git@github.com:acme/**', identityId: 'work' },
    ])
    expect(await Bun.file(`${t.configDir}/machine.toml`).exists()).toBe(false)
  })

  test('assigning the same pattern again replaces it, and unassigning falls back', async () => {
    t.writeIdentities(identities)
    const repo = makeRepoWithRemote('code/a', 'git@github.com:acme/a.git')

    await core().assignRemote('git@github.com:acme/**', 'work')
    await core().assignRemote('git@github.com:acme/**', 'client')

    expect(core().loadRemoteScopes()).toHaveLength(1)
    expect(email(repo)).toBe('nico@client.dev')

    await core().unassignRemote('git@github.com:acme/**')

    expect(core().loadRemoteScopes()).toEqual([])
    expect(email(repo)).toBe('nico@personal.dev')
  })

  test('precedence is Repo Scope, then Remote Scope, then Folder Scope, then Default Identity', async () => {
    t.writeIdentities(identities)
    const origin = t.makeRepo('origin')

    t.git(
      origin,
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x.io',
      'commit',
      '--allow-empty',
      '-m',
      'x',
    )
    t.git(t.home, 'clone', '--quiet', origin, t.path('work/a'))
    const repo = t.path('work/a')

    await core().apply()
    expect(email(repo)).toBe('nico@personal.dev')

    await core().assignFolder('~/work', 'work')
    expect(email(repo)).toBe('nico@work.dev')

    await core().assignRemote(origin, 'client')
    expect(email(repo)).toBe('nico@client.dev')

    await core().assignFolder('~/work', 'personal')
    expect(email(repo)).toBe('nico@client.dev')

    await core().assignRepository(repo, 'work')
    expect(email(repo)).toBe('nico@work.dev')

    await core().unassignRepository(repo)
    await core().unassignRemote(origin)
    expect(email(repo)).toBe('nico@personal.dev')
  })

  test('a repository cloned outside every Folder Scope resolves to the Remote Scope', async () => {
    t.writeIdentities(identities)
    const origin = makeRepoWithRemote('origin', 'git@github.com:acme/a.git')

    t.git(
      origin,
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x.io',
      'commit',
      '--allow-empty',
      '-m',
      'x',
    )
    mkdirSync(t.path('work'))
    await core().assignFolder('~/work', 'work')
    await core().assignRemote(origin, 'client')
    t.git(t.home, 'clone', '--quiet', origin, t.path('anywhere/clone'))

    expect(email(t.path('anywhere/clone'))).toBe('nico@client.dev')
  })

  test('the scan and resolve report the Remote Scope as the origin', async () => {
    t.writeIdentities(identities)
    const repo = makeRepoWithRemote('code/a', 'git@github.com:acme/a.git')

    await core().addScanRoot('~/code', 2)
    await core().assignRemote('git@github.com:acme/**', 'work')

    expect(await core().resolve(repo)).toMatchObject({
      status: 'known',
      identity: { id: 'work' },
      origin: 'remote-scope',
    })

    const [result] = await core().scan()

    expect(result!.children).toMatchObject([{ name: 'a', classification: 'remote-scope' }])
  })

  test('suggests a pattern covering the owner for SSH, scp-like and HTTPS remotes', async () => {
    const suggest = (url: string) =>
      core().suggestRemotePattern(makeRepoWithRemote(`code/${Bun.hash(url)}`, url))

    expect(await suggest('git@github.com:acme/repo.git')).toBe('git@github.com:acme/**')
    expect(await suggest('ssh://git@host.io:2222/acme/team/repo.git')).toBe(
      'ssh://git@host.io:2222/acme/**',
    )
    expect(await suggest('https://github.com/acme/repo')).toBe('https://github.com/acme/**')
    expect(await suggest('git@host.io:repo.git')).toBe('git@host.io:repo.git')
    expect(await suggest('https://nico:ghp_secret@github.com/acme/repo.git')).toBe(
      'https://*@github.com/acme/**',
    )
  })

  test('suggesting a pattern fails for a repository without a remote', async () => {
    const repo = t.makeRepo('code/a')

    expect(await rejection(core().suggestRemotePattern(repo))).toContain('no remote')
  })

  test('rejects an unknown Identity and an empty pattern', async () => {
    t.writeIdentities(identities)

    expect(await rejection(core().assignRemote('git@github.com:acme/**', 'nobody'))).toContain(
      'personal, work, client',
    )
    expect(await rejection(core().assignRemote('  ', 'work'))).toContain('Pattern')
    expect(core().loadRemoteScopes()).toEqual([])
    expect(await rejection(core().unassignRemote('git@github.com:none/**'))).toContain(
      'not a Remote Scope',
    )
  })

  test('deleting an Identity with a Remote Scope is blocked unless the Assignment is removed too', async () => {
    t.writeIdentities(identities)
    const repo = makeRepoWithRemote('code/a', 'git@github.com:acme/a.git')

    await core().assignRemote('git@github.com:acme/**', 'work')

    expect(await rejection(core().deleteIdentity('work'))).toContain('git@github.com:acme/**')

    await core().deleteIdentity('work', { removeAssignments: true })

    expect(core().loadRemoteScopes()).toEqual([])
    expect(email(repo)).toBe('nico@personal.dev')
  })

  test('a Folder Scope preview leaves repositories with a Remote Scope out', async () => {
    t.writeIdentities(identities)
    makeRepoWithRemote('work/a', 'git@github.com:acme/a.git')
    makeRepoWithRemote('work/b', 'git@github.com:other/b.git')
    await core().addScanRoot('~/work', 2)
    await core().assignRemote('git@github.com:acme/**', 'client')

    const changes = await core().previewFolderAssignment('~/work', 'work')

    expect(changes.map((change) => change.name)).toEqual(['b'])
  })

  test('with git older than 2.36 they are reported unavailable, refused and not emitted', async () => {
    t.writeIdentities(identities)
    const repo = makeRepoWithRemote('code/a', 'git@github.com:acme/a.git')

    await core().assignRemote('git@github.com:acme/**', 'work')
    expect(await core().remoteScopesUnavailable()).toBeNull()

    const old = coreWithGitVersion('2.35.9')

    expect(await old.remoteScopesUnavailable()).toContain('2.36')
    expect(await rejection(old.assignRemote('git@github.com:other/**', 'client'))).toContain('2.36')

    await old.apply()

    expect(await Bun.file(`${t.configDir}/generated/managed.gitconfig`).text()).not.toContain(
      'hasconfig',
    )
    expect(email(repo)).toBe('nico@personal.dev')
    expect(old.loadRemoteScopes()).toHaveLength(1)

    await core().apply()
    expect(email(repo)).toBe('nico@work.dev')
  })

  test('treats git 2.36 and newer versions as supported', async () => {
    expect(await coreWithGitVersion('2.36.0').remoteScopesUnavailable()).toBeNull()
    expect(await coreWithGitVersion('3.0.1 (Apple Git-154)').remoteScopesUnavailable()).toBeNull()
  })
})

describe('SSH keys', () => {
  const work = { label: 'Work', name: 'Nico Work', email: 'nico@work.dev' }

  const writeKey = (name: string, withPublic = true) => {
    const key = t.write(`.ssh/${name}`, 'PRIVATE')

    if (withPublic) t.write(`.ssh/${name}.pub`, 'ssh-ed25519 AAAA')

    return key
  }

  test('lists only private keys that have a matching public key', () => {
    const key = writeKey('id_work')

    writeKey('orphan', false)
    t.write('.ssh/known_hosts', 'x')
    t.write('.ssh/lonely.pub', 'ssh-ed25519 AAAA')
    t.write('.ssh/dangling.pub', 'ssh-ed25519 AAAA')
    symlinkSync(t.path('.ssh/gone'), t.path('.ssh/dangling'))

    expect(createCore({ home: t.home, env: t.env }).listSshKeys()).toEqual([key])
  })

  test('lists nothing without an SSH directory', () => {
    expect(createCore({ home: t.home, env: t.env }).listSshKeys()).toEqual([])
  })

  test('git uses only the attached key, stored with ~ and never copied', async () => {
    const key = writeKey('id_work')
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, sshKey: key })

    expect(t.git(repo, 'config', 'core.sshCommand')).toBe(`ssh -i '${key}' -o IdentitiesOnly=yes`)
    expect(await Bun.file(`${t.configDir}/identities.toml`).text()).toContain(
      'ssh_key = "~/.ssh/id_work"',
    )
  })

  test('quotes a key path with spaces and quotes', async () => {
    const key = writeKey("my key's")
    const repo = t.makeRepo('code/a')

    await createCore({ home: t.home, env: t.env }).createIdentity({ ...work, sshKey: key })

    expect(t.git(repo, 'config', 'core.sshCommand')).toBe(
      `ssh -i '${key.replaceAll("'", String.raw`'\''`)}' -o IdentitiesOnly=yes`,
    )
  })

  test('without the key file git reports no core.sshCommand and the Identity is flagged', async () => {
    const key = writeKey('id_work')
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, sshKey: key })
    rmSync(key)
    await core.apply()

    expect(
      Bun.spawnSync(['git', 'config', 'core.sshCommand'], { cwd: repo, env: t.env }).exitCode,
    ).toBe(1)
    expect(core.missingSshKeys()).toEqual(['work'])
    expect(await core.resolve(repo)).toMatchObject({ status: 'known', sshKey: 'missing' })
  })

  test('editing attaches, keeps and clears the key', async () => {
    const key = writeKey('id_work')
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(work)
    expect(await core.resolve(repo)).toMatchObject({ sshKey: 'none' })

    await core.editIdentity('work', { ...work, sshKey: key })
    expect(await core.resolve(repo)).toMatchObject({ sshKey: 'used' })

    await core.editIdentity('work', { ...work, name: 'Nico W' })
    expect(core.load().identities[0]!.sshKey).toBe(key)

    await core.editIdentity('work', { ...work, sshKey: null })
    expect(core.load().identities[0]!.sshKey).toBeNull()
    expect(await core.resolve(repo)).toMatchObject({ sshKey: 'none' })
  })

  test('the Repos tree reports the key status of each repository', async () => {
    const key = writeKey('id_work')

    t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, sshKey: key })
    await core.addScanRoot(t.path('code'))
    const [root] = await core.scan()

    expect(root!.children).toMatchObject([{ name: 'a', sshKey: 'used' }])
    rmSync(key)
    expect((await core.scan())[0]!.children).toMatchObject([{ sshKey: 'stale' }])

    await core.apply()
    expect((await core.scan())[0]!.children).toMatchObject([{ sshKey: 'missing' }])
  })

  test('deletes an unused key with its public key, never one an Identity uses', async () => {
    const used = writeKey('id_work')
    const unused = writeKey('id_old')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, sshKey: used })

    expect(await core.deleteSshKey(used).catch((error: Error) => error.message)).toContain(
      '"Work" uses ~/.ssh/id_work',
    )
    expect(
      await core.deleteSshKey(t.path('.ssh/config')).catch((error: Error) => error.message),
    ).toContain('is not an SSH key')

    await core.deleteSshKey(unused)

    expect(core.listSshKeys()).toEqual([used])
    expect(await Bun.file(`${unused}.pub`).exists()).toBe(false)
  })

  test('signing with the SSH key makes git sign and trust that key', async () => {
    const key = writeKey('id_work')
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, sshKey: key, signingKey: SIGN_WITH_SSH_KEY })

    expect(t.git(repo, 'config', 'user.signingkey')).toBe(key)
    expect(t.git(repo, 'config', 'gpg.format')).toBe('ssh')
    expect(t.git(repo, 'config', 'commit.gpgsign')).toBe('true')
    expect(t.git(repo, 'config', 'tag.gpgsign')).toBe('true')
    expect(await Bun.file(t.git(repo, 'config', 'gpg.ssh.allowedSignersFile')).text()).toBe(
      'nico@work.dev namespaces="git" ssh-ed25519 AAAA\n',
    )
    expect(await Bun.file(`${t.configDir}/identities.toml`).text()).toContain(
      'signing_key = "ssh_key"',
    )
    expect(await core.resolve(repo)).toMatchObject({ signingKey: 'used' })

    await core.editIdentity('work', { ...work, sshKey: null })

    expect(core.load().identities[0]!.signingKey).toBe(SIGN_WITH_SSH_KEY)
    expect(await core.resolve(repo)).toMatchObject({ signingKey: 'none' })
    expect(
      Bun.spawnSync(['git', 'config', 'commit.gpgsign'], { cwd: repo, env: t.env }).exitCode,
    ).toBe(1)
  })

  test('a dedicated signing key that goes missing stops signing and is flagged', async () => {
    const key = writeKey('id_work')
    const signing = writeKey('id_work_signing')
    const repo = t.makeRepo('code/a')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, sshKey: key, signingKey: signing })

    expect(t.git(repo, 'config', 'user.signingkey')).toBe(signing)
    expect(await Bun.file(`${t.configDir}/identities.toml`).text()).toContain(
      'signing_key = "~/.ssh/id_work_signing"',
    )

    rmSync(signing)
    expect(await core.resolve(repo)).toMatchObject({ signingKey: 'stale' })

    await core.apply()

    expect(core.missingSigningKeys()).toEqual(['work'])
    expect(core.missingSshKeys()).toEqual([])
    expect(await core.resolve(repo)).toMatchObject({ signingKey: 'missing' })
    expect(
      Bun.spawnSync(['git', 'config', 'commit.gpgsign'], { cwd: repo, env: t.env }).exitCode,
    ).toBe(1)
    expect(await Bun.file(`${t.configDir}/generated/allowed_signers`).exists()).toBe(false)
  })

  test('never deletes a key an Identity signs with', async () => {
    const signing = writeKey('id_work_signing')
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity({ ...work, signingKey: signing })

    expect(await core.deleteSshKey(signing).catch((error: Error) => error.message)).toContain(
      '"Work" uses ~/.ssh/id_work_signing',
    )
    expect(core.listSshKeys()).toEqual([signing])
  })

  describe('generation and clipboard', () => {
    const rejection = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: Error) => error.message,
      )

    const CLIPBOARD_COMMAND = process.platform === 'darwin' ? 'pbcopy' : 'wl-copy'

    const clipboardEnv = (script: string | null) => {
      const bin = t.path('bin')

      mkdirSync(bin, { recursive: true })

      if (script !== null) {
        writeFileSync(join(bin, CLIPBOARD_COMMAND), `#!/bin/sh\n${script}\n`)
        chmodSync(join(bin, CLIPBOARD_COMMAND), 0o755)
      }

      return { ...t.env, PATH: script === null ? bin : `${bin}:/bin:/usr/bin` }
    }

    test('generates an ed25519 key named after the Identity, with its email, and attaches it', async () => {
      const repo = t.makeRepo('code/a')
      const core = createCore({ home: t.home, env: t.env })

      await core.createIdentity(work)
      await core.generateSshKey('work')

      const key = t.path('.ssh/id_ed25519_work')

      expect(core.load().identities[0]!.sshKey).toBe(key)
      expect(await Bun.file(`${key}.pub`).text()).toMatch(/^ssh-ed25519 \S+ nico@work\.dev\n$/)
      expect(core.listSshKeys()).toEqual([key])
      expect(t.git(repo, 'config', 'core.sshCommand')).toContain(key)
    })

    test('generates a signing key that git signs and verifies commits with', async () => {
      const repo = t.makeRepo('code/a')
      const core = createCore({ home: t.home, env: t.env })

      await core.createIdentity(work)
      await core.generateSshKey('work', '', '', 'signing')

      const key = t.path('.ssh/id_ed25519_work-signing')

      expect(core.load().identities[0]).toMatchObject({ sshKey: null, signingKey: key })

      t.git(repo, 'commit', '--allow-empty', '--quiet', '-m', 'signed')

      expect(t.git(repo, 'log', '-1', '--format=%G?')).toBe('G')
    })

    test('never overwrites an existing key file', async () => {
      const taken = writeKey('id_ed25519_work')
      const core = createCore({ home: t.home, env: t.env })

      await core.createIdentity(work)
      await core.generateSshKey('work')
      await core.generateSshKey('work')

      expect(await Bun.file(taken).text()).toBe('PRIVATE')
      expect(core.load().identities[0]!.sshKey).toBe(t.path('.ssh/id_ed25519_work-3'))
      expect(core.listSshKeys()).toHaveLength(3)
    })

    test('generates the key with the chosen name', async () => {
      const core = createCore({ home: t.home, env: t.env })

      await core.createIdentity(work)
      await core.generateSshKey('work', '', 'github_work')

      expect(core.load().identities[0]!.sshKey).toBe(t.path('.ssh/github_work'))
      expect(await Bun.file(t.path('.ssh/github_work.pub')).exists()).toBe(true)
    })

    test('rejects a chosen name that is taken or not a plain file name', async () => {
      const taken = writeKey('id_taken')
      const core = createCore({ home: t.home, env: t.env })

      await core.createIdentity(work)

      expect(await rejection(core.generateSshKey('work', '', 'id_taken'))).toContain(
        'already exists',
      )
      expect(await Bun.file(taken).text()).toBe('PRIVATE')

      for (const name of ['../escape', '.hidden', 'a b', 'key.pub', 'config']) {
        // eslint-disable-next-line no-await-in-loop -- each rejection is checked in turn
        expect(await rejection(core.generateSshKey('work', '', name))).toContain(
          'must be a file name',
        )
      }

      expect(core.load().identities[0]!.sshKey).toBeNull()
    })

    test('protects the key with the passphrase', async () => {
      const core = createCore({ home: t.home, env: t.env })

      await core.createIdentity(work)
      await core.generateSshKey('work', 'correct horse')

      const key = t.path('.ssh/id_ed25519_work')

      const check = (passphrase: string) =>
        Bun.spawnSync(['ssh-keygen', '-y', '-P', passphrase, '-f', key], { env: t.env }).exitCode

      expect(check('correct horse')).toBe(0)
      expect(check('')).not.toBe(0)
    })

    test('shows the ssh-keygen failure and leaves the Identity untouched', async () => {
      const core = createCore({ home: t.home, env: t.env })

      await core.createIdentity(work)
      mkdirSync(t.path('.ssh'))
      chmodSync(t.path('.ssh'), 0o500)

      expect(await rejection(core.generateSshKey('work'))).toMatch(/ssh-keygen failed: .+/)
      expect(core.load().identities[0]!.sshKey).toBeNull()
      expect(await rejection(core.generateSshKey('missing'))).toContain('does not exist')
    })

    test('copies the public key with the platform clipboard command', async () => {
      const core = createCore({ home: t.home, env: clipboardEnv(`cat > '${t.path('copied')}'`) })

      await core.createIdentity(work)
      await core.generateSshKey('work')
      await core.copySshPublicKey('work')

      expect(await Bun.file(t.path('copied')).text()).toBe(
        await Bun.file(t.path('.ssh/id_ed25519_work.pub')).text(),
      )
    })

    test('reports a clipboard command that fails', async () => {
      const core = createCore({ home: t.home, env: clipboardEnv('exit 1') })

      await core.createIdentity({ ...work, sshKey: writeKey('id_work') })

      expect(await rejection(core.copySshPublicKey('work'))).toContain(
        `${CLIPBOARD_COMMAND} failed`,
      )
    })

    test.skipIf(process.platform === 'darwin')(
      'falls back to xclip when wl-copy fails outside Wayland',
      async () => {
        const env = clipboardEnv('exit 1')

        writeFileSync(t.path('bin/xclip'), `#!/bin/sh\ncat > '${t.path('copied')}'\n`)
        chmodSync(t.path('bin/xclip'), 0o755)
        const core = createCore({ home: t.home, env })

        await core.createIdentity({ ...work, sshKey: writeKey('id_work') })
        await core.copySshPublicKey('work')

        expect(await Bun.file(t.path('copied')).text()).toBe(
          await Bun.file(t.path('.ssh/id_work.pub')).text(),
        )
      },
    )

    test('reports a missing clipboard command, a missing key and a missing public key', async () => {
      const core = createCore({ home: t.home, env: clipboardEnv(null) })

      const writeKeyOf = (sshKey: string | null) =>
        t.writeIdentities(
          `${PERSONAL_DEFAULT_IDENTITIES}${sshKey === null ? '' : `ssh_key = "${sshKey}"\n`}`,
        )

      writeKeyOf(null)
      expect(await rejection(core.copySshPublicKey('personal'))).toContain('has no SSH key')

      writeKeyOf(writeKey('id_work', false))
      expect(await rejection(core.copySshPublicKey('personal'))).toContain(
        'id_work.pub does not exist',
      )

      writeKeyOf(writeKey('id_other'))
      expect(await rejection(core.copySshPublicKey('personal'))).toContain(
        'No clipboard command found',
      )
    })
  })
})

describe('diagnostics', () => {
  const work = { label: 'Work', name: 'Nico Work', email: 'nico@work.dev' }
  const core = () => createCore({ home: t.home, env: t.env })

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    )

  async function withScopes() {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const folder = t.path('code/group')
    const repo = t.makeRepo('code/group/beta')

    mkdirSync(folder, { recursive: true })
    await core().createIdentity(work)
    await core().assignFolder(folder, 'work')
    await core().assignRepository(repo, 'work')

    return { folder, repo }
  }

  test('flags Folder and Repo Scope Assignments whose path no longer exists', async () => {
    const { folder, repo } = await withScopes()

    expect((await core().diagnostics()).orphans).toEqual([])

    rmSync(repo, { recursive: true })
    rmSync(folder, { recursive: true })

    const { orphans } = await core().diagnostics()

    expect(orphans.map(({ path, repository }) => [path, repository])).toEqual([
      [folder, false],
      [repo, true],
    ])
  })

  test('re-points an orphaned Assignment to another path and keeps its Identity', async () => {
    const { folder, repo } = await withScopes()
    const moved = t.makeRepo('code/moved')

    rmSync(repo, { recursive: true })
    rmSync(folder, { recursive: true })
    mkdirSync(t.path('elsewhere'))

    await core().repointFolder(folder, t.path('elsewhere'))
    await core().repointRepository(repo, moved)

    expect(
      core()
        .loadFolderScopes()
        .map(({ path, identityId }) => [path, identityId]),
    ).toEqual([[t.path('elsewhere'), 'work']])
    expect(
      core()
        .loadRepoScopes()
        .map(({ path, identityId }) => [path, identityId]),
    ).toEqual([[moved, 'work']])
    expect((await core().diagnostics()).orphans).toEqual([])
    expect(t.git(moved, 'config', 'user.email')).toBe('nico@work.dev')
  })

  test('rejects re-pointing to a path that is not valid and keeps the Assignment', async () => {
    const { folder } = await withScopes()

    expect(await rejection(core().repointFolder(folder, t.path('missing')))).toContain(
      'not a directory',
    )
    expect(await rejection(core().repointFolder(t.path('unknown'), folder))).toContain(
      'no Assignment',
    )
    expect(
      core()
        .loadFolderScopes()
        .map(({ path }) => path),
    ).toEqual([folder])
  })

  test('re-pointing an Assignment to its own path keeps it', async () => {
    const { folder } = await withScopes()

    await core().repointFolder(folder, `${folder}/`)

    expect(
      core()
        .loadFolderScopes()
        .map(({ path, identityId }) => [path, identityId]),
    ).toEqual([[folder, 'work']])
  })

  test('re-pointing over the Assignment of another Identity needs `replace`', async () => {
    const { folder } = await withScopes()
    const other = t.path('other')

    mkdirSync(other)
    await core().assignFolder(other, 'personal')
    rmSync(folder, { recursive: true })

    const conflict = await core()
      .repointFolder(folder, other)
      .catch((error: unknown) => error)

    expect(conflict).toBeInstanceOf(AssignmentConflictError)
    expect((conflict as AssignmentConflictError).existing.identityId).toBe('personal')
    expect(core().loadFolderScopes()).toHaveLength(2)

    await core().repointFolder(folder, other, { replace: true })

    expect(
      core()
        .loadFolderScopes()
        .map(({ path, identityId }) => [path, identityId]),
    ).toEqual([[other, 'work']])
  })

  test('warns when identity settings follow the include line and moving it fixes the order', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await core().apply()
    expect((await core().diagnostics()).includeOverridden).toBe(false)

    const config = await Bun.file(t.path('.gitconfig')).text()

    t.write('.gitconfig', `${config}[user]\n\temail = late@example.com\n`)

    expect((await core().diagnostics()).includeOverridden).toBe(true)
    expect(t.git(repo, 'config', 'user.email')).toBe('late@example.com')

    const { backupPath } = await core().moveIncludeToEnd()

    expect(backupPath).not.toBeNull()
    expect((await core().diagnostics()).includeOverridden).toBe(false)
    expect(t.git(repo, 'config', 'user.email')).toBe('nico@personal.dev')

    const moved = await Bun.file(t.path('.gitconfig')).text()

    expect(moved).toContain('late@example.com')
    expect(moved.match(/managed\.gitconfig/g)).toHaveLength(1)
    expect(moved.endsWith('\n')).toBe(true)
  })

  test('moving the include line keeps a following include that starts with a comment', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await core().apply()
    t.write('other.gitconfig', '[core]\n\teditor = nano\n')

    const config = await Bun.file(t.path('.gitconfig')).text()

    t.write(
      '.gitconfig',
      `${config}[include]\n\t# shared\n\tpath = ${JSON.stringify(t.path('other.gitconfig'))}\n`,
    )

    expect((await core().diagnostics()).includeOverridden).toBe(true)
    await core().moveIncludeToEnd()

    expect((await core().diagnostics()).includeOverridden).toBe(false)
    expect(t.git(repo, 'config', 'core.editor')).toBe('nano')
  })

  test('does not warn about other settings after the include line', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    await core().apply()

    const config = await Bun.file(t.path('.gitconfig')).text()

    t.write('.gitconfig', `${config}[core]\n\teditor = vim\n[user]\n\tsigningkey = ABC\n`)

    expect((await core().diagnostics()).includeOverridden).toBe(false)
  })

  test('groups repositories by the Identity they resolve to', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/a')
    t.makeRepo('code/b')
    t.git(t.makeRepo('code/c'), 'config', 'user.email', 'other@else.dev')
    await core().addScanRoot('~/code', 2)
    await core().apply()

    const byIdentity = await core().repositoriesByIdentity()

    expect([...byIdentity.keys()]).toEqual(['personal'])
    expect(byIdentity.get('personal')!.map(({ name }) => name)).toEqual(['a', 'b'])
  })
})

describe('Identity colors', () => {
  const identity = (label: string) => ({ label, name: `Nico ${label}`, email: `${label}@nico.dev` })

  test('gives each new Identity a free palette slot and keeps it when others are deleted', async () => {
    const core = createCore({ home: t.home, env: t.env })

    await core.createIdentity(identity('a'))
    await core.createIdentity(identity('b'))
    await core.createIdentity(identity('c'))

    const [a, b, c] = core.load().identities.map(({ color }) => color) as [number, number, number]

    expect(new Set([a, b, c]).size).toBe(3)

    await core.deleteIdentity('b')
    expect(core.load().identities.map(({ color }) => color)).toEqual([a, c])

    await core.createIdentity(identity('d'))
    expect(core.load().identities.at(-1)!.color).toBe(b)
  })

  test('gives distinct slots to Identities saved without one, and stores them on the next save', async () => {
    t.writeIdentities(`${PERSONAL_DEFAULT_IDENTITIES}
[identities.work]
name = "Nico Work"
email = "nico@work.dev"
`)
    const core = createCore({ home: t.home, env: t.env })
    const colors = core.load().identities.map(({ color }) => color)

    expect(new Set(colors).size).toBe(2)

    await core.createIdentity(identity('other'))
    expect(await Bun.file(`${t.configDir}/identities.toml`).text()).toContain(
      `color = ${colors[1]}`,
    )
  })
})
