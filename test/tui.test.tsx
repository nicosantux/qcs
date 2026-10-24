import type { ReactNode } from 'react'

import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

import { createTestRenderer } from '@opentui/core/testing'
import { createRoot } from '@opentui/react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createCore } from '../src/core/index.ts'
import { App } from '../src/tui/app.tsx'
import { resolveKeybindings } from '../src/tui/keybindings.ts'
import { COLORS } from '../src/tui/theme.ts'

import { createTestHome, PERSONAL_DEFAULT_IDENTITIES, type TestHome } from './harness.ts'

let t: TestHome

beforeEach(() => {
  t = createTestHome()
})

afterEach(() => {
  t.cleanup()
})

type Tui = Awaited<ReturnType<typeof testRender>>

const NAMED_KEYS = {
  backspace: 'pressBackspace',
  escape: 'pressEscape',
  return: 'pressEnter',
  tab: 'pressTab',
} as const

const ARROWS = ['down', 'left', 'right', 'up'] as const

async function press(tui: Tui, key: string) {
  if ((ARROWS as readonly string[]).includes(key))
    tui.mockInput.pressArrow(key as (typeof ARROWS)[number])
  else if (key in NAMED_KEYS) tui.mockInput[NAMED_KEYS[key as keyof typeof NAMED_KEYS]]()
  else tui.mockInput.pressKey(key)
  await tui.flush()
  await tui.renderOnce()
}

// Not @opentui/react/test-utils: it wraps renders in act(), but state updates here come from real keypresses and async work.
async function testRender(node: ReactNode, options: { width: number; height: number }) {
  const tui = await createTestRenderer(options)
  const root = createRoot(tui.renderer)
  const dispose = tui.dispose

  root.render(node)

  tui.dispose = async () => {
    root.unmount()
    await dispose()
  }

  return tui
}

async function type(tui: Tui, text: string) {
  await tui.mockInput.typeText(text)
  await tui.flush()
  await tui.renderOnce()
}

// waitForFrame counts render passes, which finish long before real git processes do.
async function eventually(
  tui: Tui,
  predicate: (frame: string) => boolean,
  deadline = Date.now() + 5000,
): Promise<string> {
  await tui.flush()
  await tui.renderOnce()
  const frame = tui.captureCharFrame()

  if (predicate(frame)) return frame
  if (Date.now() > deadline) throw new Error(`Timed out waiting for frame:\n${frame}`)
  await Bun.sleep(20)

  return eventually(tui, predicate, deadline)
}

async function openTui(
  onQuit: () => void = () => undefined,
  core = createCore({ home: t.home, env: t.env }),
) {
  const tui = await testRender(<App core={core} onQuit={onQuit} />, { width: 80, height: 24 })

  await tui.renderOnce()

  return tui
}

describe('TUI shell', () => {
  test('opens on the Repos view and offers the three views', async () => {
    const tui = await openTui()
    const frame = await tui.waitForFrame((f) => f.includes('Repos'))

    expect(frame).toContain('Identities')
    expect(frame).toContain('Settings')
    await tui.dispose()
  })

  test('switches views with single keys', async () => {
    const tui = await openTui()

    await press(tui, '2')
    expect(await tui.waitForFrame((f) => f.includes('No identities registered'))).toContain(
      'Identities',
    )

    await press(tui, '3')
    expect(await tui.waitForFrame((f) => f.includes('Settings view'))).toBeTruthy()

    await press(tui, '1')
    expect(await tui.waitForFrame((f) => f.includes('Repos view'))).toBeTruthy()
    await tui.dispose()
  })

  test('cycles views with Tab and Shift+Tab, leaving h and l to the Repos tree', async () => {
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'l')
    expect(tui.captureCharFrame()).toContain('No identities registered')
    await press(tui, 'tab')
    await tui.waitForFrame((f) => f.includes('Settings view'))
    tui.mockInput.pressTab({ shift: true })
    await tui.waitForFrame((f) => f.includes('No identities registered'))
    await press(tui, 'tab')
    await press(tui, 'tab')
    await tui.waitForFrame((f) => f.includes('Repos view'))
    await tui.dispose()
  })

  test('toggles the keybinding help with ?', async () => {
    const tui = await openTui()

    await press(tui, '?')
    const frame = await tui.waitForFrame((f) => f.includes('Keybindings'))

    expect(frame).toContain('quit')

    expect(frame).toContain('search repositories')
    expect(frame).not.toContain('generate an ed25519 SSH key')

    await press(tui, '?')
    await tui.waitForFrame((f) => !f.includes('Keybindings'))
    await press(tui, '2')
    await press(tui, '?')
    expect(await tui.waitForFrame((f) => f.includes('Keybindings'))).toContain(
      'generate an ed25519 SSH key',
    )
    await tui.dispose()
  })

  test('skips the splash when the terminal is too small for it', async () => {
    const tui = await openTui()
    const frame = await tui.waitForFrame((f) => f.includes('Repos view'))

    expect(frame).not.toContain('█▀█ █ █ █ █▀▀')
    await tui.dispose()
  })

  test('opens on the splash when it fits and leaves it on any key, still acting on the key', async () => {
    const tui = await testRender(
      <App core={createCore({ home: t.home, env: t.env })} onQuit={() => undefined} />,
      { width: 80, height: 40 },
    )

    await tui.renderOnce()

    await eventually(tui, (f) => f.includes('█▀█ █ █ █ █▀▀') && f.includes('@@@@@@@@'))
    await press(tui, '2')
    expect(await tui.waitForFrame((f) => f.includes('No identities registered'))).not.toContain(
      '█▀█ █ █ █ █▀▀',
    )
    await tui.dispose()
  })

  test('opens without the splash when it is turned off', async () => {
    const core = createCore({ home: t.home, env: t.env })

    await core.setShowSplash(false)

    const tui = await testRender(<App core={core} onQuit={() => undefined} />, {
      width: 80,
      height: 40,
    })

    expect(await eventually(tui, (f) => f.includes('Repos view'))).not.toContain('@@@@')
    await tui.dispose()
  })

  test('shows the art beside the help only when both fit', async () => {
    const tui = await testRender(
      <App core={createCore({ home: t.home, env: t.env })} onQuit={() => undefined} />,
      { width: 180, height: 45 },
    )

    await tui.renderOnce()

    await eventually(tui, (f) => f.includes('█▀█ █ █ █ █▀▀'))
    await press(tui, 'x')
    await press(tui, '?')
    expect(await tui.waitForFrame((f) => f.includes('Keybindings'))).toContain('@@@@@@@@')
    await tui.dispose()

    const narrow = await openTui()

    await press(narrow, '?')
    expect(await narrow.waitForFrame((f) => f.includes('Keybindings'))).not.toContain('@@@@')
    await narrow.dispose()
  })

  test('quits with q', async () => {
    let quit = false
    const tui = await openTui(() => (quit = true))

    await press(tui, 'q')
    await tui.waitFor(() => quit)
    await tui.dispose()
  })

  test('applies the Default Identity when it opens', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    const tui = await openTui()

    await tui.waitForFrame((f) => f.includes('Applied'))

    expect(t.git(repo, 'config', 'user.email')).toBe('nico@personal.dev')
    await tui.dispose()
  })

  test('shows a configuration error instead of crashing', async () => {
    t.writeIdentities('default = "ghost"\n')

    const tui = await openTui()

    expect(await tui.waitForFrame((f) => f.includes('ghost'))).toContain('Error')
    await tui.dispose()
  })

  test('shows a configuration error in the Identities view instead of crashing', async () => {
    t.writeIdentities('default = "ghost"\n')

    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'j')
    expect(await tui.waitForFrame((f) => f.includes('ghost'))).toContain('Identities view')
    await tui.dispose()
  })
})

