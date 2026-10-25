import type {
  Core,
  FolderScope,
  Identity,
  ImportPlan,
  OrphanedAssignment,
  RemoteScope,
  RepositoryNode,
  ScanResult,
  ScopeChange,
  SshKeyStatus,
  SuggestedScanRoot,
  TreeNode,
} from '../core/index.ts'
import type { RGBA } from '@opentui/core'

import { useEffect, useRef, useState, type RefObject } from 'react'

import { basename } from 'node:path'

import { useKeyboard } from '@opentui/react'

import {
  AssignmentConflictError,
  realPathOrSelf,
  repositoriesIn,
  signingKeyOf,
} from '../core/index.ts'

import { identityColor } from './identity-color.ts'
import { ImportPreview } from './import-preview.tsx'
import { matchesKey, useKeybindings, type Keybindings } from './keybindings.ts'
import {
  Confirm,
  Field,
  Hints,
  Input,
  isDown,
  isUp,
  Line,
  ListRow,
  Muted,
  NoticeLine,
  Panes,
  Tint,
  usePaneRows,
  windowStart,
  type Notice,
  type Pane,
} from './layout.tsx'
import { BOLD, COLORS } from './theme.ts'

interface RepositoryCells {
  color: RGBA
  identity: string
  /** An SSH key or signing key problem, shown as an error. */
  keyAlert: string
  origin: string
}

interface Row {
  cells: RepositoryCells | null
  color: RGBA
  depth: number
  displayPath: string
  expandable: boolean
  note: string
  parentPath: string | null
  path: string
  /** Every repository at or under the row. */
  repositories: RepositoryNode[]
  repository: RepositoryNode | null
  text: string
}

const ORIGIN_LABELS = {
  'default-identity': 'Default Identity',
  'external-rule': 'External Rule',
  'folder-scope': 'Folder Scope',
  'remote-scope': 'Remote Scope',
  'repo-scope': 'Repo Scope',
  'unknown-identity': 'Unknown Identity',
} as const

const KEY_LABELS = {
  missing: '  SSH key missing',
  none: '',
  stale: '  SSH key missing, git still points to it',
  used: '  SSH key',
} as const

const SIGNING_ALERTS = {
  missing: '  signing key missing',
  stale: '  signing key missing, git still points to it',
} as const

const isKeyAlert = (status: SshKeyStatus): status is 'missing' | 'stale' =>
  status === 'missing' || status === 'stale'

function repositoryCells(node: RepositoryNode): RepositoryCells {
  if (node.identity === null) {
    return {
      color: COLORS.error,
      identity: ORIGIN_LABELS['unknown-identity'],
      keyAlert: '',
      origin: node.unreadable ? '(unreadable)' : (node.email ?? '(no author)'),
    }
  }

  const sshAlert = isKeyAlert(node.sshKey)

  return {
    color: identityColor(node.identity),
    identity: node.identity.label,
    keyAlert: isKeyAlert(node.sshKey)
      ? KEY_LABELS[node.sshKey]
      : isKeyAlert(node.signingKey)
        ? SIGNING_ALERTS[node.signingKey]
        : '',
    origin: `${ORIGIN_LABELS[node.classification]}${sshAlert ? '' : KEY_LABELS[node.sshKey]}`,
  }
}

interface AssignedScope {
  color: RGBA
  identityId: string
  label: string
  repository: boolean
}

interface Diagnostics {
  includeOverridden: boolean
  orphans: OrphanedAssignment[]
}

/** Modes whose dialog asks for an action, shown as a popup instead of in the side pane. */
const POPUP_MODES = new Set<Mode['kind']>([
  'confirm',
  'confirm-repoint',
  'confirm-unassign-remote',
  'pattern',
  'pick',
  'remove-orphan',
  'repoint',
])

type AlertItem = { kind: 'include' } | { kind: 'orphan'; orphan: OrphanedAssignment }

type Mode =
  | { kind: 'browse' }
  | { kind: 'search' }
  | { kind: 'alerts'; selected: number }
  | { kind: 'remove-orphan'; orphan: OrphanedAssignment }
  | { kind: 'repoint'; orphan: OrphanedAssignment; path: string }
  | { existing: FolderScope; kind: 'confirm-repoint'; orphan: OrphanedAssignment; path: string }
  | { kind: 'pattern'; path: string; pattern: string }
  | { kind: 'confirm-unassign-remote'; path: string; pattern: string }
  | {
      kind: 'pick'
      identities: Identity[]
      path: string
      /** Set when the Identity is for a Remote Scope instead of the path. */
      pattern: string | null
      repository: boolean
      selected: number
    }
  | { changes: ScopeChange[]; identity: Identity | null; kind: 'confirm'; path: string }

function failed(failure: unknown): Notice {
  return { tone: 'error', text: (failure as Error).message }
}

function repositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}

