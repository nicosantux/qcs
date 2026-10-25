import type { Core, Identity } from '../core/index.ts'

import { useEffect, useReducer, useRef, useState } from 'react'

import { useKeyboard, useTerminalDimensions } from '@opentui/react'

import { IdentitiesView } from './identities-view.tsx'
import { identityColor } from './identity-color.ts'
import {
  DEFAULT_KEYBINDINGS,
  KeybindingsProvider,
  matchesKey,
  resolveKeybindings,
  type Keybindings,
} from './keybindings.ts'
import { Hints } from './layout.tsx'
import { ReposView } from './repos-view.tsx'
import { SettingsView } from './settings-view.tsx'
import {
  ART_HEIGHT,
  ART_WIDTH,
  showsSplash,
  Splash,
  SPLASH_EXTRA_ROWS,
  SplashArt,
} from './splash.tsx'
import { BOLD, COLORS } from './theme.ts'

const VIEWS = [
  { id: 'repos', key: '1', title: 'Repos' },
  { id: 'identities', key: '2', title: 'Identities' },
  { id: 'settings', key: '3', title: 'Settings' },
] as const

type HelpEntries = readonly (readonly [string, string])[]

function globalHelp({ global }: Keybindings): HelpEntries {
  return [
    ['1 2 3', 'switch to Repos, Identities or Settings'],
    ['Tab', 'next view (Shift+Tab previous)'],
    [global.help, 'toggle this help'],
    [global.quit, 'quit'],
  ]
}

function viewHelp(
  { repos, identities, ssh_keys, settings }: Keybindings,
  view: (typeof VIEWS)[number]['id'],
): HelpEntries {
  if (view === 'repos') {
    return [
      ['j k ↑ ↓', 'move'],
      ['h l ← →', 'collapse / expand; h on a repository jumps to its folder'],
      ['Enter', 'expand or collapse a folder, assign a repository'],
      [`${repos.top} ${repos.bottom}`, 'top / bottom'],
      [
        `${repos.assign} ${repos.unassign}`,
        'assign / unassign an Identity to the selected folder or repository',
      ],
      [repos.remote, 'assign an Identity to the remote pattern of the selected repository'],
      [repos.alerts_only, 'show only repositories with alerts'],
      [repos.search, 'search repositories'],
      [repos.diagnostics, 'diagnostics: Orphaned Assignments, include order'],
      [repos.rescan, 'rescan'],
    ]
  }

  if (view === 'identities') {
    return [
      ['j k ↑ ↓', 'move'],
      ['Tab ↑ ↓', 'next / previous field in the form (Shift+Tab previous)'],
      ['← →', 'choose the SSH key or signing key in the form'],
      [`${identities.new} ${identities.edit}`, 'new / edit Identity'],
      [identities.delete, 'delete Identity'],
      [identities.make_default, 'make it the Default Identity'],
      [identities.generate_key, 'generate an ed25519 SSH key'],
      [identities.copy_key, 'copy the public key to the clipboard'],
      [identities.ssh_keys, 'SSH keys in ~/.ssh: see which Identity uses each, delete unused ones'],
      [`${ssh_keys.copy} ${ssh_keys.delete}`, 'copy / delete the selected key in SSH keys'],
    ]
  }

  return [
    ['j k ↑ ↓', 'move'],
    [`${settings.add} ${settings.remove}`, 'add / remove a Scan Root'],
    [settings.suggest, 'add the suggested Scan Roots'],
    [settings.import, 'import existing git identity settings'],
    [settings.splash, 'show / hide the splash screen on start'],
  ]
}

/** The header above the body. */
const SHELL_ROWS = 1

/** Width of the widest keybinding line in the help, so the art only joins it when both fit. */
const HELP_WIDTH =
  12 +
  Math.max(
    ...[
      ...VIEWS.flatMap(({ id }) => viewHelp(DEFAULT_KEYBINDINGS, id)),
      ...globalHelp(DEFAULT_KEYBINDINGS),
    ].map(([, description]) => description.length),
  )

function loadKeybindings(core: Core): { bindings: Keybindings; error: string | null } {
  try {
    return { bindings: resolveKeybindings(core.loadKeybindings()), error: null }
  } catch (error) {
    return { bindings: DEFAULT_KEYBINDINGS, error: (error as Error).message }
  }
}

export interface AppProps {
  core: Core
  onQuit: () => void
}

function defaultIdentity(core: Core): Identity | null {
  try {
    const { defaultIdentityId, identities } = core.load()

    return identities.find(({ id }) => id === defaultIdentityId) ?? null
  } catch {
    return null
  }
}

/** Whether an Identity uses a key file that is gone, as after restoring the config on a new Machine. */
function hasMissingKeys(core: Core): boolean {
  try {
    return core.missingSshKeys().length > 0 || core.missingSigningKeys().length > 0
  } catch {
    return false
  }
}