describe('Identities view', () => {
  const core = () => createCore({ home: t.home, env: t.env })

  test('opens on the keys missing on this machine and regenerates them with the same names', async () => {
    t.writeIdentities(
      `${PERSONAL_DEFAULT_IDENTITIES}ssh_key = "~/.ssh/id_personal"\nsigning_key = "~/.ssh/id_personal_signing"\n` +
        '\n[identities.work]\nlabel = "Work"\nname = "Nico Work"\nemail = "nico@work.dev"\nssh_key = "~/.ssh/id_personal"\n',
    )

    const tui = await openTui()
    const frame = await tui.waitForFrame((f) => f.includes('SSH keys missing on this machine'))

    expect(frame).toContain('[2 Identities]')
    expect(frame).toContain('Personal, Work: ~/.ssh/id_personal')
    expect(frame).toContain('Personal: ~/.ssh/id_personal_signing (signing)')

    await press(tui, 'y')
    expect(await tui.waitForFrame((f) => f.includes('Key name'))).toContain('id_personal')
    await press(tui, 'return')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('signing key for "Personal"'))
    await press(tui, 'return')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Generated id_personal_signing'))

    const [personal, work] = core().load().identities

    expect(personal!.sshKey).toBe(t.path('.ssh/id_personal'))
    expect(personal!.signingKey).toBe(t.path('.ssh/id_personal_signing'))
    expect(work!.sshKey).toBe(t.path('.ssh/id_personal'))
    expect(core().missingSshKeys()).toEqual([])
    expect(core().missingSigningKeys()).toEqual([])
    await tui.dispose()
  })

  test('offers the missing keys once and leaves them flagged when declined', async () => {
    t.writeIdentities(`${PERSONAL_DEFAULT_IDENTITIES}ssh_key = "~/.ssh/id_personal"\n`)

    const tui = await openTui()

    await tui.waitForFrame((f) => f.includes('SSH keys missing on this machine'))
    await press(tui, 'n')
    await press(tui, '1')
    await press(tui, '2')
    const frame = await tui.waitForFrame((f) => f.includes('[key missing]'))

    expect(frame).not.toContain('SSH keys missing on this machine')
    await tui.dispose()
  })

  test('creates an Identity with the form and shows it in the list', async () => {
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'n')
    await type(tui, 'Work')
    await press(tui, 'return')
    await type(tui, 'Nico Work')
    await press(tui, 'return')
    await type(tui, 'nico@work.dev')
    await press(tui, 'return')
    await press(tui, 'right')
    await press(tui, 'return')
    await press(tui, 'return')

    await tui.waitForFrame((f) => f.includes('Nico Work <nico@work.dev>'))
    expect(core().load().identities).toMatchObject([{ id: 'work', email: 'nico@work.dev' }])
    await tui.dispose()
  })

  test('shows validation errors and keeps the form open', async () => {
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'n')
    await type(tui, 'Work')
    await press(tui, 'return')
    await type(tui, 'Nico')
    await press(tui, 'return')
    await type(tui, 'nope')
    await press(tui, 'return')
    await press(tui, 'return')
    await press(tui, 'return')

    expect(await tui.waitForFrame((f) => f.includes('not a valid email'))).toContain('New identity')
    await tui.dispose()
  })

  test('edits, marks as default and deletes with confirmation, applying to git each time', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/a')

    await core().createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })
    const tui = await openTui()

    await press(tui, '2')
    expect(await tui.waitForFrame((f) => f.includes('Personal'))).toContain('[default]')

    await press(tui, 'j')
    await press(tui, 'm')
    await tui.waitFor(() => t.git(repo, 'config', 'user.email') === 'nico@work.dev')

    await press(tui, 'e')
    await press(tui, 'tab')
    await press(tui, 'tab')
    for (const _ of 'nico@work.dev') tui.mockInput.pressBackspace()
    await type(tui, 'new@work.dev')
    await press(tui, 'return')
    await press(tui, 'return')
    await press(tui, 'return')
    await tui.waitFor(() => t.git(repo, 'config', 'user.email') === 'new@work.dev')

    await press(tui, 'd')
    await tui.waitForFrame((f) => f.includes('Choose another Default Identity'))
    expect(core().load().identities).toHaveLength(2)

    await press(tui, 'k')
    await press(tui, 'm')
    await tui.waitFor(() => t.git(repo, 'config', 'user.email') === 'nico@personal.dev')
    await press(tui, 'j')
    await press(tui, 'd')
    await press(tui, 'y')
    await tui.waitFor(() => core().load().identities.length === 1)
    await tui.dispose()
  })

  test('picks an existing SSH key for an Identity and flags it when the file goes missing', async () => {
    const key = t.write('.ssh/id_work', 'PRIVATE')

    t.write('.ssh/id_work.pub', 'ssh-ed25519 AAAA')
    t.write('.ssh/id_other', 'PRIVATE')
    const repo = t.makeRepo('code/a')

    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'n')
    await type(tui, 'Work')
    await press(tui, 'return')
    await type(tui, 'Nico Work')
    await press(tui, 'return')
    await type(tui, 'nico@work.dev')
    await press(tui, 'return')
    expect(tui.captureCharFrame()).toContain('+ new key')
    await press(tui, 'right')
    expect(tui.captureCharFrame()).toContain('(none)')
    await press(tui, 'right')
    expect(tui.captureCharFrame()).toContain('id_work')
    expect(tui.captureCharFrame()).not.toContain('id_other')
    await press(tui, 'return')
    await press(tui, 'return')

    await tui.waitForFrame((f) => f.includes('key: id_work'))
    expect(core().load().identities[0]!.sshKey).toBe(key)
    expect(t.git(repo, 'config', 'core.sshCommand')).toContain(key)

    rmSync(key)
    await press(tui, '1')
    await press(tui, '2')
    await tui.waitForFrame((f) => f.includes('[key missing]'))
    await tui.dispose()
  })

  test('generates a new key from the Identity form once it is saved', async () => {
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'n')
    await type(tui, 'Work')
    await press(tui, 'return')
    await type(tui, 'Nico Work')
    await press(tui, 'return')
    await type(tui, 'nico@work.dev')
    await press(tui, 'return')
    expect(tui.captureCharFrame()).toContain('+ new key')
    await press(tui, 'return')
    await press(tui, 'return')

    await tui.waitForFrame((f) => f.includes('Key name'))
    expect(core().load().identities[0]!.sshKey).toBeNull()
    await type(tui, 'id_work')
    await press(tui, 'return')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('key: id_work'))
    expect(core().load().identities[0]!.sshKey).toBe(t.path('.ssh/id_work'))
    await tui.dispose()
  })

  test('shows the SSH key path under the home directory as ~ in the detail pane', async () => {
    t.writeIdentities(`${PERSONAL_DEFAULT_IDENTITIES}ssh_key = "~/.ssh/id_personal"\n`)

    const tui = await testRender(<App core={core()} onQuit={() => undefined} />, {
      width: 120,
      height: 24,
    })

    await tui.renderOnce()
    await press(tui, '2')
    expect(await eventually(tui, (f) => f.includes('SSH key'))).toMatch(
      /SSH key\s+~\/\.ssh\/id_personal/,
    )
    await tui.dispose()
  })

  test('generates a key with a masked passphrase and copies the public key', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const clipboard = process.platform === 'darwin' ? 'pbcopy' : 'wl-copy'
    const bin = t.path('bin')

    mkdirSync(bin)
    writeFileSync(`${bin}/${clipboard}`, `#!/bin/sh\ncat > '${t.path('copied')}'\n`)
    chmodSync(`${bin}/${clipboard}`, 0o755)
    const env = { ...t.env, PATH: `${bin}:${t.env.PATH}` }
    const tui = await openTui(undefined, createCore({ home: t.home, env }))

    await press(tui, '2')
    await press(tui, 'g')
    await tui.waitForFrame((f) => f.includes('Key name'))
    await type(tui, 'id_personal')
    await press(tui, 'return')
    await type(tui, 'secret')
    const frame = await tui.waitForFrame((f) => f.includes('******'))

    expect(frame).not.toContain('secret')
    await press(tui, 'return')
    await tui.waitForFrame((f) => f.includes('Repeat the passphrase'))
    await type(tui, 'typo')
    await press(tui, 'return')
    await tui.waitForFrame((f) => f.includes('do not match'))
    await type(tui, 'secret')
    await press(tui, 'return')
    await type(tui, 'secret')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('key: id_personal'))

    await press(tui, 'c')
    await eventually(tui, (f) => f.includes('Public key copied'))
    expect(await Bun.file(t.path('copied')).text()).toContain('ssh-ed25519')
    await tui.dispose()
  })

  test('shows the ssh-keygen failure inline', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    mkdirSync(t.path('.ssh'))
    chmodSync(t.path('.ssh'), 0o500)
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'g')
    await press(tui, 'return')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Error: ssh-keygen failed'))
    await tui.dispose()
  })

  test('shows the apply error but keeps the saved change when git cannot be updated', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const real = core()

    await real.createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })
    const tui = await openTui(undefined, {
      ...real,
      setDefaultIdentity: async (id) => {
        await real.setDefaultIdentity(id)
        throw new Error('git exploded')
      },
    })

    await press(tui, '2')
    await press(tui, 'j')
    await press(tui, 'm')

    await tui.waitForFrame((f) => f.includes('git exploded'))
    expect(real.load().defaultIdentityId).toBe('work')
    await tui.dispose()
  })

  test('lists the SSH keys and deletes an unused one', async () => {
    t.write('.ssh/id_old', 'PRIVATE')
    t.write('.ssh/id_old.pub', 'ssh-ed25519 AAAA')
    t.write('.ssh/id_personal', 'PRIVATE')
    t.write('.ssh/id_personal.pub', 'ssh-ed25519 AAAA')
    t.writeIdentities(`${PERSONAL_DEFAULT_IDENTITIES}ssh_key = "~/.ssh/id_personal"\n`)
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 's')
    const frame = await tui.waitForFrame((f) => f.includes('SSH keys in ~/.ssh'))

    expect(frame).toMatch(/id_old\s+unused/)
    expect(frame).toMatch(/id_personal\s+Personal/)

    await press(tui, 'j')
    await press(tui, 'd')
    await tui.waitForFrame((f) => f.includes('attach another key'))

    await press(tui, 'k')
    await press(tui, 'd')
    await tui.waitForFrame((f) => f.includes('(y/n)'))
    await press(tui, 'y')
    await eventually(tui, (f) => f.includes('Deleted id_old'))
    expect(core().listSshKeys()).toEqual([t.path('.ssh/id_personal')])

    await press(tui, 'escape')
    await eventually(tui, (f) => !f.includes('SSH keys in ~/.ssh'))
    await tui.dispose()
  })

  const fillIdentity = async (tui: Tui) => {
    await press(tui, '2')
    await press(tui, 'n')
    await type(tui, 'Work')
    await press(tui, 'return')
    await type(tui, 'Nico Work')
    await press(tui, 'return')
    await type(tui, 'nico@work.dev')
    await press(tui, 'return')
  }

  test('signs with the SSH key chosen in the form and lists what each key is used for', async () => {
    t.write('.ssh/id_work', 'PRIVATE')
    t.write('.ssh/id_work.pub', 'ssh-ed25519 AAAA')
    const tui = await openTui()

    await fillIdentity(tui)
    await press(tui, 'right')
    await press(tui, 'right')
    await press(tui, 'down')
    expect(tui.captureCharFrame()).toMatch(/> Signing\s+\(none\)/)
    await press(tui, 'right')
    expect(tui.captureCharFrame()).toContain('same as SSH key')
    await press(tui, 'return')

    const frame = await eventually(tui, (f) => f.includes('key: id_work  signs'))

    expect(frame).toContain('as a signing key')
    expect(core().load().identities[0]!.signingKey).toBe('ssh_key')

    await press(tui, 's')
    expect(await tui.waitForFrame((f) => f.includes('SSH keys in ~/.ssh'))).toMatch(
      /id_work\s+Work \(push \+ signing\)/,
    )
    await press(tui, 'd')
    await tui.waitForFrame((f) => f.includes('attach another key'))
    await tui.dispose()
  })

  test('Enter on the SSH key moves to Signing, so a new key can also sign', async () => {
    const tui = await openTui()

    await fillIdentity(tui)
    expect(tui.captureCharFrame()).toMatch(/> SSH key\s+\+ new key/)
    await press(tui, 'return')
    expect(tui.captureCharFrame()).toMatch(/> Signing\s+\(none\)/)
    await press(tui, 'right')
    expect(tui.captureCharFrame()).toContain('same as SSH key')
    await press(tui, 'return')

    await tui.waitForFrame((f) => f.includes('New ed25519 key for "Work"'))
    expect(core().load().identities[0]).toMatchObject({ sshKey: null, signingKey: 'ssh_key' })
    await tui.dispose()
  })

  test('suggests the author names of other Identities in the Name field', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'n')
    await type(tui, 'Work')
    await press(tui, 'return')
    expect(tui.captureCharFrame()).toMatch(/> Name\s+Nico Personal/)
    expect(tui.captureCharFrame()).toContain('Tab use name')

    await type(tui, 'x')
    expect(tui.captureCharFrame()).not.toContain('Tab use name')
    await press(tui, 'backspace')
    await type(tui, 'ni')
    expect(tui.captureCharFrame()).toMatch(/> Name\s+nico Personal/)
    await press(tui, 'tab')
    expect(tui.captureCharFrame()).not.toContain('Tab use name')
    await press(tui, 'tab')
    await type(tui, 'nico@work.dev')
    await press(tui, 'return')
    await press(tui, 'right')
    await press(tui, 'return')
    await press(tui, 'return')

    await tui.waitFor(() => core().load().identities.length === 2)
    expect(core().load().identities[1]).toMatchObject({ label: 'Work', name: 'Nico Personal' })
    await tui.dispose()
  })

  test('offers signing with the SSH key only when there is one, and generates a signing key', async () => {
    const tui = await openTui()

    await fillIdentity(tui)
    await press(tui, 'right')
    await press(tui, 'down')
    await press(tui, 'right')
    expect(tui.captureCharFrame()).toMatch(/> Signing\s+\+ new key/)
    await press(tui, 'return')

    await tui.waitForFrame((f) => f.includes('New ed25519 signing key for "Work"'))
    expect(tui.captureCharFrame()).toContain('id_ed25519_work-signing')
    await press(tui, 'return')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('[default]  signs'))
    expect(core().load().identities[0]).toMatchObject({
      sshKey: null,
      signingKey: t.path('.ssh/id_ed25519_work-signing'),
    })
    await tui.dispose()
  })

  test('cancelling a delete keeps the Identity', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    await core().createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })
    const tui = await openTui()

    await press(tui, '2')
    await press(tui, 'j')
    await press(tui, 'd')
    await tui.waitForFrame((f) => f.includes('(y/n)'))
    await press(tui, 'n')
    await tui.waitForFrame((f) => !f.includes('(y/n)'))
    expect(core().load().identities).toHaveLength(2)
    await tui.dispose()
  })
})

