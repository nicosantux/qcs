import type { Core, ImportPlan, RemoteScope, ScanRoot } from '../core/index.ts'
import type { RGBA } from '@opentui/core'

import { useEffect, useRef, useState } from 'react'

import { useKeyboard } from '@opentui/react'

import { identityColor } from './identity-color.ts'
import { ImportPreview } from './import-preview.tsx'
import { matchesKey, useKeybindings } from './keybindings.ts'
import {
  Confirm,
  Hints,
  Input,
  isDown,
  isUp,
  Line,
  ListRow,
  NoticeLine,
  Panes,
  usePaneRows,
  useWide,
  windowStart,
  type Notice,
  type Pane,
} from './layout.tsx'
import { showsSplash } from './splash.tsx'
import { BOLD, COLORS } from './theme.ts'

const MAX_COMPLETIONS = 8

type Mode =
  | { kind: 'list' }
  | { kind: 'form'; path: string }
  | { kind: 'confirm-delete'; path: string }
  | { kind: 'confirm-import'; plan: ImportPlan }

export interface SettingsViewProps {
  core: Core
  onCapture: (capturing: boolean) => void
  /** Called after an import, which may set the Default Identity. */
  onConfigChange: () => void
}

interface LoadedSettings {
  error: string | null
  remoteScopes: (RemoteScope & { color: RGBA; label: string })[]
  roots: ScanRoot[]
}

function loadRoots(core: Core): LoadedSettings {
  let roots: ScanRoot[]

  try {
    roots = core.loadScanRoots()
  } catch (error) {
    return { error: (error as Error).message, remoteScopes: [], roots: [] }
  }

  try {
    const { identities } = core.load()

    const remoteScopes = core.loadRemoteScopes().map((scope) => {
      const identity = identities.find(({ id }) => id === scope.identityId)

      return {
        ...scope,
        color: identity ? identityColor(identity) : COLORS.error,
        label: identity?.label ?? scope.identityId,
      }
    })

    return { error: null, remoteScopes, roots }
  } catch (error) {
    return { error: (error as Error).message, remoteScopes: [], roots }
  }
}