export function App({ core, onQuit }: AppProps) {
  const [offerMissingKeys, setOfferMissingKeys] = useState(() => hasMissingKeys(core))
  const offerDismissedRef = useRef(false)
  const importDismissedRef = useRef(false)

  const [viewIndex, setViewIndex] = useState(() =>
    offerMissingKeys ? VIEWS.findIndex(({ id }) => id === 'identities') : 0,
  )

  const [helpOpen, setHelpOpen] = useState(false)
  const [splashDismissed, setSplashDismissed] = useState(() => !showsSplash(core))
  const [capturing, setCapturing] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [, onConfigChange] = useReducer((version: number) => version + 1, 0)
  const [{ bindings, error: keybindingsError }] = useState(() => loadKeybindings(core))

  useEffect(() => {
    core.apply().catch((error: Error) => setApplyError(error.message))
  }, [core])

  const { width, height } = useTerminalDimensions()
  const splashFits = width >= ART_WIDTH + 2 && height >= ART_HEIGHT + SPLASH_EXTRA_ROWS + SHELL_ROWS
  const splash = splashFits && !splashDismissed

  // Once the splash is hidden for lack of room it stays hidden, so growing the terminal never remounts the views.
  if (!splashFits && !splashDismissed) setSplashDismissed(true)

  const view = VIEWS[viewIndex]!
  const byDefault = defaultIdentity(core)

  useKeyboard((key) => {
    if (splash) setSplashDismissed(true)

    if (capturing) return

    const shown = VIEWS.findIndex((view) => view.key === key.name)

    if (shown >= 0) {
      setViewIndex(shown)

      return
    }

    if (key.name === 'tab') {
      setViewIndex((index) => (index + (key.shift ? -1 : 1) + VIEWS.length) % VIEWS.length)

      return
    }

    if (matchesKey(key, bindings.global.help)) {
      setHelpOpen((open) => !open)

      return
    }

    if (matchesKey(key, bindings.global.quit)) onQuit()
  })

  return (
    <KeybindingsProvider value={bindings}>
      <box flexDirection='column' width='100%' height='100%'>
        <box flexDirection='row' justifyContent='space-between' paddingX={1}>
          <box flexDirection='row' gap={2}>
            {VIEWS.map((candidate, index) => (
              <text
                key={candidate.id}
                fg={index === viewIndex ? COLORS.text : COLORS.muted}
                attributes={index === viewIndex ? BOLD : 0}
              >
                {index === viewIndex
                  ? `[${candidate.key} ${candidate.title}]`
                  : ` ${candidate.key} ${candidate.title} `}
              </text>
            ))}
          </box>
          {byDefault !== null && (
            <text fg={COLORS.muted}>
              {'default: '}
              <span fg={identityColor(byDefault)}>{byDefault.label}</span>
            </text>
          )}
        </box>
        <box flexDirection='column' flexGrow={1}>
          {splash ? (
            <Splash />
          ) : helpOpen ? (
            <HelpOverlay bindings={bindings} view={view} />
          ) : view.id === 'repos' ? (
            <ReposView
              core={core}
              importDismissedRef={importDismissedRef}
              offerDismissedRef={offerDismissedRef}
              onCapture={setCapturing}
              onConfigChange={onConfigChange}
            />
          ) : view.id === 'identities' ? (
            <IdentitiesView
              core={core}
              offerMissingKeys={offerMissingKeys}
              onCapture={setCapturing}
              onConfigChange={onConfigChange}
              onMissingKeysAnswered={() => setOfferMissingKeys(false)}
            />
          ) : (
            <SettingsView core={core} onCapture={setCapturing} onConfigChange={onConfigChange} />
          )}
        </box>
        <box flexDirection='column' paddingX={1}>
          {keybindingsError !== null && (
            <text fg={COLORS.error}>{`Error: ${keybindingsError} (using the default keys)`}</text>
          )}
          {applyError !== null && <text fg={COLORS.error}>{`Error: ${applyError}`}</text>}
        </box>
      </box>
    </KeybindingsProvider>
  )
}

function HelpOverlay({ bindings, view }: { bindings: Keybindings; view: (typeof VIEWS)[number] }) {
  const sections = [
    { title: view.title, keybindings: viewHelp(bindings, view.id) },
    { title: 'Everywhere', keybindings: globalHelp(bindings) },
  ]

  const keysWidth = Math.max(
    9,
    ...sections.flatMap(({ keybindings }) => keybindings.map(([keys]) => keys.length + 1)),
  )

  const { width, height } = useTerminalDimensions()
  const showArt = width >= HELP_WIDTH + ART_WIDTH + 4 && height >= ART_HEIGHT + SHELL_ROWS + 2

  return (
    <box
      flexDirection='row'
      border
      borderColor={COLORS.accent}
      title='Keybindings'
      flexGrow={1}
      paddingX={1}
    >
      <box flexDirection='column' flexGrow={1}>
        {sections.map(({ title, keybindings }) => (
          <box key={title} flexDirection='column' marginBottom={1}>
            <text fg={COLORS.text} attributes={BOLD}>
              {title}
            </text>
            {keybindings.map(([keys, description]) => (
              <text key={description} fg={COLORS.text}>
                {`  ${keys.padEnd(keysWidth)}`}
                <span fg={COLORS.muted}>{description}</span>
              </text>
            ))}
          </box>
        ))}
        <Hints hints={[[bindings.global.help, 'close']]} />
      </box>
      {showArt && (
        <box paddingRight={1}>
          <SplashArt />
        </box>
      )}
    </box>
  )
}