describe('keybindings.toml', () => {
  const writeKeybindings = (toml: string) => t.write('.config/qcs/keybindings.toml', toml)

  test('overrides keys and updates the hints and the help', async () => {
    writeKeybindings('[identities]\nnew = "a"\n\n[global]\nhelp = "H"\n')
    const tui = await openTui()

    await press(tui, '2')
    const identities = await tui.waitForFrame((f) => f.includes('Identities view'))

    expect(identities).toContain('a new')
    expect(identities).toContain('Press a to create one')
    await press(tui, 'n')
    expect(tui.captureCharFrame()).not.toContain('New identity')
    await press(tui, 'a')
    await tui.waitForFrame((f) => f.includes('New identity'))
    await press(tui, 'escape')
    await eventually(tui, (f) => !f.includes('New identity'))

    await press(tui, 'H')
    const help = await tui.waitForFrame((f) => f.includes('Keybindings'))

    expect(help).toMatch(/a e\s+new \/ edit Identity/)
    expect(help).toMatch(/H\s+toggle this help/)
    await tui.dispose()
  })

  test('falls back to the default keys and shows why when the file is wrong', async () => {
    writeKeybindings('[identities]\nnew = "j"\n')
    const tui = await openTui()

    await press(tui, '2')
    expect(await tui.waitForFrame((f) => f.includes('default keys'))).toContain('reserved')
    await press(tui, 'n')
    await tui.waitForFrame((f) => f.includes('New identity'))
    await tui.dispose()
  })

  test('rejects unknown names, invalid keys and keys bound twice', () => {
    const failure = (document: Record<string, unknown>) => {
      try {
        resolveKeybindings(document)

        return null
      } catch (error) {
        return (error as Error).message
      }
    }

    expect(failure({ repos: { assign: 'ctrl+a', bottom: 'f2' } })).toBeNull()
    expect(failure({ identity: {} })).toContain('unknown table [identity]')
    expect(failure({ repos: { asign: 'a' } })).toContain('Valid actions:')
    expect(failure({ repos: { assign: 'shift+a' } })).toContain('is not a key')
    expect(failure({ repos: { assign: 'ab' } })).toContain('is not a key')
    expect(failure({ identities: { new: 'q' } })).toContain(
      '"q" is bound to both global.quit and identities.new',
    )
    expect(failure({ diagnostics: { repoint: 'x' } })).toContain('bound to both')
    expect(failure({ ssh_keys: { copy: 'n' } })).toBeNull()
  })
})