function hasAlert({ classification, identity, signingKey, sshKey }: RepositoryNode): boolean {
  return (
    identity === null ||
    classification === 'external-rule' ||
    isKeyAlert(sshKey) ||
    isKeyAlert(signingKey)
  )
}

function prune(nodes: TreeNode[], keep: (node: RepositoryNode) => boolean): TreeNode[] {
  return nodes.flatMap((node): TreeNode[] => {
    if (node.kind === 'repository') return keep(node) ? [node] : []

    const children = prune(node.children, keep)

    return children.length > 0 ? [{ ...node, children }] : []
  })
}

function alertItems({ includeOverridden, orphans }: Diagnostics): AlertItem[] {
  return [
    ...(includeOverridden ? [{ kind: 'include' } as const] : []),
    ...orphans.map((orphan) => ({ kind: 'orphan', orphan }) as const),
  ]
}

/** Keyed by the paths of the scanned rows. */
function loadScopes(core: Core, scanned: ScanResult[]): Map<string, AssignedScope> {
  const { identities } = core.load()

  // `qcs use` saves the real path, while the scan can reach the repository through a symlink.
  const scannedPathByRealPath = new Map(
    scanned
      .flatMap((result) => repositoriesIn(result.children))
      .map(({ path }) => [realPathOrSelf(path), path]),
  )

  const entries = (scopes: FolderScope[], repository: boolean, rowPath = (path: string) => path) =>
    scopes.map(({ path, identityId }): [string, AssignedScope] => {
      const identity = identities.find((candidate) => candidate.id === identityId)

      return [
        rowPath(path),
        {
          color: identity ? identityColor(identity) : COLORS.error,
          identityId,
          label: identity?.label ?? identityId,
          repository,
        },
      ]
    })

  return new Map([
    ...entries(core.loadFolderScopes(), false),
    ...entries(
      core.loadRepoScopes(),
      true,
      (path) => scannedPathByRealPath.get(realPathOrSelf(path)) ?? path,
    ),
  ])
}