export function SettingsView({ core, onCapture, onConfigChange }: SettingsViewProps) {
  const { global, repos, settings } = useKeybindings()
  const [loaded, setLoaded] = useState(() => loadRoots(core))
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [error, setError] = useState<string | null>(loaded.error)
  const [notice, setNotice] = useState<Notice | null>(null)
  const suggesting = useRef(false)
  const [showSplash, setShowSplash] = useState(() => showsSplash(core))

  const [completions, setCompletions] = useState<{ paths: string[]; selected: number }>({
    paths: [],
    selected: 0,
  })

  const typedPath = mode.kind === 'form' ? mode.path : null

  useEffect(() => {
    if (typedPath === null) return
    let current = true

    void core.completeDirectory(typedPath).then((paths) => {
      if (current) setCompletions({ paths: paths.slice(0, MAX_COMPLETIONS), selected: 0 })
    })

    return () => {
      current = false
    }
  }, [core, typedPath])

  const { remoteScopes, roots } = loaded
  const current = roots[selected]
  const wide = useWide()
  const [paneRows, measurePanes] = usePaneRows()

  // On narrow terminals the Remote Scopes follow in the same pane, after a blank line and a heading.
  const visibleRoots = Math.max(
    wide ? paneRows : paneRows - 2 - Math.max(remoteScopes.length, 1),
    1,
  )

  const first = windowStart(selected, visibleRoots, roots.length)

  const enter = (next: Mode) => {
    setMode(next)
    onCapture(next.kind !== 'list')
  }

  const run = async (change: Promise<unknown>, success: string) => {
    let failure: Error | null = null

    try {
      await change
    } catch (error) {
      failure = error as Error
    }

    const reloaded = loadRoots(core)

    setLoaded(reloaded)
    setError(failure?.message ?? reloaded.error)
    setSelected((index) => Math.min(index, Math.max(reloaded.roots.length - 1, 0)))

    if (failure === null) {
      enter({ kind: 'list' })
      setNotice({ tone: 'success', text: success })
    }

    return failure === null
  }

  const addSuggested = async () => {
    if (suggesting.current) return
    suggesting.current = true

    try {
      const suggestions = await core.suggestScanRoots()
      const added = await core.addScanRoots(suggestions.map(({ path }) => path))

      setLoaded(loadRoots(core))
      setNotice(
        added === 0
          ? { tone: 'info', text: 'No new suggestions' }
          : {
              tone: 'success',
              text: `Added ${added} suggested Scan Root${added === 1 ? '' : 's'}`,
            },
      )
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      suggesting.current = false
    }
  }

  const startImport = async () => {
    try {
      const plan = await core.previewImport()

      if (plan === null) setNotice({ tone: 'info', text: 'Nothing to import' })
      else enter({ kind: 'confirm-import', plan })
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  const toggleSplash = async () => {
    const show = !showSplash

    if (await run(core.setShowSplash(show), `Splash screen ${show ? 'on' : 'off'}`)) {
      setShowSplash(show)
    }
  }

  const importNow = async () => {
    await run(core.importConfiguration(), 'Imported existing configuration')
    onConfigChange()
  }

  useKeyboard((key) => {
    if (mode.kind === 'confirm-import') {
      if (key.name === 'y' || key.name === 'return') void importNow()
      else if (key.name === 'n' || key.name === 'escape') {
        setError(null)
        enter({ kind: 'list' })
      }

      return
    }

    if (mode.kind === 'form') {
      const { paths, selected: chosen } = completions

      if (key.name === 'escape') {
        setError(null)
        enter({ kind: 'list' })
      } else if (key.name === 'tab' && paths.length > 0) {
        setMode({ kind: 'form', path: paths[chosen]! })
      } else if (key.name === 'down' || key.name === 'up') {
        const step = key.name === 'up' ? -1 : 1

        setCompletions({ paths, selected: (chosen + step + paths.length) % (paths.length || 1) })
      }

      return
    }

    if (mode.kind === 'confirm-delete') {
      if (key.name === 'y') {
        enter({ kind: 'list' })
        void run(
          core.removeScanRoot(mode.path),
          `Removed Scan Root ${current?.displayPath ?? mode.path}`,
        )
      } else if (key.name === 'n' || key.name === 'escape') enter({ kind: 'list' })

      return
    }

    setError(null)
    setNotice(null)

    if (isDown(key)) {
      setSelected((previous) => Math.max(Math.min(previous + 1, roots.length - 1), 0))
    } else if (isUp(key)) setSelected((previous) => Math.max(previous - 1, 0))
    else if (matchesKey(key, settings.add)) {
      enter({ kind: 'form', path: '~/' })
    } else if (matchesKey(key, settings.suggest)) void addSuggested()
    else if (matchesKey(key, settings.import)) void startImport()
    else if (matchesKey(key, settings.splash)) void toggleSplash()
    else if (matchesKey(key, settings.remove) && current) {
      enter({ kind: 'confirm-delete', path: current.path })
    }
  })

  const dialog: Pane | null =
    mode.kind === 'confirm-import'
      ? {
          title: 'Import existing configuration',
          body: (
            <ImportPreview plan={mode.plan} error={error} footer={<Confirm question='Import?' />} />
          ),
        }
      : null

  const popup: Pane | null =
    mode.kind === 'form'
      ? {
          title: 'New Scan Root',
          body: (
            <>
              <box flexDirection='row'>
                <text fg={COLORS.muted}>{'Path '}</text>
                <Input
                  focused
                  value={mode.path}
                  onInput={(path) => setMode({ kind: 'form', path })}
                  onSubmit={() =>
                    void run(core.addScanRoot(mode.path), `Added Scan Root ${mode.path}`)
                  }
                />
              </box>
              {completions.paths.map((path, index) => (
                <ListRow key={path} selected={index === completions.selected}>
                  {path}
                </ListRow>
              ))}
              <Hints
                hints={[
                  ['Tab', 'complete'],
                  ['↑/↓', 'choose'],
                  ['Enter', 'save'],
                  ['Esc', 'cancel'],
                ]}
              />
            </>
          ),
        }
      : mode.kind === 'confirm-delete'
        ? {
            title: 'Remove Scan Root',
            danger: true,
            body: (
              <>
                <Line>{current?.displayPath ?? mode.path}</Line>
                <Confirm danger question='Remove this Scan Root?' />
              </>
            ),
          }
        : null

  const remoteScopeList =
    remoteScopes.length === 0 ? (
      <text fg={COLORS.muted}>
        {`No Remote Scopes. Press ${repos.remote} on a repository in Repos (1).`}
      </text>
    ) : (
      remoteScopes.map(({ pattern, color, label }) => (
        <text key={pattern} wrapMode='none' truncate fg={COLORS.text}>
          {`${pattern}  `}
          <span fg={color}>{label}</span>
        </text>
      ))
    )

  return (
    <Panes
      title='Scan Roots'
      onSizeChange={measurePanes}
      dialog={dialog}
      popup={popup}
      detail={{ title: 'Remote Scopes', body: remoteScopeList }}
      footer={
        <box flexDirection='column' paddingX={1}>
          <NoticeLine notice={error === null ? notice : { tone: 'error', text: error }} />
          {mode.kind === 'list' && (
            <Hints
              hints={[
                ['j/k', 'move'],
                [settings.add, 'add'],
                [settings.suggest, 'suggest'],
                [settings.import, 'import'],
                [settings.remove, 'remove'],
                [settings.splash, showSplash ? 'hide splash' : 'show splash'],
                [global.help, 'help'],
              ]}
            />
          )}
        </box>
      }
    >
      {roots.length === 0 ? (
        <Line>
          {`Settings view: no Scan Roots. Press ${settings.add} to add one or ${settings.suggest} to find some.`}
        </Line>
      ) : (
        roots.slice(first, first + visibleRoots).map((root, offset) => (
          <ListRow key={root.path} selected={first + offset === selected}>
            {root.displayPath}
          </ListRow>
        ))
      )}
      {!wide && (
        <>
          <text fg={COLORS.text} attributes={BOLD} marginTop={1}>
            Remote Scopes
          </text>
          {remoteScopeList}
        </>
      )}
    </Panes>
  )
}