describe('Repos view', () => {
  const core = () => createCore({ home: t.home, env: t.env })
  const selectedLine = (frame: string) => /^[ │]*> (.*)$/m.exec(frame)?.[1] ?? ''

  async function openWithTree(identities = PERSONAL_DEFAULT_IDENTITIES) {
    t.writeIdentities(identities)
    t.makeRepo('code/alpha')
    t.makeRepo('code/group/beta')
    t.makeRepo('code/group/gamma')
    t.git(t.makeRepo('code/zeta'), 'config', 'user.email', 'other@else.dev')
    await core().addScanRoot('~/code', 3)

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('zeta'))

    return tui
  }

  test('points to Settings when there are no Scan Roots', async () => {
    const tui = await openTui()

    expect(await eventually(tui, (f) => f.includes('Add one in Settings'))).toContain('Repos view')
    await tui.dispose()
  })

  test('offers the suggested Scan Roots and fills the tree when accepted', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('dev/alpha')
    const tui = await openTui()

    expect(await eventually(tui, (f) => f.includes('Suggested Scan Roots'))).toContain('~/dev')
    await press(tui, 'return')

    const frame = await eventually(tui, (f) => f.includes('alpha'))

    expect(frame).not.toContain('Suggested Scan Roots')
    expect(
      core()
        .loadScanRoots()
        .map((root) => root.displayPath),
    ).toEqual(['~/dev'])
    await tui.dispose()
  })

  test('dismissing the offer leaves the empty state', async () => {
    t.makeRepo('dev/alpha')
    const tui = await openTui()

    await eventually(tui, (f) => f.includes('Suggested Scan Roots'))
    await press(tui, 'escape')

    expect(await eventually(tui, (f) => f.includes('Add one in Settings'))).not.toContain(
      'Suggested',
    )
    await press(tui, '2')
    await press(tui, '1')
    expect(await eventually(tui, (f) => f.includes('Add one in Settings'))).not.toContain(
      'Suggested',
    )
    expect(core().loadScanRoots()).toEqual([])
    await tui.dispose()
  })

  test('shows the Scan Root, folders and repositories with their Effective Identity and origin', async () => {
    const tui = await openWithTree()
    const frame = tui.captureCharFrame()

    expect(frame).toContain('~/code')
    expect(frame).toContain('group')
    expect(frame).toMatch(/alpha\s+Personal\s+Default Identity/)
    expect(frame).toMatch(/zeta\s+Unknown Identity\s+other@else\.dev/)
    await tui.dispose()
  })

  test('shows whether pushes use the Identity key and flags a missing one', async () => {
    const key = t.write('.ssh/id_personal', 'PRIVATE')

    const tui = await openWithTree(`${PERSONAL_DEFAULT_IDENTITIES}ssh_key = "~/.ssh/id_personal"\n`)

    expect(tui.captureCharFrame()).toMatch(
      /alpha\s+Personal\s+Default Identity\s+SSH key\b(?! missing)/,
    )

    rmSync(key)
    await core().apply()
    await press(tui, 'r')
    await eventually(tui, (f) => f.includes('SSH key missing'))
    await tui.dispose()
  })

  test('flags a missing signing key', async () => {
    const key = t.write('.ssh/id_signing', 'PRIVATE')

    const tui = await openWithTree(
      `${PERSONAL_DEFAULT_IDENTITIES}signing_key = "~/.ssh/id_signing"\n`,
    )

    expect(tui.captureCharFrame()).not.toContain('signing key missing')

    rmSync(key)
    await core().apply()
    await press(tui, 'r')
    await eventually(tui, (f) => f.includes('signing key missing'))
    await tui.dispose()
  })

  test('moves with j, k, g and G', async () => {
    const tui = await openWithTree()

    expect(selectedLine(tui.captureCharFrame())).toContain('~/code')
    await press(tui, 'j')
    expect(selectedLine(tui.captureCharFrame())).toContain('alpha')
    await press(tui, 'G')
    expect(selectedLine(tui.captureCharFrame())).toContain('zeta')
    await press(tui, 'k')
    expect(selectedLine(tui.captureCharFrame())).toContain('gamma')
    await press(tui, 'g')
    expect(selectedLine(tui.captureCharFrame())).toContain('~/code')
    await tui.dispose()
  })

  test('keys that arrive before a render all move the selection', async () => {
    const tui = await openWithTree()

    tui.mockInput.pressKey('j')
    await press(tui, 'j')
    expect(selectedLine(tui.captureCharFrame())).toContain('group')
    await tui.dispose()
  })

  test('collapses with h and expands with l, and h on a repository jumps to its folder', async () => {
    const tui = await openWithTree()

    await press(tui, 'j')
    await press(tui, 'j')
    await press(tui, 'h')
    expect(tui.captureCharFrame()).not.toContain('beta')
    await press(tui, 'l')
    expect(tui.captureCharFrame()).toContain('beta')

    await press(tui, 'j')
    await press(tui, 'h')
    expect(selectedLine(tui.captureCharFrame())).toContain('group')
    await tui.dispose()
  })

  test('keeps each Identity color across rescans', async () => {
    const tui = await openWithTree()

    const colorOfAlpha = () => {
      const { lines } = tui.captureSpans()
      const line = lines.find((l) => l.spans.some((span) => span.text.includes('alpha')))

      return line!.spans
        .find((span) => span.text.includes('Personal'))!
        .fg.toInts()
        .join()
    }

    const before = colorOfAlpha()

    await core().createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })
    t.makeRepo('code/delta')
    await press(tui, 'r')
    await eventually(tui, (f) => f.includes('delta'))

    expect(colorOfAlpha()).toBe(before)
    expect(before).not.toBe(COLORS.error.toInts().join())
    await tui.dispose()
  })

  test('on a wide terminal shows the selected row in a side pane and dialogs beside the tree', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/alpha')
    await core().addScanRoot('~/code', 3)

    const tui = await testRender(<App core={core()} onQuit={() => undefined} />, {
      width: 120,
      height: 24,
    })

    await eventually(tui, (f) => f.includes('alpha'))
    await press(tui, 'j')

    const detail = await eventually(tui, (f) => f.includes('Origin'))

    expect(detail).toMatch(/Path\s+~\/code\/alpha/)
    expect(detail).toMatch(/Origin\s+Default Identity/)

    await press(tui, 'a')

    const picking = await eventually(tui, (f) => f.includes('Assign an Identity'))

    expect(picking).toContain('~/code/alpha')
    expect(picking).toMatch(/alpha\s+Personal\s+Default Identity/)
    await tui.dispose()
  })

  test('moves with the arrow keys and toggles folders with Enter', async () => {
    const tui = await openWithTree()

    await press(tui, 'down')
    expect(selectedLine(tui.captureCharFrame())).toContain('alpha')
    await press(tui, 'down')
    await press(tui, 'return')
    expect(tui.captureCharFrame()).not.toContain('beta')
    await press(tui, 'right')
    expect(tui.captureCharFrame()).toContain('beta')
    await press(tui, 'up')
    expect(selectedLine(tui.captureCharFrame())).toContain('alpha')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Assign an Identity'))
    await tui.dispose()
  })

  test('points to the Identities view while there are none, and shows the Default Identity', async () => {
    t.makeRepo('code/alpha')
    await core().addScanRoot('~/code', 3)

    const tui = await openTui()

    expect(await eventually(tui, (f) => f.includes('alpha'))).toContain(
      'No Identities yet: press 2, then n to create one',
    )
    expect(tui.captureCharFrame()).not.toContain('default:')

    await press(tui, '2')
    await press(tui, 'n')
    await type(tui, 'Work')
    await press(tui, 'return')
    await type(tui, 'Nico Work')
    await press(tui, 'return')
    await type(tui, 'nico@work.dev')
    await press(tui, 'return')
    await press(tui, 'right')
    await press(tui, 'return')
    await press(tui, 'return')

    const created = await eventually(tui, (f) => f.includes('Created "Work"'))

    expect(created).toContain('now the Default Identity')
    expect(created).toContain('default: Work')
    await tui.dispose()
  })

  test('rescans on demand and picks up newly cloned repositories', async () => {
    const tui = await openWithTree()

    t.makeRepo('code/delta')
    expect(tui.captureCharFrame()).not.toContain('delta')
    await press(tui, 'r')
    await eventually(tui, (f) => f.includes('delta'))
    await tui.dispose()
  })
})

