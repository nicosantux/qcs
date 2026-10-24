import type {
  Core,
  IdentitiesConfig,
  Identity,
  IdentityInput,
  KeyPurpose,
  RepositoryNode,
} from '../core/index.ts'

import { useEffect, useRef, useState } from 'react'

import { basename } from 'node:path'

import { useKeyboard } from '@opentui/react'

import { DELETE_DEFAULT_IDENTITY_MESSAGE, SIGN_WITH_SSH_KEY, signingKeyOf } from '../core/index.ts'

import { identityColor } from './identity-color.ts'
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
  useWide,
  windowStart,
} from './layout.tsx'
import { BOLD, COLORS } from './theme.ts'

const FIELDS = [
  { key: 'label', title: 'Label' },
  { key: 'name', title: 'Name' },
  { key: 'email', title: 'Email' },
] as const

const NAME_FIELD = FIELDS.findIndex(({ key }) => key === 'name')
const KEY_FIELD = FIELDS.length
const SIGNING_FIELD = KEY_FIELD + 1
const FIELD_COUNT = SIGNING_FIELD + 1

const NEW_KEY = Symbol('new key')

type KeyChoice = string | typeof NEW_KEY | null

/** Steps through `options` from `current`, wrapping around. */
function stepChoice(options: readonly KeyChoice[], current: KeyChoice, step: number): KeyChoice {
  const index = Math.max(options.indexOf(current), 0)

  return options[(index + step + options.length) % options.length]!
}

/** Signing choices: none, the SSH key when there is one, a new key, and the current dedicated key. */
function signingOptions(form: FormMode): KeyChoice[] {
  const hasSshKey = form.newKey || form.values.sshKey !== null

  return [null, ...(hasSshKey ? [SIGN_WITH_SSH_KEY] : []), NEW_KEY, ...form.signingKeys]
}

/** An author name of another Identity starting with `typed`; the Default Identity's while nothing is typed. */
function nameSuggestion(config: IdentitiesConfig, typed: string): string | null {
  const names = [...new Set(config.identities.map(({ name }) => name))]

  if (typed === '') {
    return (
      config.identities.find(({ id }) => id === config.defaultIdentityId)?.name ?? names[0] ?? null
    )
  }

  return (
    names.find((name) => name !== typed && name.toLowerCase().startsWith(typed.toLowerCase())) ??
    null
  )
}

const UPLOAD_HINT = 'add its .pub to your Git host as a signing key'

/** The form field a validation message from core is about. */
function invalidField(message: string): number | null {
  if (message.startsWith('Label')) return 0
  if (message.startsWith('Name')) return 1
  if (message.includes('email')) return 2

  return null
}

const PRINTABLE = /^[^\p{Cc}]+$/u

/** A key to generate for an Identity; `value` prefills its file name. */
interface KeyJob {
  id: string
  purpose: KeyPurpose
  value: string
}

/** A key file an Identity uses that is gone on this Machine. */
interface MissingKey {
  id: string
  path: string
  purpose: KeyPurpose
}

type Mode =
  | { kind: 'list' }
  | {
      kind: 'form'
      editingId: string | null
      field: number
      invalid: number | null
      /** The key choices; the current key stays selectable even when its file is gone. */
      keys: string[]
      /** Generate a key for the Identity once it is saved, instead of the chosen `sshKey`. */
      newKey: boolean
      /** Generate a signing key once saved, instead of the chosen `signingKey`. */
      newSigningKey: boolean
      /** The current dedicated signing key, so it stays selectable. */
      signingKeys: string[]
      values: IdentityInput & { signingKey: string | null; sshKey: string | null }
    }
  | { kind: 'confirm-delete'; assignedTo: string[]; id: string }
  | (KeyJob & {
      kind: 'key-name'
      /** Keys to generate after this one. */
      next: KeyJob[]
    })
  | {
      kind: 'keys'
      /** Waiting for y/n to delete the selected key. */
      confirm: boolean
      keys: string[]
      selected: number
    }
  | {
      kind: 'passphrase'
      /** The passphrase typed the first time, once it is being repeated. */
      first: string | null
      id: string
      /** The key file name; empty for the default name. */
      name: string
      next: KeyJob[]
      purpose: KeyPurpose
      value: string
    }
  | { kind: 'missing-keys'; missing: MissingKey[] }

export interface IdentitiesViewProps {
  core: Core
  /** Offer to generate the keys missing on this Machine until `onMissingKeysAnswered`. */
  offerMissingKeys: boolean
  onCapture: (capturing: boolean) => void
  /** Called after a change, which may set another Default Identity. */
  onConfigChange: () => void
  onMissingKeysAnswered: () => void
}