function flatten(results: ScanResult[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = []

  const visit = (node: TreeNode, depth: number, parentPath: string, root: ScanResult) => {
    const indent = '  '.repeat(depth)

    const base = {
      depth,
      displayPath: `${root.displayPath}${node.path.slice(root.path.length)}`,
      note: '',
      parentPath,
      path: node.path,
    }

    if (node.kind === 'repository') {
      rows.push({
        ...base,
        cells: repositoryCells(node),
        color: COLORS.text,
        expandable: false,
        repositories: [node],
        repository: node,
        text: `${indent}  ${node.name}`,
      })

      return
    }

    const open = !collapsed.has(node.path)

    rows.push({
      ...base,
      cells: null,
      color: COLORS.text,
      expandable: true,
      repositories: repositoriesIn(node.children),
      repository: null,
      text: `${indent}${open ? '▾' : '▸'} ${node.name}`,
    })

    if (open) for (const child of node.children) visit(child, depth + 1, node.path, root)
  }

  for (const result of results) {
    const open = !collapsed.has(result.path)

    rows.push({
      cells: null,
      color: result.missing ? COLORS.error : COLORS.text,
      depth: 0,
      displayPath: result.displayPath,
      expandable: true,
      note: result.missing
        ? '  (directory not found)'
        : result.children.length === 0
          ? '  (no repositories found)'
          : '',
      parentPath: null,
      path: result.path,
      repositories: repositoriesIn(result.children),
      repository: null,
      text: `${open ? '▾' : '▸'} ${result.displayPath}`,
    })

    if (open) for (const child of result.children) visit(child, 1, result.path, result)
  }

  return rows
}

export interface ReposViewProps {
  core: Core
  /** Lives in the parent so dismissing the offer survives switching views. */
  importDismissedRef: RefObject<boolean>
  /** Same, for the suggested Scan Roots. */
  offerDismissedRef: RefObject<boolean>
  onCapture: (capturing: boolean) => void
  /** Called after the configuration may have changed, such as after an import. */
  onConfigChange: () => void
}

export function ReposView({
  core,
  importDismissedRef,
  offerDismissedRef,
  onCapture,
  onConfigChange,
}: ReposViewProps) {
  const { global, repos, diagnostics: diagnosticsKeys, identities: identityKeys } = useKeybindings()
  const [results, setResults] = useState<ScanResult[] | null>(null)
  const [scopes, setScopes] = useState<ReadonlyMap<string, AssignedScope>>(new Map())
  const [mode, setMode] = useState<Mode>({ kind: 'browse' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const busy = useRef(false)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState(0)
  const [offer, setOffer] = useState<SuggestedScanRoot[]>([])
  const [importOffer, setImportOffer] = useState<ImportPlan | null>(null)

  const [diagnostics, setDiagnostics] = useState<Diagnostics>({
    includeOverridden: false,
    orphans: [],
  })

  const [alertsOnly, setAlertsOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [remoteScopes, setRemoteScopes] = useState<RemoteScope[]>([])
  const [hasIdentities, setHasIdentities] = useState(true)
  const inFlight = useRef(false)
  const rescanQueued = useRef(false)
  const [paneRows, measurePanes] = usePaneRows()

  const noIdentities: Notice = {
    tone: 'info',
    text: `No Identities yet: press 2, then ${identityKeys.new} to create one`,
  }

  const rescan = () => {
    if (inFlight.current) {
      rescanQueued.current = true

      return
    }

    inFlight.current = true
    setScanning(true)
    Promise.all([core.scan(), core.diagnostics()])
      .then(async ([scanned, loadedDiagnostics]) => {
        const loadedScopes = loadScopes(core, scanned)

        const plan = importDismissedRef.current
          ? null
          : await core.previewImport({ firstRunOnly: true })

        const suggestions =
          plan === null && scanned.length === 0 && !offerDismissedRef.current
            ? await core.suggestScanRoots()
            : []

        setImportOffer(plan)
        setOffer(suggestions)
        setResults(scanned)
        setScopes(loadedScopes)
        setRemoteScopes(core.loadRemoteScopes())
        setHasIdentities(core.load().identities.length > 0)
        setDiagnostics(loadedDiagnostics)
        setError(null)
        onConfigChange()
      })
      .catch((failure: Error) => {
        setImportOffer(null)
        setOffer([])
        setError(failure.message)
      })
      .finally(() => {
        inFlight.current = false
        setScanning(false)

        if (rescanQueued.current) {
          rescanQueued.current = false
          rescan()
        }
      })
  }

  // rescan only depends on `core` and refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(rescan, [core])

  const lowerQuery = query.toLowerCase()
  const filtering = alertsOnly || query !== ''

  const shownResults = filtering
    ? (results ?? [])
        .map((result) => ({
          ...result,
          children: prune(
            result.children,
            (node) =>
              (!alertsOnly || hasAlert(node)) &&
              `${node.name}\0${node.path}`.toLowerCase().includes(lowerQuery),
          ),
        }))
        .filter((result) => result.children.length > 0)
    : (results ?? [])

  const alerts = alertItems(diagnostics)
  const rows = flatten(shownResults, collapsed)
  const index = Math.min(selected, Math.max(rows.length - 1, 0))
  const current = rows[index]
  const displayPathOf = (path: string) => rows.find((row) => row.path === path)?.displayPath ?? path

  const toggle = (path: string, collapse: boolean) =>
    setCollapsed((previous) => {
      const next = new Set(previous)

      if (collapse) next.add(path)
      else next.delete(path)

      return next
    })

  const enter = (next: Mode) => {
    setMode(next)
    onCapture(next.kind !== 'browse')
  }

  const guarded = async (action: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true

    try {
      await action()
    } catch (failure) {
      setNotice(failed(failure))
      enter({ kind: 'browse' })
    } finally {
      busy.current = false
    }
  }

  const afterAlertAction = async () => {
    setDiagnostics(await core.diagnostics())
    enter({ kind: 'alerts', selected: 0 })
    rescan()
  }

  const fixInclude = () =>
    guarded(async () => {
      const { backupPath } = await core.moveIncludeToEnd()

      await afterAlertAction()
      setNotice({
        tone: 'success',
        text: `Moved the qcs include to the end${backupPath === null ? '' : ` (backup: ${backupPath})`}`,
      })
    })

  const removeOrphan = ({ displayPath, path, repository }: OrphanedAssignment) =>
    guarded(async () => {
      await (repository ? core.unassignRepository(path) : core.unassignFolder(path))
      await afterAlertAction()
      setNotice({ tone: 'success', text: `Removed the Assignment of ${displayPath}` })
    })

  const repointOrphan = (orphan: OrphanedAssignment, newPath: string, replace = false) =>
    guarded(async () => {
      try {
        await (orphan.repository
          ? core.repointRepository(orphan.path, newPath, { replace })
          : core.repointFolder(orphan.path, newPath, { replace }))
      } catch (failure) {
        if (failure instanceof AssignmentConflictError) {
          enter({ kind: 'confirm-repoint', existing: failure.existing, orphan, path: newPath })
        } else {
          setNotice(failed(failure))
          enter({ kind: 'repoint', orphan, path: newPath })
        }

        return
      }

      await afterAlertAction()
      setNotice({ tone: 'success', text: `Re-pointed ${orphan.displayPath} to ${newPath}` })
    })

  const startAssignment = (path: string, repository: boolean, pattern: string | null = null) => {
    let identities: Identity[]

    try {
      identities = core.load().identities
    } catch (failure) {
      setNotice(failed(failure))

      return
    }

    if (identities.length === 0) {
      setNotice(noIdentities)

      return
    }

    const assigned = scopes.get(path)?.identityId

    const selected = Math.max(
      identities.findIndex((identity) => identity.id === assigned),
      0,
    )

    enter({ kind: 'pick', identities, path, pattern, repository, selected })
  }

  const startConfirmation = (path: string, identity: Identity | null) =>
    guarded(async () => {
      setPreviewing(true)

      try {
        const changes = await core.previewFolderAssignment(path, identity?.id ?? null)

        enter({ kind: 'confirm', path, identity, changes })
      } finally {
        setPreviewing(false)
      }
    })

  const confirm = ({ changes, path, identity }: Extract<Mode, { kind: 'confirm' }>) =>
    guarded(async () => {
      await (identity === null ? core.unassignFolder(path) : core.assignFolder(path, identity.id))
      enter({ kind: 'browse' })
      setNotice({
        tone: 'success',
        text: `${
          identity === null
            ? `Removed the Assignment of ${displayPathOf(path)}`
            : `Assigned "${identity.label}" to ${displayPathOf(path)}`
        }${changes.length > 0 ? ` (${repositoryCount(changes.length)} changed)` : ''}`,
      })
      rescan()
    })

  /** A single repository is assigned right away: there is no wider impact to preview. */
  const assignRepository = (path: string, identity: Identity | null) =>
    guarded(async () => {
      await (identity === null
        ? core.unassignRepository(path)
        : core.assignRepository(path, identity.id))
      enter({ kind: 'browse' })
      setNotice({
        tone: 'success',
        text:
          identity === null
            ? `Removed the Assignment of ${displayPathOf(path)}`
            : `Assigned "${identity.label}" to ${displayPathOf(path)}`,
      })
      rescan()
    })

  const startRemoteScope = (path: string) =>
    guarded(async () => {
      const unavailable = await core.remoteScopesUnavailable()

      if (unavailable !== null) {
        setNotice({ tone: 'error', text: unavailable })

        return
      }

      enter({ kind: 'pattern', path, pattern: await core.suggestRemotePattern(path) })
    })

  const assignRemote = (pattern: string, identity: Identity) =>
    guarded(async () => {
      await core.assignRemote(pattern, identity.id)
      enter({ kind: 'browse' })
      setNotice({ tone: 'success', text: `Assigned "${identity.label}" to ${pattern}` })
      rescan()
    })

  const unassignRemote = (pattern: string) =>
    guarded(async () => {
      await core.unassignRemote(pattern)
      enter({ kind: 'browse' })
      setNotice({ tone: 'success', text: `Removed the Remote Scope ${pattern}` })
      rescan()
    })

  const acceptImport = () =>
    guarded(async () => {
      await core.importConfiguration()
      setImportOffer(null)
      setNotice({ tone: 'success', text: 'Imported existing configuration' })
      rescan()
    })

  const acceptOffer = () =>
    guarded(async () => {
      const added = await core.addScanRoots(offer.map(({ path }) => path))

      setOffer([])
      setNotice({ tone: 'success', text: `Added ${added} Scan Root${added === 1 ? '' : 's'}` })
      rescan()
    })

  useKeyboard((key) => {
    if (importOffer !== null) {
      if (key.name === 'return') void acceptImport()
      else if (key.name === 'escape') {
        importDismissedRef.current = true
        setNotice(null)
        setImportOffer(null)
        rescan()
      }

      return
    }

    if (offer.length > 0) {
      if (key.name === 'return') void acceptOffer()
      else if (key.name === 'escape') {
        offerDismissedRef.current = true
        setOffer([])
      }

      return
    }

    if (mode.kind === 'search') {
      if (key.name === 'escape') {
        setQuery('')
        enter({ kind: 'browse' })
      }

      return
    }

    if (mode.kind === 'alerts') {
      const item = alerts[mode.selected]

      if (key.name === 'escape' || matchesKey(key, diagnosticsKeys.close)) {
        setNotice(null)
        enter({ kind: 'browse' })
      } else if (isDown(key)) {
        setMode({ ...mode, selected: Math.min(mode.selected + 1, alerts.length - 1) })
      } else if (isUp(key)) setMode({ ...mode, selected: Math.max(mode.selected - 1, 0) })
      else if (item?.kind === 'include' && key.name === 'return') void fixInclude()
      else if (item?.kind === 'orphan' && matchesKey(key, diagnosticsKeys.remove)) {
        enter({ kind: 'remove-orphan', orphan: item.orphan })
      } else if (item?.kind === 'orphan' && matchesKey(key, diagnosticsKeys.repoint)) {
        setNotice(null)
        enter({ kind: 'repoint', orphan: item.orphan, path: '' })
      }

      return
    }

    if (mode.kind === 'remove-orphan') {
      if (key.name === 'y') void removeOrphan(mode.orphan)
      else if (key.name === 'n' || key.name === 'escape') enter({ kind: 'alerts', selected: 0 })

      return
    }

    if (mode.kind === 'confirm-repoint') {
      if (key.name === 'y') void repointOrphan(mode.orphan, mode.path, true)
      else if (key.name === 'n' || key.name === 'escape') {
        enter({ kind: 'repoint', orphan: mode.orphan, path: mode.path })
      }

      return
    }

    if (mode.kind === 'repoint') {
      if (key.name === 'escape') {
        setNotice(null)
        enter({ kind: 'alerts', selected: 0 })
      }

      return
    }

    if (mode.kind === 'pick') {
      if (key.name === 'escape') enter({ kind: 'browse' })
      else if (isDown(key)) {
        setMode({ ...mode, selected: Math.min(mode.selected + 1, mode.identities.length - 1) })
      } else if (isUp(key)) setMode({ ...mode, selected: Math.max(mode.selected - 1, 0) })
      else if (key.name === 'return') {
        const identity = mode.identities[mode.selected]!

        if (mode.pattern !== null) void assignRemote(mode.pattern, identity)
        else if (mode.repository) void assignRepository(mode.path, identity)
        else void startConfirmation(mode.path, identity)
      }

      return
    }

    if (mode.kind === 'pattern') {
      if (key.name === 'escape') enter({ kind: 'browse' })
      else if (key.name === 'd' && key.ctrl) {
        enter({ kind: 'confirm-unassign-remote', path: mode.path, pattern: mode.pattern })
      }

      return
    }

    if (mode.kind === 'confirm-unassign-remote') {
      if (key.name === 'y') void unassignRemote(mode.pattern)
      else if (key.name === 'n' || key.name === 'escape') {
        enter({ kind: 'pattern', path: mode.path, pattern: mode.pattern })
      }

      return
    }

    if (mode.kind === 'confirm') {
      // Removing an Assignment needs an explicit y.
      if (key.name === 'y' || (key.name === 'return' && mode.identity !== null)) void confirm(mode)
      else if (key.name === 'n' || key.name === 'escape') enter({ kind: 'browse' })

      return
    }

    setNotice(null)

    if (matchesKey(key, repos.assign) && current) {
      startAssignment(current.path, !current.expandable)
    } else if (matchesKey(key, repos.remote) && current && !current.expandable) {
      void startRemoteScope(current.path)
    } else if (matchesKey(key, repos.unassign) && current && scopes.has(current.path)) {
      if (scopes.get(current.path)!.repository) void assignRepository(current.path, null)
      else void startConfirmation(current.path, null)
    } else if (isDown(key)) {
      setSelected((previous) => Math.max(Math.min(previous + 1, rows.length - 1), 0))
    } else if (isUp(key)) {
      setSelected((previous) => Math.max(Math.min(previous, rows.length - 1) - 1, 0))
    } else if (key.name === 'return' && current) {
      if (current.expandable) toggle(current.path, !collapsed.has(current.path))
      else startAssignment(current.path, true)
    } else if (matchesKey(key, repos.top)) setSelected(0)
    else if (matchesKey(key, repos.bottom)) setSelected(Math.max(rows.length - 1, 0))
    else if (matchesKey(key, repos.rescan)) rescan()
    else if (matchesKey(key, repos.alerts_only)) setAlertsOnly((only) => !only)
    else if (matchesKey(key, repos.diagnostics)) enter({ kind: 'alerts', selected: 0 })
    else if (matchesKey(key, repos.search)) enter({ kind: 'search' })
    else if (key.name === 'escape' && query !== '') setQuery('')
    else if ((key.name === 'l' || key.name === 'right') && current?.expandable) {
      toggle(current.path, false)
    } else if ((key.name === 'h' || key.name === 'left') && current) {
      if (current.expandable && !collapsed.has(current.path)) toggle(current.path, true)
      else if (current.parentPath !== null) {
        setSelected(rows.findIndex((row) => row.path === current.parentPath))
      }
    }
  })

  const dialog = ((): Pane | null => {
    if (importOffer !== null) {
      return {
        title: 'Import existing configuration',
        body: (
          <ImportPreview
            plan={importOffer}
            error={notice?.tone === 'error' ? notice.text : null}
            footer={
              <Hints
                hints={[
                  ['Enter', 'import'],
                  ['Esc', 'skip'],
                ]}
              />
            }
            rows={paneRows}
          />
        ),
      }
    }

    if (offer.length > 0) {
      const shown = offer.slice(0, Math.max(paneRows - 3, 1))

      return {
        title: 'Suggested Scan Roots',
        body: (
          <>
            {shown.map(({ path, displayPath }) => (
              <Line key={path}>{displayPath}</Line>
            ))}
            {offer.length > shown.length && (
              <text fg={COLORS.muted}>{`...and ${offer.length - shown.length} more`}</text>
            )}
            <NoticeLine notice={notice} />
            <Hints
              hints={[
                ['Enter', 'add all'],
                ['Esc', 'dismiss'],
              ]}
            />
          </>
        ),
      }
    }

    if (mode.kind === 'pattern') {
      return {
        title: 'New Remote Scope',
        body: (
          <>
            <Line>{displayPathOf(mode.path)}</Line>
            <box flexDirection='row'>
              <text fg={COLORS.muted}>{'Pattern '}</text>
              <Input
                focused
                value={mode.pattern}
                onInput={(pattern) =>
                  setMode((previous) =>
                    previous.kind === 'pattern' ? { ...previous, pattern } : previous,
                  )
                }
                onSubmit={() => startAssignment(mode.path, true, mode.pattern)}
              />
            </box>
            <Hints
              hints={[
                ['Enter', 'choose Identity'],
                ['Ctrl+D', 'remove this pattern'],
                ['Esc', 'cancel'],
              ]}
            />
          </>
        ),
      }
    }

    if (mode.kind === 'confirm-unassign-remote') {
      return {
        title: 'Remove Remote Scope',
        danger: true,
        body: (
          <>
            <Line>{mode.pattern}</Line>
            <Confirm danger question='Remove this Remote Scope?' />
          </>
        ),
      }
    }

    if (mode.kind === 'pick' || mode.kind === 'confirm') {
      return assignmentDialog(mode, paneRows, previewing, displayPathOf(mode.path))
    }

    if (mode.kind === 'repoint') {
      return {
        title: 'Re-point Assignment',
        body: (
          <>
            <Line>{mode.orphan.displayPath}</Line>
            <box flexDirection='row'>
              <text fg={COLORS.muted}>{'New path '}</text>
              <Input
                focused
                value={mode.path}
                onInput={(path) =>
                  setMode((previous) =>
                    previous.kind === 'repoint' ? { ...previous, path } : previous,
                  )
                }
                onSubmit={() => void repointOrphan(mode.orphan, mode.path)}
              />
            </box>
            <NoticeLine notice={notice} />
            <Hints
              hints={[
                ['Enter', 're-point'],
                ['Esc', 'cancel'],
              ]}
            />
          </>
        ),
      }
    }

    if (
      mode.kind === 'alerts' ||
      mode.kind === 'remove-orphan' ||
      mode.kind === 'confirm-repoint'
    ) {
      return alertsDialog(alerts, mode, notice, diagnosticsKeys)
    }

    return null
  })()

  const floating = importOffer !== null || offer.length > 0 || POPUP_MODES.has(mode.kind)

  const top = windowStart(index, paneRows, rows.length)
  const nameWidth = Math.max(0, ...rows.map((row) => (row.cells ? row.text.length : 0)))
  const identityWidth = Math.max(0, ...rows.map((row) => row.cells?.identity.length ?? 0))
  const tree = error === null && results !== null && results.length > 0

  return (
    <Panes
      title={rows.length > 0 ? `Repos ${index + 1}/${rows.length}` : 'Repos'}
      dialog={floating ? null : dialog}
      popup={floating ? dialog : null}
      detail={
        tree && current
          ? {
              title: current.repository?.name ?? basename(current.displayPath),
              body: (
                <RowDetail remoteScopes={remoteScopes} row={current} rows={rows} scopes={scopes} />
              ),
            }
          : null
      }
      onSizeChange={measurePanes}
      footer={
        tree &&
        dialog === null && (
          <box flexDirection='column' paddingX={1}>
            <NoticeLine notice={notice} />
            {!hasIdentities && notice?.text !== noIdentities.text && (
              <NoticeLine notice={noIdentities} />
            )}
            {scanning ? (
              <text fg={COLORS.muted}>Scanning...</text>
            ) : (
              <Hints
                hints={[
                  ['j/k', 'move'],
                  ['h/l', 'tree'],
                  [`${repos.top}/${repos.bottom}`, 'top/bottom'],
                  [repos.rescan, 'rescan'],
                  [repos.assign, 'assign'],
                  [repos.remote, 'remote'],
                  [repos.unassign, 'unassign'],
                ]}
              />
            )}
            {mode.kind === 'search' ? (
              <box flexDirection='row'>
                <text fg={COLORS.text} attributes={BOLD}>
                  {'/'}
                </text>
                <Input
                  focused
                  value={query}
                  onInput={setQuery}
                  onSubmit={() => enter({ kind: 'browse' })}
                />
              </box>
            ) : (
              <Hints
                hints={[
                  [repos.alerts_only, alertsOnly ? 'show all' : 'alerts only'],
                  [repos.search, `search${query === '' ? '' : ` "${query}" (Esc clears)`}`],
                  alerts.length > 0
                    ? [repos.diagnostics, `diagnostics (${alerts.length})`, COLORS.warning]
                    : [repos.diagnostics, 'diagnostics'],
                  [global.help, 'help'],
                ]}
              />
            )}
          </box>
        )
      }
    >
      {error !== null ? (
        <text fg={COLORS.error}>{`Error: ${error}`}</text>
      ) : results === null ? (
        <text fg={COLORS.muted}>Scanning...</text>
      ) : results.length === 0 ? (
        <Line>Repos view: no Scan Roots yet. Add one in Settings (3).</Line>
      ) : (
        <>
          {rows.slice(top, top + paneRows).map((row, offset) => (
            <ListRow key={row.path} selected={top + offset === index}>
              <Tint color={row.color}>{row.cells ? row.text.padEnd(nameWidth) : row.text}</Tint>
              {row.cells && (
                <Tint
                  color={row.cells.color}
                >{`  ${row.cells.identity.padEnd(identityWidth)}`}</Tint>
              )}
              {row.cells && <Muted>{`  ${row.cells.origin}`}</Muted>}
              {row.cells && row.cells.keyAlert !== '' && (
                <Tint color={COLORS.error}>{row.cells.keyAlert}</Tint>
              )}
              {scopes.has(row.path) && row.expandable && (
                <Tint
                  color={scopes.get(row.path)!.color}
                >{`  [${scopes.get(row.path)!.label}]`}</Tint>
              )}
              {row.note !== '' && <Muted>{row.note}</Muted>}
            </ListRow>
          ))}
          {rows.length === 0 && filtering && <text fg={COLORS.muted}>No repositories match.</text>}
        </>
      )}
    </Panes>
  )
}

interface RowDetailProps {
  remoteScopes: RemoteScope[]
  row: Row
  rows: Row[]
  scopes: ReadonlyMap<string, AssignedScope>
}

function RowDetail({ remoteScopes, row, rows, scopes }: RowDetailProps) {
  const node = row.repository

  if (node === null) {
    const assigned = scopes.get(row.path)
    const counts = new Map<string, { color: RGBA; count: number }>()

    for (const repository of row.repositories) {
      const { color, identity } = repositoryCells(repository)

      counts.set(identity, { color, count: (counts.get(identity)?.count ?? 0) + 1 })
    }

    return (
      <>
        <Field label='Path'>{row.displayPath}</Field>
        <Field label='Assigned'>
          {assigned ? <span fg={assigned.color}>{assigned.label}</span> : '(none)'}
        </Field>
        <Field label='Repos'>{String(row.repositories.length)}</Field>
        {[...counts].map(([identity, { color, count }]) => (
          <Field key={identity} label=''>
            <span fg={color}>{identity}</span>
            {`  ${count}`}
          </Field>
        ))}
      </>
    )
  }

  const cells = repositoryCells(node)

  return (
    <>
      <Field label='Path'>{row.displayPath}</Field>
      <Field label='Identity'>
        <span fg={cells.color}>{cells.identity}</span>
      </Field>
      <Field label='Author'>
        {node.identity === null ? cells.origin : `${node.identity.name} <${node.identity.email}>`}
      </Field>
      {node.identity !== null && (
        <>
          <Field label='Origin'>{ORIGIN_LABELS[node.classification]}</Field>
          {originSource(node, row, rows, scopes, remoteScopes) !== null && (
            <Field label=''>{originSource(node, row, rows, scopes, remoteScopes)!}</Field>
          )}
          <Field label='SSH key'>
            {node.sshKey === 'used' ? (
              basename(node.identity.sshKey ?? '')
            ) : node.sshKey === 'none' ? (
              '(none)'
            ) : (
              <span fg={COLORS.error}>missing</span>
            )}
          </Field>
          {signingKeyOf(node.identity) !== null && (
            <Field label='Signing'>
              {node.signingKey === 'used' ? (
                basename(signingKeyOf(node.identity)!)
              ) : node.signingKey === 'none' ? (
                'not in effect'
              ) : (
                <span fg={COLORS.error}>missing</span>
              )}
            </Field>
          )}
        </>
      )}
    </>
  )
}

/** Where the Effective Identity of a repository comes from, when the tree can tell. */
function originSource(
  node: RepositoryNode,
  row: Row,
  rows: Row[],
  scopes: ReadonlyMap<string, AssignedScope>,
  remoteScopes: RemoteScope[],
): string | null {
  if (node.classification === 'external-rule') return 'set outside qcs'

  if (node.classification === 'remote-scope') {
    const patterns = remoteScopes
      .filter(({ identityId }) => identityId === node.identity?.id)
      .map(({ pattern }) => pattern)

    return patterns.length > 0 ? patterns.join(', ') : null
  }

  if (node.classification !== 'folder-scope') return null

  const byPath = new Map(rows.map((candidate) => [candidate.path, candidate]))

  for (let path = row.parentPath; path !== null; path = byPath.get(path)?.parentPath ?? null) {
    const scope = scopes.get(path)

    if (scope && !scope.repository) return byPath.get(path)?.displayPath ?? path
  }

  return null
}

function assignmentDialog(
  mode: Extract<Mode, { kind: 'confirm' | 'pick' }>,
  paneRows: number,
  previewing: boolean,
  displayPath: string,
): Pane {
  if (mode.kind === 'pick') {
    const visible = Math.max(paneRows - 2, 1)
    const labelWidth = Math.max(...mode.identities.map(({ label }) => label.length))

    const first = windowStart(mode.selected, visible, mode.identities.length)

    return {
      title: 'Assign an Identity',
      body: (
        <>
          <Line>{mode.pattern ?? displayPath}</Line>
          {mode.identities.slice(first, first + visible).map((identity, offset) => (
            <ListRow key={identity.id} selected={first + offset === mode.selected}>
              <Tint color={identityColor(identity)}>{identity.label.padEnd(labelWidth)}</Tint>
              <Muted>{`  ${identity.name} <${identity.email}>`}</Muted>
            </ListRow>
          ))}
          {previewing ? (
            <text fg={COLORS.muted}>Calculating preview...</text>
          ) : (
            <Hints
              hints={[
                ['j/k', 'move'],
                ['Enter', mode.repository ? 'assign' : 'preview'],
                ['Esc', 'cancel'],
              ]}
            />
          )}
        </>
      ),
    }
  }

  const shown = mode.changes.slice(0, Math.max(paneRows - 3, 1))
  const hidden = mode.changes.length - shown.length

  return {
    title: mode.identity === null ? 'Remove Assignment' : `Assign "${mode.identity.label}"`,
    danger: mode.identity === null,
    body: (
      <>
        <Line>{displayPath}</Line>
        {mode.changes.length === 0 && <Line>No repository changes its Effective Identity.</Line>}
        {shown.map((change) => (
          <text key={change.path} wrapMode='none' truncate fg={COLORS.text}>
            {`${change.name}  `}
            <IdentityName identity={change.current} />
            <Muted>{' -> '}</Muted>
            <IdentityName identity={change.resulting} />
          </text>
        ))}
        {hidden > 0 && <text fg={COLORS.muted}>{`...and ${hidden} more`}</text>}
        <Confirm danger={mode.identity === null} question='Apply?' />
      </>
    ),
  }
}

function alertsDialog(
  alerts: AlertItem[],
  mode: Extract<Mode, { kind: 'alerts' | 'confirm-repoint' | 'remove-orphan' }>,
  notice: Notice | null,
  bindings: Keybindings['diagnostics'],
): Pane {
  if (mode.kind === 'confirm-repoint') {
    return {
      title: 'Replace Assignment',
      danger: true,
      body: (
        <>
          <Line>{`${mode.existing.displayPath}  [${mode.existing.identityId}]`}</Line>
          <Confirm
            danger
            question={`Replace it with the Assignment of ${mode.orphan.displayPath} [${mode.orphan.identityId}]?`}
          />
        </>
      ),
    }
  }

  if (mode.kind === 'remove-orphan') {
    return {
      title: 'Remove Assignment',
      danger: true,
      body: (
        <>
          <Line>{`${mode.orphan.displayPath}  [${mode.orphan.identityId}]`}</Line>
          <Confirm danger question='Remove this Assignment?' />
        </>
      ),
    }
  }

  return {
    title: 'Diagnostics',
    body: (
      <>
        {alerts.length === 0 && <Line>Nothing to fix.</Line>}
        {alerts.map((item, index) => (
          <text
            key={item.kind === 'include' ? 'include' : item.orphan.path}
            fg={index === mode.selected ? COLORS.text : COLORS.muted}
            attributes={index === mode.selected ? BOLD : 0}
          >
            {`${index === mode.selected ? '>' : ' '} ${
              item.kind === 'include'
                ? 'Global git config sets identity after the qcs include, so it overrides every Assignment'
                : `Orphaned Assignment: ${item.orphan.displayPath} (${item.orphan.repository ? 'Repo' : 'Folder'} Scope, ${item.orphan.identityId}) no longer exists`
            }`}
          </text>
        ))}
        <NoticeLine notice={notice} />
        <Hints
          hints={
            alerts.length === 0
              ? [['Esc', 'close']]
              : [
                  ['j/k', 'move'],
                  ...(alerts[mode.selected]?.kind === 'include'
                    ? ([['Enter', 'move include to the end (backup)']] as const)
                    : ([
                        [bindings.repoint, 're-point'],
                        [bindings.remove, 'remove'],
                      ] as const)),
                  ['Esc', 'close'],
                ]
          }
        />
      </>
    ),
  }
}

function IdentityName({ identity }: { identity: Identity | null }) {
  if (identity === null) return <Muted>(none)</Muted>

  return <span fg={identityColor(identity)}>{identity.label}</span>
}