describe('Settings view', () => {
  const core = () => createCore({ home: t.home, env: t.env })

  test('adds a Scan Root asking only for its path', async () => {
    t.makeRepo('code/a')
    const tui = await openTui()

    await press(tui, '3')
    await press(tui, 'n')
    expect(tui.captureCharFrame()).not.toContain('Depth')
    await type(tui, 'code')
    await press(tui, 'return')

    const frame = await tui.waitForFrame((f) => f.includes('~/code'))

    expect(frame).not.toContain('depth')
    expect(core().loadScanRoots()).toMatchObject([{ path: t.path('code'), maxDepth: 4 }])
    await tui.dispose()
  })

  test('completes the typed path with matching directories', async () => {
    t.makeRepo('code/a')
    t.makeRepo('Work/b')
    mkdirSync(t.path('.hidden'))
    const tui = await openTui()

    await press(tui, '3')
    await press(tui, 'n')

    const listed = await eventually(tui, (f) => f.includes('~/code/') && f.includes('~/Work/'))

    expect(listed).not.toContain('.hidden')
    await type(tui, 'wor')
    await eventually(tui, (f) => !f.includes('~/code/'))
    await press(tui, 'tab')
    await eventually(tui, (f) => f.includes('Path ~/Work/'))
    await press(tui, 'return')
    await tui.waitFor(() => core().loadScanRoots().length === 1)
    expect(core().loadScanRoots()).toMatchObject([{ path: t.path('Work') }])
    await tui.dispose()
  })

  test('adds the suggested Scan Roots that are not Scan Roots yet', async () => {
    t.makeRepo('code/a')
    t.makeRepo('work/b')
    await core().addScanRoot('~/code')
    const tui = await openTui()

    await press(tui, '3')
    await press(tui, 's')
    await eventually(tui, (f) => f.includes('~/work') && f.includes('Added 1'))
    expect(
      core()
        .loadScanRoots()
        .map((root) => root.displayPath),
    ).toEqual(['~/code', '~/work'])
    await tui.dispose()
  })

  test('shows validation errors and keeps the form open', async () => {
    const tui = await openTui()

    await press(tui, '3')
    await press(tui, 'n')
    await type(tui, 'nope')
    await press(tui, 'return')

    expect(await tui.waitForFrame((f) => f.includes('not a directory'))).toContain('New Scan Root')
    await tui.dispose()
  })

  test('turns the splash screen off and on', async () => {
    const tui = await openTui()

    await press(tui, '3')
    await press(tui, 'p')
    await eventually(tui, (f) => f.includes('Splash screen off'))
    expect(core().loadShowSplash()).toBe(false)
    await press(tui, 'p')
    await eventually(tui, (f) => f.includes('Splash screen on'))
    expect(core().loadShowSplash()).toBe(true)
    await tui.dispose()
  })

  test('removes a Scan Root after confirming', async () => {
    t.makeRepo('code/a')
    await core().addScanRoot('~/code', 3)
    const tui = await openTui()

    await press(tui, '3')
    await press(tui, 'd')
    await tui.waitForFrame((f) => f.includes('(y/n)'))
    await press(tui, 'y')
    await tui.waitFor(() => core().loadScanRoots().length === 0)
    await tui.dispose()
  })
})