/** A Folder, Repo or Remote Scope of an Identity, as shown in its detail. */
interface Assignment {
  identityId: string
  text: string
}

interface LoadedConfig {
  assignments: Assignment[]
  config: IdentitiesConfig
  error: string | null
  missingKeys: string[]
  missingSigningKeys: string[]
}

function loadAssignments(core: Core): Assignment[] {
  try {
    return [
      ...core
        .loadFolderScopes()
        .map(({ displayPath, identityId }) => ({ identityId, text: displayPath })),
      ...core
        .loadRepoScopes()
        .map(({ displayPath, identityId }) => ({ identityId, text: `${displayPath} (repo)` })),
      ...core.loadRemoteScopes().map(({ pattern, identityId }) => ({ identityId, text: pattern })),
    ]
  } catch {
    return []
  }
}

/** The missing key files, once each even when several Identities share one. */
function missingKeyFiles({ config, missingKeys, missingSigningKeys }: LoadedConfig): MissingKey[] {
  const seen = new Set<string>()

  return config.identities
    .flatMap(({ id, signingKey, sshKey }): MissingKey[] => [
      ...(missingKeys.includes(id) ? [{ id, path: sshKey!, purpose: 'ssh' as const }] : []),
      ...(missingSigningKeys.includes(id) && signingKey !== SIGN_WITH_SSH_KEY
        ? [{ id, path: signingKey!, purpose: 'signing' as const }]
        : []),
    ])
    .filter(({ path }) => !seen.has(path) && seen.add(path))
}

function loadConfig(core: Core): LoadedConfig {
  try {
    return {
      assignments: loadAssignments(core),
      config: core.load(),
      error: null,
      missingKeys: core.missingSshKeys(),
      missingSigningKeys: core.missingSigningKeys(),
    }
  } catch (error) {
    return {
      assignments: [],
      config: { identities: [], defaultIdentityId: null },
      error: (error as Error).message,
      missingKeys: [],
      missingSigningKeys: [],
    }
  }
}