describe('Folder Scopes in the Repos view', () => {
  const core = () => createCore({ home: t.home, env: t.env })
  const work = { label: 'Work', name: 'Nico Work', email: 'nico@work.dev' }

  async function openWithGroupSelected() {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const beta = t.makeRepo('code/group/beta')

    await core().addScanRoot('~/code', 3)
    await core().createIdentity(work)

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('group'))
    await press(tui, 'j')

    return { tui, beta }
  }

  test('previews the change, assigns on confirm, marks the folder and applies it to git', async () => {
    const { tui, beta } = await openWithGroupSelected()

    await press(tui, 'a')
    await eventually(tui, (f) => f.includes('Assign an Identity'))
    await press(tui, 'j')
    await press(tui, 'return')

    const preview = await eventually(tui, (f) => f.includes('beta  Personal -> Work'))

    expect(preview).toContain('Apply? (y/n)')
    expect(t.git(beta, 'config', 'user.email')).toBe('nico@personal.dev')

    await press(tui, 'y')

    const frame = await eventually(tui, (f) => f.includes('group  [Work]'))

    expect(frame).toContain('beta  Work  Folder Scope')
    expect(t.git(beta, 'config', 'user.email')).toBe('nico@work.dev')
    await tui.dispose()
  })

  test('says what changed after assigning and needs y, not Enter, to remove', async () => {
    const { tui } = await openWithGroupSelected()

    await press(tui, 'a')
    await press(tui, 'down')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Apply? (y/n)'))
    await press(tui, 'return')
    await eventually(tui, (f) =>
      f.includes('Assigned "Work" to ~/code/group (1 repository changed)'),
    )

    await press(tui, 'x')
    await eventually(tui, (f) => f.includes('beta  Work -> Personal'))
    await press(tui, 'return')
    expect(core().loadFolderScopes()).toHaveLength(1)
    await press(tui, 'y')
    await eventually(tui, (f) => f.includes('Removed the Assignment of ~/code/group'))
    await tui.dispose()
  })

  test('removes the Assignment after previewing the fallback', async () => {
    const { tui, beta } = await openWithGroupSelected()

    await core().assignFolder('~/code/group', 'work')
    await press(tui, 'r')
    await eventually(tui, (f) => f.includes('group  [Work]'))

    await press(tui, 'x')
    await eventually(tui, (f) => f.includes('beta  Work -> Personal'))
    await press(tui, 'y')

    const frame = await eventually(tui, (f) => !f.includes('[Work]'))

    expect(frame).toContain('beta  Personal  Default Identity')
    expect(t.git(beta, 'config', 'user.email')).toBe('nico@personal.dev')
    await tui.dispose()
  })

  test('cancelling the preview changes nothing', async () => {
    const { tui, beta } = await openWithGroupSelected()

    await press(tui, 'a')
    await press(tui, 'j')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Apply? (y/n)'))
    await press(tui, 'n')

    await eventually(tui, (f) => f.includes('a assign'))
    expect(core().loadFolderScopes()).toEqual([])
    expect(t.git(beta, 'config', 'user.email')).toBe('nico@personal.dev')
    await tui.dispose()
  })

  test('warns and lists the Assignments when deleting an Identity that has them', async () => {
    const { tui, beta } = await openWithGroupSelected()

    await core().assignFolder('~/code/group', 'work')
    await core().assignRemote('git@github.com:acme/**', 'work')
    await press(tui, '2')
    await press(tui, 'j')
    await press(tui, 'd')

    await eventually(tui, (f) =>
      f.replaceAll(/[│\s]+/g, ' ').includes('Assignments of: ~/code/group, git@github.com:acme/**'),
    )

    await press(tui, 'y')

    await tui.waitFor(() => core().loadFolderScopes().length === 0)
    expect(core().loadRemoteScopes()).toEqual([])
    expect(t.git(beta, 'config', 'user.email')).toBe('nico@personal.dev')
    await tui.dispose()
  })
})

describe('import of existing configuration', () => {
  const core = () => createCore({ home: t.home, env: t.env })

  function writeGitConfig() {
    t.write(
      '.gitconfig',
      '[user]\n\tname = Nico Personal\n\temail = nico@personal.dev\n[includeIf "gitdir:~/work/"]\n\tpath = ~/.gitconfig-work\n',
    )
    t.write('.gitconfig-work', '[user]\n\tname = Nico Work\n\temail = nico@work.dev\n')

    return t.makeRepo('work/a')
  }

  test('previews the import on first run, imports on enter, and then offers the Scan Roots', async () => {
    const repo = writeGitConfig()
    const tui = await openTui()

    const preview = await eventually(tui, (f) => f.includes('Import existing configuration'))

    expect(preview).toContain('Nico Personal <nico@personal.dev>')
    expect(preview).toContain('~/work')
    expect(preview).not.toContain('Suggested Scan Roots')
    expect(core().load().identities).toEqual([])

    await press(tui, 'return')

    expect(await eventually(tui, (f) => f.includes('Suggested Scan Roots'))).not.toContain(
      'Import existing',
    )
    expect(
      core()
        .load()
        .identities.map((identity) => identity.email),
    ).toEqual(['nico@personal.dev', 'nico@work.dev'])
    expect(t.git(repo, 'config', 'user.email')).toBe('nico@work.dev')
    await tui.dispose()
  })

  test('dismissing the import leaves the git config alone and moves on to the Scan Roots', async () => {
    writeGitConfig()
    const original = await Bun.file(t.path('.gitconfig')).text()
    const tui = await openTui()

    await eventually(tui, (f) => f.includes('Import existing configuration'))
    await press(tui, 'escape')

    expect(await eventually(tui, (f) => f.includes('Suggested Scan Roots'))).not.toContain(
      'Import existing',
    )
    expect(core().load().identities).toEqual([])
    expect((await Bun.file(t.path('.gitconfig')).text()).startsWith(original)).toBe(true)
    await tui.dispose()
  })

  test('can be started from Settings once a configuration exists', async () => {
    writeGitConfig()
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const tui = await openTui()

    await eventually(tui, (f) => f.includes('Suggested Scan Roots'))
    await press(tui, '3')
    await press(tui, 'i')
    await eventually(tui, (f) => f.includes('Import existing configuration'))
    await press(tui, 'y')
    await tui.waitFor(() => core().loadFolderScopes().length === 1)
    expect(
      core()
        .load()
        .identities.map((identity) => identity.email),
    ).toEqual(['nico@personal.dev', 'nico@work.dev'])
    await tui.dispose()
  })
})

describe('Repo Scopes in the Repos view', () => {
  const core = () => createCore({ home: t.home, env: t.env })

  async function openWithRepoSelected() {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const alpha = t.makeRepo('code/alpha')

    await core().addScanRoot('~/code', 2)
    await core().createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('alpha'))
    await press(tui, 'j')

    return { tui, alpha }
  }

  test('assigns the selected repository to an Identity and removes it again', async () => {
    const { tui, alpha } = await openWithRepoSelected()

    await press(tui, 'a')
    await eventually(tui, (f) => f.includes('Assign an Identity'))
    await press(tui, 'j')
    await press(tui, 'return')

    await eventually(tui, (f) => f.includes('alpha  Work  Repo Scope'))
    expect(t.git(alpha, 'config', 'user.email')).toBe('nico@work.dev')

    await press(tui, 'x')
    await eventually(tui, (f) => f.includes('alpha  Personal  Default Identity'))
    expect(core().loadRepoScopes()).toEqual([])
    expect(t.git(alpha, 'config', 'user.email')).toBe('nico@personal.dev')
    await tui.dispose()
  })

  test('removes a Repo Scope saved with the real path of a repository scanned through a symlink', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const alpha = t.makeRepo('volume/alpha')

    symlinkSync(t.path('volume'), t.path('code'))
    await core().addScanRoot('~/code', 2)
    await core().createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })
    await core().assignRepository(alpha, 'work')

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('alpha  Work  Repo Scope'))
    await press(tui, 'j')
    await press(tui, 'x')

    await eventually(tui, (f) => f.includes('alpha  Personal  Default Identity'))
    expect(core().loadRepoScopes()).toEqual([])
    await tui.dispose()
  })

  test('removing a Folder Scope that targets a repository asks for confirmation', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const alpha = t.makeRepo('code/alpha')

    await core().addScanRoot('~/code', 2)
    await core().createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })
    await core().assignFolder('~/code/alpha', 'work')

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('alpha  Work  Folder Scope'))
    await press(tui, 'j')
    await press(tui, 'x')
    await eventually(tui, (f) => f.includes('Remove Assignment'))
    await press(tui, 'y')

    await eventually(tui, (f) => f.includes('alpha  Personal  Default Identity'))
    expect(core().loadFolderScopes()).toEqual([])
    expect(t.git(alpha, 'config', 'user.email')).toBe('nico@personal.dev')
    await tui.dispose()
  })
})

describe('Remote Scopes in the Repos view', () => {
  const core = () => createCore({ home: t.home, env: t.env })

  async function openWithRemoteRepoSelected() {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const alpha = t.makeRepo('code/alpha')

    t.git(alpha, 'remote', 'add', 'origin', 'git@github.com:acme/alpha.git')
    await core().addScanRoot('~/code', 2)
    await core().createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('alpha'))
    await press(tui, 'j')

    return { tui, alpha }
  }

  test('creates a Remote Scope from the prefilled pattern of the selected repository', async () => {
    const { tui, alpha } = await openWithRemoteRepoSelected()

    await press(tui, 'm')
    await eventually(tui, (f) => f.includes('git@github.com:acme/**'))
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Assign an Identity'))
    await press(tui, 'j')
    await press(tui, 'return')

    await eventually(tui, (f) => f.includes('alpha  Work  Remote Scope'))
    expect(core().loadRemoteScopes()).toEqual([
      { pattern: 'git@github.com:acme/**', identityId: 'work' },
    ])
    expect(t.git(alpha, 'config', 'user.email')).toBe('nico@work.dev')
    await tui.dispose()
  })

  test('lets the pattern be edited before choosing the Identity', async () => {
    const { tui } = await openWithRemoteRepoSelected()

    await press(tui, 'm')
    await eventually(tui, (f) => f.includes('git@github.com:acme/**'))
    await press(tui, 'backspace')
    await press(tui, 'backspace')
    await type(tui, 'alpha*')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Assign an Identity'))
    await press(tui, 'j')
    await press(tui, 'return')

    await eventually(tui, (f) => f.includes('alpha  Work  Remote Scope'))
    expect(core().loadRemoteScopes()).toEqual([
      { pattern: 'git@github.com:acme/alpha*', identityId: 'work' },
    ])
    await tui.dispose()
  })

  test('removes the Remote Scope of the pattern with Ctrl+D', async () => {
    const { tui, alpha } = await openWithRemoteRepoSelected()

    await core().assignRemote('git@github.com:acme/**', 'work')
    await press(tui, 'r')
    await eventually(tui, (f) => f.includes('alpha  Work  Remote Scope'))
    await press(tui, 'm')
    await eventually(tui, (f) => f.includes('git@github.com:acme/**'))
    tui.mockInput.pressKey('d', { ctrl: true })
    await eventually(tui, (f) => f.includes('Remove this Remote Scope? (y/n)'))
    expect(core().loadRemoteScopes()).toHaveLength(1)
    await press(tui, 'y')

    await eventually(tui, (f) => f.includes('Removed the Remote Scope git@github.com:acme/**'))
    await eventually(tui, (f) => !/alpha\s+Work\s+Remote Scope/.test(f))
    expect(core().loadRemoteScopes()).toEqual([])
    expect(t.git(alpha, 'config', 'user.email')).not.toBe('nico@work.dev')
    await tui.dispose()
  })

  test('says so when the repository has no remote', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/alpha')
    await core().addScanRoot('~/code', 2)

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('alpha'))
    await press(tui, 'j')
    await press(tui, 'm')
    await eventually(tui, (f) => f.includes('has no remote'))
    await tui.dispose()
  })

  test('is disabled with a message when git is older than 2.36', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const alpha = t.makeRepo('code/alpha')

    t.git(alpha, 'remote', 'add', 'origin', 'git@github.com:acme/alpha.git')
    mkdirSync(t.path('fake-bin'))
    writeFileSync(
      t.path('fake-bin/git'),
      `#!/bin/sh\n[ "$1" = "--version" ] && echo "git version 2.30.1" && exit 0\nexec ${Bun.which('git')} "$@"\n`,
      { mode: 0o755 },
    )

    const old = createCore({
      home: t.home,
      env: { ...t.env, PATH: `${t.path('fake-bin')}:${t.env.PATH}` },
    })

    await old.addScanRoot('~/code', 2)

    const tui = await openTui(undefined, old)

    await eventually(tui, (f) => f.includes('alpha'))
    await press(tui, 'j')
    await press(tui, 'm')
    await eventually(tui, (f) => f.includes('need git 2.36 or newer'))
    expect(tui.captureCharFrame()).not.toContain('New Remote Scope')
    await tui.dispose()
  })
})