export function IdentitiesView({
  core,
  offerMissingKeys,
  onCapture,
  onConfigChange,
  onMissingKeysAnswered,
}: IdentitiesViewProps) {
  const { global, identities: bindings, ssh_keys: keyBindings } = useKeybindings()
  const [loaded, setLoaded] = useState(() => loadConfig(core))
  const [selected, setSelected] = useState(0)

  // Like the Repos view offers, the missing keys offer leaves view switching to the App.
  const [mode, setMode] = useState<Mode>(() => {
    const missing = offerMissingKeys ? missingKeyFiles(loaded) : []

    return missing.length > 0 ? { kind: 'missing-keys', missing } : { kind: 'list' }
  })

  const [error, setError] = useState<string | null>(loaded.error)
  const [notice, setNotice] = useState<string | null>(null)
  const [reach, setReach] = useState<ReadonlyMap<string, RepositoryNode[]> | null>(null)

  const reachRequest = useRef(0)

  const refreshReach = () => {
    const request = ++reachRequest.current

    const settle = (next: ReadonlyMap<string, RepositoryNode[]> | null) => {
      if (request === reachRequest.current) setReach(next)
    }

    core.repositoriesByIdentity().then(settle, () => settle(null))
  }

  useEffect(refreshReach, [core])

  const { config, missingKeys, missingSigningKeys } = loaded
  const current = config.identities[selected]
  const [paneRows, measurePanes] = usePaneRows()

  const enter = (next: Mode) => {
    setMode(next)
    onCapture(next.kind !== 'list')
  }

  /** Applies a change and reports `success`, or returns the failure when nothing was saved. */
  const run = async (
    change: Promise<unknown>,
    success: (next: IdentitiesConfig) => string,
    selectLast = false,
  ): Promise<Error | null> => {
    let failure: Error | null = null

    try {
      await change
    } catch (error) {
      failure = error as Error
    }

    const reloaded = loadConfig(core)
    const saved = JSON.stringify(reloaded.config) !== JSON.stringify(config)

    setLoaded(reloaded)
    refreshReach()
    onConfigChange()
    setError(failure?.message ?? reloaded.error)
    setNotice(failure === null ? success(reloaded.config) : null)
    setSelected((index) =>
      selectLast && saved
        ? reloaded.config.identities.length - 1
        : Math.min(index, Math.max(reloaded.config.identities.length - 1, 0)),
    )

    if (failure === null || saved) enter({ kind: 'list' })

    return saved ? null : failure
  }

  const submitForm = async (form: Extract<Mode, { kind: 'form' }>) => {
    const { label } = form.values

    // A new key replaces the attached one only once generated, so cancelling keeps the current key.
    const kept = (key: 'signingKey' | 'sshKey') =>
      form.editingId === null ? null : (current?.[key] ?? null)

    const values = {
      ...form.values,
      ...(form.newKey ? { sshKey: kept('sshKey') } : {}),
      ...(form.newSigningKey ? { signingKey: kept('signingKey') } : {}),
    }

    const signsWithNewSshKey = form.newKey && values.signingKey === SIGN_WITH_SSH_KEY

    let savedId = form.editingId

    const failure = await run(
      form.editingId === null
        ? core.createIdentity(values)
        : core.editIdentity(form.editingId, values),
      (next) => {
        savedId ??= next.identities.at(-1)?.id ?? null

        const startsSigning =
          values.signingKey === SIGN_WITH_SSH_KEY &&
          values.sshKey !== null &&
          (form.editingId === null || current?.signingKey !== SIGN_WITH_SSH_KEY)

        return `${
          form.editingId !== null
            ? `Saved "${label}"`
            : `Created "${label}"${
                config.defaultIdentityId === null && next.defaultIdentityId !== null
                  ? ', now the Default Identity'
                  : ''
              }`
        }${startsSigning || signsWithNewSshKey ? `; it signs with its SSH key, ${UPLOAD_HINT} too (GitHub needs it uploaded again as Signing key)` : ''}`
      },
      form.editingId === null,
    )

    if (failure === null && (form.newKey || form.newSigningKey) && savedId !== null) {
      enter({
        kind: 'key-name',
        id: savedId,
        purpose: form.newKey ? 'ssh' : 'signing',
        next:
          form.newKey && form.newSigningKey ? [{ id: savedId, purpose: 'signing', value: '' }] : [],
        value: '',
      })
    } else if (failure !== null) {
      const invalid = invalidField(failure.message)

      setMode((previous) =>
        previous.kind === 'form'
          ? { ...previous, invalid, field: invalid ?? previous.field }
          : previous,
      )
    }
  }

  const generateKey = async (
    { id, name, next, purpose }: Extract<Mode, { kind: 'passphrase' }>,
    passphrase: string,
  ) => {
    enter({ kind: 'list' })

    const failure = await run(core.generateSshKey(id, passphrase, name, purpose), (next) => {
      const identity = next.identities.find((candidate) => candidate.id === id)
      const key = purpose === 'signing' ? identity?.signingKey : identity?.sshKey
      const generated = `Generated ${basename(key ?? 'a key')} for "${identity?.label ?? id}"`

      if (purpose === 'ssh') return generated

      return `${generated}; ${UPLOAD_HINT}${
        passphrase === '' ? '' : ', and load it with ssh-add so git does not ask on every commit'
      }`
    })

    const [following, ...rest] = next

    if (failure === null && following) enter({ kind: 'key-name', ...following, next: rest })
  }

  // Keys can arrive faster than renders, so the edit builds on the latest state.
  const editTyped = (edit: (value: string) => string) =>
    setMode((previous) =>
      previous.kind === 'passphrase' || previous.kind === 'key-name'
        ? { ...previous, value: edit(previous.value) }
        : previous,
    )

  const copyPublicKey = async (id: string) => {
    try {
      await core.copySshPublicKey(id)
      setNotice('Public key copied to the clipboard')
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  const copyKey = async (key: string) => {
    try {
      await core.copyPublicKey(key)
      setNotice(`Copied ${basename(key)}.pub to the clipboard`)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  const deleteKey = async (key: string) => {
    try {
      await core.deleteSshKey(key)
      setNotice(`Deleted ${basename(key)}`)
    } catch (failure) {
      setError((failure as Error).message)
    }

    const keys = core.listSshKeys()

    setMode((previous) =>
      previous.kind === 'keys'
        ? {
            ...previous,
            confirm: false,
            keys,
            selected: Math.min(previous.selected, Math.max(keys.length - 1, 0)),
          }
        : previous,
    )
  }

  useKeyboard((key) => {
    if (mode.kind === 'missing-keys') {
      const [first, ...rest] = mode.missing.map(({ id, path, purpose }): KeyJob => ({
        id,
        purpose,
        value: basename(path),
      }))

      if (key.name === 'y' && first) {
        onMissingKeysAnswered()
        enter({ kind: 'key-name', ...first, next: rest })
      } else if (key.name === 'n' || key.name === 'escape') {
        onMissingKeysAnswered()
        enter({ kind: 'list' })
      }

      return
    }

    if (mode.kind === 'keys') {
      const selectedKey = mode.keys[mode.selected]

      setError(null)
      setNotice(null)

      if (mode.confirm) {
        if (key.name === 'y' && selectedKey) void deleteKey(selectedKey)
        else if (key.name === 'n' || key.name === 'escape') setMode({ ...mode, confirm: false })
      } else if (key.name === 'escape') enter({ kind: 'list' })
      else if (isDown(key)) {
        setMode({ ...mode, selected: Math.min(mode.selected + 1, mode.keys.length - 1) })
      } else if (isUp(key)) setMode({ ...mode, selected: Math.max(mode.selected - 1, 0) })
      else if (matchesKey(key, keyBindings.copy) && selectedKey) void copyKey(selectedKey)
      else if (matchesKey(key, keyBindings.delete) && selectedKey) {
        const [user] = keyUsers(config, selectedKey)

        if (user !== undefined) {
          setError(`"${user.label}" uses ${basename(selectedKey)}; attach another key to it first`)
        } else setMode({ ...mode, confirm: true })
      }

      return
    }

    if (mode.kind === 'passphrase' || mode.kind === 'key-name') {
      if (key.name === 'escape') enter({ kind: 'list' })
      else if (key.name === 'return') {
        if (mode.kind === 'key-name') {
          setMode({ ...mode, kind: 'passphrase', first: null, name: mode.value, value: '' })
        } else if (mode.first === null && mode.value === '') void generateKey(mode, '')
        else if (mode.first === null) setMode({ ...mode, first: mode.value, value: '' })
        else if (mode.first === mode.value) void generateKey(mode, mode.value)
        else {
          setError('The passphrases do not match, type it again')
          setMode({ ...mode, first: null, value: '' })
        }
      } else if (key.name === 'backspace') editTyped((value) => value.slice(0, -1))
      else if (PRINTABLE.test(key.sequence) && !key.ctrl && !key.meta) {
        editTyped((value) => value + key.sequence)
      }

      return
    }

    if (mode.kind === 'form') {
      if (key.name === 'escape') {
        setError(null)
        enter({ kind: 'list' })
      } else if (
        key.name === 'tab' &&
        !key.shift &&
        mode.field === NAME_FIELD &&
        nameSuggestion(config, mode.values.name) !== null
      ) {
        setMode({
          ...mode,
          values: { ...mode.values, name: nameSuggestion(config, mode.values.name)! },
        })
      } else if (key.name === 'tab' || key.name === 'down' || key.name === 'up') {
        const step = key.shift || key.name === 'up' ? -1 : 1

        setMode({ ...mode, field: (mode.field + step + FIELD_COUNT) % FIELD_COUNT })
      } else if (mode.field === KEY_FIELD || mode.field === SIGNING_FIELD) {
        const step = { left: -1, right: 1 }[key.name]

        if (step === undefined) {
          if (key.name !== 'return') return

          if (mode.field === KEY_FIELD) setMode({ ...mode, field: SIGNING_FIELD })
          else void submitForm(mode)
        } else if (mode.field === KEY_FIELD) {
          const next = stepChoice(
            [NEW_KEY, null, ...mode.keys],
            mode.newKey ? NEW_KEY : mode.values.sshKey,
            step,
          )

          const changed: FormMode =
            next === NEW_KEY
              ? { ...mode, newKey: true }
              : { ...mode, newKey: false, values: { ...mode.values, sshKey: next } }

          // Signing with the SSH key needs one.
          const keepsSigning = signingOptions(changed).includes(changed.values.signingKey)

          setMode(
            keepsSigning
              ? changed
              : { ...changed, values: { ...changed.values, signingKey: null } },
          )
        } else {
          const next = stepChoice(
            signingOptions(mode),
            mode.newSigningKey ? NEW_KEY : mode.values.signingKey,
            step,
          )

          setMode(
            next === NEW_KEY
              ? { ...mode, newSigningKey: true }
              : { ...mode, newSigningKey: false, values: { ...mode.values, signingKey: next } },
          )
        }
      }

      return
    }

    if (mode.kind === 'confirm-delete') {
      if (key.name === 'y') {
        const label = current?.label ?? mode.id

        enter({ kind: 'list' })
        void run(
          core.deleteIdentity(mode.id, { removeAssignments: true }),
          () => `Deleted "${label}"`,
        )
      } else if (key.name === 'n' || key.name === 'escape') enter({ kind: 'list' })

      return
    }

    setError(null)
    setNotice(null)

    if (isDown(key)) {
      setSelected((index) => Math.max(Math.min(index + 1, config.identities.length - 1), 0))
    } else if (isUp(key)) {
      setSelected((index) => Math.max(index - 1, 0))
    } else if (matchesKey(key, bindings.new)) {
      enter({
        kind: 'form',
        editingId: null,
        field: 0,
        invalid: null,
        keys: core.listSshKeys(),
        newKey: true,
        newSigningKey: false,
        signingKeys: [],
        values: { label: '', name: '', email: '', sshKey: null, signingKey: null },
      })
    } else if (matchesKey(key, bindings.edit) && current) {
      const { label, name, email, sshKey, signingKey } = current
      const keys = core.listSshKeys()

      enter({
        kind: 'form',
        editingId: current.id,
        field: 0,
        invalid: null,
        keys: sshKey === null || keys.includes(sshKey) ? keys : [...keys, sshKey],
        newKey: false,
        newSigningKey: false,
        signingKeys: signingKey === null || signingKey === SIGN_WITH_SSH_KEY ? [] : [signingKey],
        values: { label, name, email, sshKey, signingKey },
      })
    } else if (matchesKey(key, bindings.delete) && current) {
      if (current.id === config.defaultIdentityId) {
        setError(DELETE_DEFAULT_IDENTITY_MESSAGE)

        return
      }

      const assignedTo = loaded.assignments
        .filter(({ identityId }) => identityId === current.id)
        .map(({ text }) => text)

      enter({ kind: 'confirm-delete', id: current.id, assignedTo })
    } else if (matchesKey(key, bindings.make_default) && current) {
      const { label } = current

      void run(core.setDefaultIdentity(current.id), () => `"${label}" is now the Default Identity`)
    } else if (matchesKey(key, bindings.generate_key) && current) {
      enter({ kind: 'key-name', id: current.id, purpose: 'ssh', next: [], value: '' })
    } else if (matchesKey(key, bindings.copy_key) && current) {
      void copyPublicKey(current.id)
    } else if (matchesKey(key, bindings.ssh_keys)) {
      enter({ kind: 'keys', confirm: false, keys: core.listSshKeys(), selected: 0 })
    }
  })

  return (
    <Panes
      title='Identities'
      onSizeChange={measurePanes}
      popup={
        mode.kind === 'form'
          ? {
              title: mode.editingId === null ? 'New identity' : 'Edit identity',
              body: (
                <IdentityForm
                  form={mode}
                  nameSuggestion={nameSuggestion(config, mode.values.name)}
                  onChange={(key, value) =>
                    setMode((previous) =>
                      previous.kind === 'form'
                        ? { ...previous, values: { ...previous.values, [key]: value } }
                        : previous,
                    )
                  }
                  onField={(field) => setMode({ ...mode, field })}
                />
              ),
            }
          : mode.kind === 'confirm-delete'
            ? {
                title: 'Delete Identity',
                danger: true,
                body: (
                  <>
                    <Line>{current?.label}</Line>
                    {mode.assignedTo.length > 0 && (
                      <Line>{`It also removes the Assignments of: ${mode.assignedTo.join(', ')}.`}</Line>
                    )}
                    <text fg={COLORS.error}>This cannot be undone.</text>
                    <Confirm danger question='Delete this Identity?' />
                  </>
                ),
              }
            : mode.kind === 'missing-keys'
              ? {
                  title: 'SSH keys missing on this machine',
                  body: (
                    <MissingKeys
                      config={config}
                      displayPath={core.displayPath}
                      missing={mode.missing}
                      rows={Math.max(paneRows - 6, 1)}
                    />
                  ),
                }
              : mode.kind === 'keys'
                ? {
                    title: 'SSH keys in ~/.ssh',
                    danger: mode.confirm,
                    body: (
                      <KeyList
                        bindings={keyBindings}
                        config={config}
                        confirm={mode.confirm}
                        keys={mode.keys}
                        rows={Math.max(paneRows - 2, 1)}
                        selected={mode.selected}
                      />
                    ),
                  }
                : mode.kind === 'key-name' || mode.kind === 'passphrase'
                  ? {
                      title: `New ed25519 ${mode.purpose === 'signing' ? 'signing ' : ''}key for "${config.identities.find(({ id }) => id === mode.id)?.label ?? mode.id}"`,
                      body: (
                        <>
                          {mode.kind === 'key-name' ? (
                            <Field label='Key name'>
                              {mode.value === '' ? (
                                <span fg={COLORS.muted}>
                                  {`id_ed25519_${mode.id}${mode.purpose === 'signing' ? '-signing' : ''}`}
                                </span>
                              ) : (
                                mode.value
                              )}
                            </Field>
                          ) : (
                            <Field label={mode.first === null ? 'Passphrase' : 'Repeat'}>
                              {mode.value === '' ? (
                                <span fg={COLORS.muted}>
                                  {mode.first === null ? '(optional)' : 'Repeat the passphrase'}
                                </span>
                              ) : (
                                '*'.repeat(mode.value.length)
                              )}
                            </Field>
                          )}
                          <Hints
                            hints={[
                              [
                                'Enter',
                                mode.kind === 'passphrase' &&
                                mode.first === null &&
                                mode.value === ''
                                  ? 'generate without passphrase'
                                  : 'next',
                              ],
                              ['Esc', 'cancel'],
                            ]}
                          />
                        </>
                      ),
                    }
                  : null
      }
      detail={
        current
          ? {
              title: current.label,
              body: (
                <IdentityDetail
                  assignments={loaded.assignments.filter(
                    ({ identityId }) => identityId === current.id,
                  )}
                  config={config}
                  displayPath={core.displayPath}
                  identity={current}
                  missingKey={missingKeys.includes(current.id)}
                  missingSigningKey={missingSigningKeys.includes(current.id)}
                  reach={reach?.get(current.id) ?? null}
                />
              ),
            }
          : null
      }
      footer={
        <box flexDirection='column' paddingX={1}>
          <NoticeLine notice={notice === null ? null : { tone: 'success', text: notice }} />
          <NoticeLine notice={error === null ? null : { tone: 'error', text: error }} />
          {mode.kind === 'list' && (
            <Hints
              hints={[
                ['j/k', 'move'],
                [bindings.new, 'new'],
                [bindings.edit, 'edit'],
                [bindings.delete, 'delete'],
                [bindings.make_default, 'make default'],
                [bindings.generate_key, 'new key'],
                [bindings.copy_key, 'copy key'],
                [bindings.ssh_keys, 'ssh keys'],
                [global.help, 'help'],
              ]}
            />
          )}
        </box>
      }
    >
      <IdentityList
        config={config}
        missingKeys={missingKeys}
        missingSigningKeys={missingSigningKeys}
        newKey={bindings.new}
        paneRows={paneRows}
        reach={reach}
        selected={selected}
      />
    </Panes>
  )
}

interface MissingKeysProps {
  config: IdentitiesConfig
  displayPath: (path: string) => string
  missing: MissingKey[]
  rows: number
}

function MissingKeys({ config, displayPath, missing, rows }: MissingKeysProps) {
  const shown = missing.length > rows ? rows - 1 : rows

  return (
    <>
      <Line>These Identities use keys that are not on this machine:</Line>
      {missing.slice(0, shown).map(({ path, purpose }) => (
        <Line key={path}>
          {`  ${keyUsers(config, path)
            .map(({ label }) => label)
            .join(', ')}: ${displayPath(path)}`}
          {purpose === 'signing' && <Muted>{' (signing)'}</Muted>}
        </Line>
      ))}
      {missing.length > shown && (
        <text fg={COLORS.muted}>{`  and ${missing.length - shown} more`}</text>
      )}
      <text fg={COLORS.muted}>
        If you have a backup, restore it instead: new keys must be added to your Git host again.
      </text>
      <Confirm question='Generate new keys with the same names?' />
    </>
  )
}

/** The Identities that use `key`, with what they use it for. */
function keyUsers(config: IdentitiesConfig, key: string): { label: string; uses: string }[] {
  return config.identities.flatMap((identity) => {
    const uses = [
      ...(identity.sshKey === key ? ['push'] : []),
      ...(signingKeyOf(identity) === key ? ['signing'] : []),
    ]

    return uses.length === 0 ? [] : [{ label: identity.label, uses: uses.join(' + ') }]
  })
}

interface KeyListProps {
  bindings: Keybindings['ssh_keys']
  config: IdentitiesConfig
  confirm: boolean
  keys: string[]
  rows: number
  selected: number
}

function KeyList({ bindings, config, confirm, keys, rows, selected }: KeyListProps) {
  const names = keys.map((key) => basename(key))
  const nameWidth = Math.max(0, ...names.map(({ length }) => length))
  const first = windowStart(selected, rows, keys.length)

  return (
    <>
      {keys.length === 0 && <Line>No SSH keys with a public key in ~/.ssh.</Line>}
      {keys.slice(first, first + rows).map((key, offset) => {
        const users = keyUsers(config, key)

        return (
          <ListRow key={key} selected={first + offset === selected}>
            {names[first + offset]!.padEnd(nameWidth)}
            {users.length === 0 ? (
              <Tint color={COLORS.warning}>{'  unused'}</Tint>
            ) : (
              <Muted>{`  ${users.map(({ label, uses }) => `${label} (${uses})`).join(', ')}`}</Muted>
            )}
          </ListRow>
        )
      })}
      {confirm ? (
        <Confirm
          danger
          question={`Delete ${names[selected]} and its .pub? This cannot be undone.`}
        />
      ) : (
        <Hints
          hints={[
            ['j/k', 'move'],
            [bindings.copy, 'copy .pub'],
            [bindings.delete, 'delete'],
            ['Esc', 'close'],
          ]}
        />
      )}
    </>
  )
}

interface IdentityListProps {
  config: IdentitiesConfig
  missingKeys: string[]
  missingSigningKeys: string[]
  newKey: string
  paneRows: number
  /** Repositories by Identity id; null until the Scan Roots have been read. */
  reach: ReadonlyMap<string, RepositoryNode[]> | null
  selected: number
}

const REACH_NAMES_SHOWN = 5

function repoCount(count: number): string {
  return `${count} ${count === 1 ? 'repo' : 'repos'}`
}

function reachSummary(repositories: RepositoryNode[]): string {
  if (repositories.length === 0) return 'No repository resolves to this Identity.'

  const names = repositories.slice(0, REACH_NAMES_SHOWN).map(({ name }) => name)
  const hidden = repositories.length - names.length

  return `Repositories: ${names.join(', ')}${hidden > 0 ? ` and ${hidden} more` : ''}`
}

function IdentityList({
  config,
  missingKeys,
  missingSigningKeys,
  newKey,
  paneRows,
  reach,
  selected,
}: IdentityListProps) {
  const wide = useWide()

  if (config.identities.length === 0) {
    return (
      <Line>{`Identities view: No identities registered. Press ${newKey} to create one.`}</Line>
    )
  }

  const tags = config.identities.map((identity) => ({
    isDefault: identity.id === config.defaultIdentityId ? '  [default]' : '',
    key: identity.sshKey === null ? '' : `  key: ${basename(identity.sshKey)}`,
    missing: [
      ...(identity.sshKey !== null && missingKeys.includes(identity.id) ? [' [key missing]'] : []),
      ...(missingSigningKeys.includes(identity.id) ? [' [signing key missing]'] : []),
    ].join(''),
    signs: signingKeyOf(identity) === null ? '' : '  signs',
    repos: reach === null ? '' : `  ${repoCount(reach.get(identity.id)?.length ?? 0)}`,
  }))

  const tagsLength = ({ isDefault, key, missing, repos, signs }: (typeof tags)[number]) =>
    isDefault.length + key.length + signs.length + missing.length + repos.length

  const labelWidth = Math.max(...config.identities.map(({ label }) => label.length))
  const tagsWidth = Math.max(...tags.map(tagsLength))
  const summary = reach !== null && !wide
  const visible = Math.max(paneRows - (summary ? 1 : 0), 1)
  const first = windowStart(selected, visible, config.identities.length)

  return (
    <>
      {config.identities.slice(first, first + visible).map((identity, offset) => {
        const tag = tags[first + offset]!

        return (
          <ListRow key={identity.id} selected={first + offset === selected}>
            <Tint color={identityColor(identity)}>{identity.label.padEnd(labelWidth)}</Tint>
            <Muted>{`${tag.isDefault}${tag.key}${tag.signs}`}</Muted>
            {tag.missing !== '' && <Tint color={COLORS.error}>{tag.missing}</Tint>}
            <Muted>{tag.repos.padEnd(tag.repos.length + tagsWidth - tagsLength(tag))}</Muted>
            {!wide && `  ${identity.name} <${identity.email}>`}
          </ListRow>
        )
      })}
      {summary && (
        <text fg={COLORS.muted} wrapMode='none' truncate>
          {reachSummary(reach.get(config.identities[selected]?.id ?? '') ?? [])}
        </text>
      )}
    </>
  )
}

interface IdentityDetailProps {
  assignments: Assignment[]
  config: IdentitiesConfig
  displayPath: (path: string) => string
  identity: Identity
  missingKey: boolean
  missingSigningKey: boolean
  /** Null until the Scan Roots have been read. */
  reach: RepositoryNode[] | null
}

function IdentityDetail({
  assignments,
  config,
  displayPath,
  identity,
  missingKey,
  missingSigningKey,
  reach,
}: IdentityDetailProps) {
  return (
    <>
      <Field label='Name'>{identity.name}</Field>
      <Field label='Email'>{identity.email}</Field>
      <Field label='Default'>{identity.id === config.defaultIdentityId ? 'yes' : 'no'}</Field>
      <Field label='SSH key'>
        {identity.sshKey === null ? '(none)' : displayPath(identity.sshKey)}
        {missingKey && <span fg={COLORS.error}>{'  missing'}</span>}
      </Field>
      <Field label='Signing'>
        {identity.signingKey === null
          ? '(none)'
          : identity.signingKey !== SIGN_WITH_SSH_KEY
            ? displayPath(identity.signingKey)
            : identity.sshKey === null
              ? 'SSH key, but it has none'
              : 'same as SSH key'}
        {missingSigningKey && <span fg={COLORS.error}>{'  missing'}</span>}
      </Field>
      <Field label='Assigned'>{assignments.length === 0 ? '(none)' : assignments[0]!.text}</Field>
      {assignments.slice(1).map(({ text }) => (
        <Field key={text} label=''>
          {text}
        </Field>
      ))}
      <Field label='Repos'>
        {reach === null ? '...' : reach.length === 0 ? '(none)' : String(reach.length)}
      </Field>
      {reach?.map(({ name, path }) => (
        <Field key={path} label=''>
          {name}
        </Field>
      ))}
    </>
  )
}

/** Marked with `>` and bold when focused, so focus never depends on color alone. */
function FieldLabel({ form, index, title }: { form: FormMode; index: number; title: string }) {
  const focused = form.field === index
  const color = form.invalid === index ? COLORS.error : focused ? COLORS.text : COLORS.muted

  return (
    <text fg={color} attributes={focused ? BOLD : 0}>
      {`${focused ? '>' : ' '} ${title.padEnd(7)} `}
    </text>
  )
}

type FormMode = Extract<Mode, { kind: 'form' }>

interface IdentityFormProps {
  form: FormMode
  /** An existing author name Tab puts in the Name field. */
  nameSuggestion: string | null
  onChange: (key: (typeof FIELDS)[number]['key'], value: string) => void
  onField: (field: number) => void
}

function IdentityForm({ form, nameSuggestion, onChange, onField }: IdentityFormProps) {
  const suggesting = form.field === NAME_FIELD && nameSuggestion !== null
  const typedName = form.values.name

  return (
    <>
      {FIELDS.map(({ key, title }, index) => {
        // The input keeps a spare cell past the cursor, so it gets two extra cells and the muted rest of the suggestion starts at the cursor.
        const ghost =
          suggesting && index === NAME_FIELD && typedName !== ''
            ? nameSuggestion.slice(typedName.length)
            : ''

        return (
          <box key={key} flexDirection='row'>
            <FieldLabel form={form} index={index} title={title} />
            <Input
              focused={form.field === index}
              value={form.values[key]}
              placeholder={suggesting && index === NAME_FIELD ? nameSuggestion : undefined}
              onInput={(value) => onChange(key, value)}
              onSubmit={() => onField(index + 1)}
              {...(ghost === '' ? {} : { flexGrow: 0, width: typedName.length + 2 })}
            />
            {ghost !== '' && (
              <text fg={COLORS.muted} marginLeft={-2}>
                {ghost}
              </text>
            )}
          </box>
        )
      })}
      <box flexDirection='row'>
        <FieldLabel form={form} index={KEY_FIELD} title='SSH key' />
        <text fg={COLORS.text}>
          {form.newKey
            ? '+ new key'
            : form.values.sshKey === null
              ? '(none)'
              : basename(form.values.sshKey)}
          {form.field === KEY_FIELD && <span fg={COLORS.muted}>{'  < left/right >'}</span>}
        </text>
      </box>
      <box flexDirection='row'>
        <FieldLabel form={form} index={SIGNING_FIELD} title='Signing' />
        <text fg={COLORS.text}>
          {form.newSigningKey
            ? '+ new key'
            : form.values.signingKey === null
              ? '(none)'
              : form.values.signingKey === SIGN_WITH_SSH_KEY
                ? 'same as SSH key'
                : basename(form.values.signingKey)}
          {form.field === SIGNING_FIELD && <span fg={COLORS.muted}>{'  < left/right >'}</span>}
        </text>
      </box>
      <Hints
        hints={[
          ...(suggesting ? ([['Tab', 'use name']] as const) : []),
          ['Enter', 'next/save'],
          ['Tab ↑↓', 'move'],
          ['Esc', 'cancel'],
        ]}
      />
    </>
  )
}