describe('alerts and diagnostics', () => {
  const core = () => createCore({ home: t.home, env: t.env })
  const work = { label: 'Work', name: 'Nico Work', email: 'nico@work.dev' }

  async function openWithRepos() {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/alpha')
    t.makeRepo('code/group/gamma')
    t.git(t.makeRepo('code/zeta'), 'config', 'user.email', 'other@else.dev')
    await core().addScanRoot('~/code', 3)

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('zeta'))

    return tui
  }

  async function openWithOrphans() {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const folder = t.path('code/gone')
    const repo = t.makeRepo('code/lost')

    mkdirSync(folder, { recursive: true })
    await core().addScanRoot('~/code', 2)
    await core().createIdentity(work)
    await core().assignFolder(folder, 'work')
    await core().assignRepository(repo, 'work')
    rmSync(folder, { recursive: true })
    rmSync(repo, { recursive: true })
    t.makeRepo('code/kept')

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('d diagnostics (2)'))

    return tui
  }

  test('f shows only repositories with alerts and toggles back', async () => {
    const tui = await openWithRepos()

    await press(tui, 'f')

    const filtered = await eventually(tui, (f) => !f.includes('alpha'))

    expect(filtered).toContain('zeta')
    expect(filtered).not.toContain('gamma')

    await press(tui, 'f')

    const all = await eventually(tui, (f) => f.includes('alpha'))

    expect(all).toContain('gamma')
    await tui.dispose()
  })

  test('/ searches repositories by name or path and Esc clears the search', async () => {
    const tui = await openWithRepos()

    await press(tui, '/')
    await type(tui, 'gam')

    const searching = await eventually(tui, (f) => !f.includes('alpha'))

    expect(searching).toContain('gamma')
    expect(searching).not.toContain('zeta')

    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('(Esc clears)'))
    await press(tui, 'escape')
    await eventually(tui, (f) => f.includes('alpha'))

    await press(tui, '/')
    await type(tui, 'group/')
    await eventually(tui, (f) => !f.includes('alpha') && f.includes('gamma'))
    await tui.dispose()
  })

  test('says so when nothing matches', async () => {
    const tui = await openWithRepos()

    await press(tui, '/')
    await type(tui, 'nope')
    await eventually(tui, (f) => f.includes('No repositories match.'))
    await tui.dispose()
  })

  test('lists Orphaned Assignments and removes one after confirming', async () => {
    const tui = await openWithOrphans()

    await press(tui, 'd')

    const panel = await eventually(tui, (f) => f.includes('Orphaned Assignment: ~/code/gone'))

    expect(panel).toContain('~/code/lost')

    await press(tui, 'x')
    await eventually(tui, (f) => f.includes('Remove this Assignment? (y/n)'))
    await press(tui, 'n')
    await eventually(tui, (f) => f.includes('Orphaned Assignment: ~/code/gone'))
    expect(core().loadFolderScopes()).toHaveLength(1)

    await press(tui, 'x')
    await press(tui, 'return')
    expect(core().loadFolderScopes()).toHaveLength(1)
    await press(tui, 'y')
    await eventually(
      tui,
      (f) => f.includes('Removed the Assignment of ~/code/gone') && f.includes('~/code/lost'),
    )
    expect(tui.captureCharFrame()).not.toContain('Orphaned Assignment: ~/code/gone')
    expect(core().loadFolderScopes()).toEqual([])
    expect(core().loadRepoScopes()).toHaveLength(1)
    await tui.dispose()
  })

  test('re-points an Orphaned Assignment and reports an invalid path', async () => {
    const tui = await openWithOrphans()
    const moved = t.path('code/moved')

    mkdirSync(moved)
    await press(tui, 'd')
    await eventually(tui, (f) => f.includes('Orphaned Assignment'))
    await press(tui, 'p')
    await eventually(tui, (f) => f.includes('Re-point Assignment'))
    await type(tui, '~/code/nowhere')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('is not a directory'))

    await press(tui, 'escape')
    await eventually(tui, (f) => f.includes('Diagnostics'))
    await press(tui, 'p')
    await eventually(tui, (f) => f.includes('Re-point Assignment'))
    await type(tui, '~/code/moved')
    await press(tui, 'return')

    await eventually(tui, (f) => f.includes('Orphaned Assignment: ~/code/lost'))
    expect(
      core()
        .loadFolderScopes()
        .map(({ path }) => path),
    ).toEqual([moved])
    await tui.dispose()
  })

  test('asks before re-pointing over the Assignment of another Identity', async () => {
    const taken = t.path('code/taken')

    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    mkdirSync(taken, { recursive: true })
    await core().assignFolder(taken, 'personal')

    const tui = await openWithOrphans()

    await press(tui, 'd')
    await eventually(tui, (f) => f.includes('Orphaned Assignment'))
    await press(tui, 'p')
    await eventually(tui, (f) => f.includes('Re-point Assignment'))
    await type(tui, '~/code/taken')
    await press(tui, 'return')
    await eventually(tui, (f) => f.includes('Replace Assignment'))
    expect(core().loadFolderScopes()).toHaveLength(2)

    await press(tui, 'y')
    await eventually(tui, (f) => f.includes('Diagnostics'))
    expect(
      core()
        .loadFolderScopes()
        .map(({ path, identityId }) => [path, identityId]),
    ).toEqual([[taken, 'work']])
    await tui.dispose()
  })

  test('offers to move the include line after identity settings that override it', async () => {
    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    const repo = t.makeRepo('code/alpha')

    await core().addScanRoot('~/code', 2)
    await core().apply()
    t.write(
      '.gitconfig',
      `${await Bun.file(t.path('.gitconfig')).text()}[user]\n\temail = late@x.dev\n`,
    )

    const tui = await openTui()

    await eventually(tui, (f) => f.includes('d diagnostics (1)'))
    await press(tui, 'd')
    await eventually(tui, (f) => f.includes('sets identity after the qcs include'))
    await press(tui, 'return')

    expect(await eventually(tui, (f) => f.includes('Nothing to fix.'))).not.toContain('p re-point')
    expect(t.git(repo, 'config', 'user.email')).toBe('nico@personal.dev')
    await tui.dispose()
  })
})

describe('Identity reach in the Identities view', () => {
  test('shows how many repositories resolve to each Identity and which ones', async () => {
    const core = createCore({ home: t.home, env: t.env })

    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/alpha')
    const beta = t.makeRepo('code/beta')

    await core.addScanRoot('~/code', 2)
    await core.createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })
    await core.assignRepository(beta, 'work')

    const tui = await openTui(undefined, core)

    await press(tui, '2')

    const frame = await eventually(tui, (f) => f.includes('Repositories: alpha'))

    expect(frame).toMatch(/Personal {2}\[default\] {2}1 repo {2}Nico Personal/)
    await tui.dispose()
  })
})

describe('Terminal theme', () => {
  /** Visible cells colored with RGB instead of a palette slot or the terminal default. */
  const hardcodedColors = (tui: Tui): string[] =>
    tui.captureSpans().lines.flatMap(({ spans }, row) =>
      spans.flatMap(({ text, fg, bg }) =>
        [fg, bg]
          // A blank cell's foreground never shows.
          .filter((color) => color === bg || text.trim() !== '')
          .filter((color) => color.intent === 'rgb' && color.a > 0)
          .map((color) => `row ${row} "${text.trim()}" ${color.toInts().join()}`),
      ),
    )

  test.each([
    { width: 80, height: 24 },
    { width: 120, height: 30 },
  ])('every view and dialog uses only terminal colors at $width columns', async (size) => {
    const core = createCore({ home: t.home, env: t.env })

    t.writeIdentities(PERSONAL_DEFAULT_IDENTITIES)
    t.makeRepo('code/alpha')
    await core.addScanRoot('~/code', 2)
    await core.createIdentity({ label: 'Work', name: 'Nico Work', email: 'nico@work.dev' })

    const tui = await testRender(<App core={core} onQuit={() => undefined} />, size)
    const found = new Set<string>()
    const check = () => hardcodedColors(tui).forEach((color) => found.add(color))

    await eventually(tui, (f) => f.includes('alpha'))
    check()

    for (const keys of [
      ['a'],
      ['escape', '/'],
      ['escape', '?'],
      ['?', '2'],
      ['n'],
      ['escape', 'j', 'd'],
      ['n', '3'],
      ['n'],
      ['escape', 'd'],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- keys are pressed in order
      for (const key of keys) await press(tui, key)
      check()
    }

    expect([...found]).toEqual([])
    await tui.dispose()
  })
})
