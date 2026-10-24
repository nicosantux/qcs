import type { KeyEvent } from '@opentui/core'

import { createContext, useContext } from 'react'

import { ConfigError } from '../core/index.ts'

/** The default key of every action `keybindings.toml` can override, by table. */
export const DEFAULT_KEYBINDINGS = {
  global: { help: '?', quit: 'q' },
  repos: {
    alerts_only: 'f',
    assign: 'a',
    bottom: 'G',
    diagnostics: 'd',
    remote: 'm',
    rescan: 'r',
    search: '/',
    top: 'g',
    unassign: 'x',
  },
  diagnostics: { close: 'd', remove: 'x', repoint: 'p' },
  identities: {
    copy_key: 'c',
    delete: 'd',
    edit: 'e',
    generate_key: 'g',
    make_default: 'm',
    new: 'n',
    ssh_keys: 's',
  },
  ssh_keys: { copy: 'c', delete: 'd' },
  settings: { add: 'n', import: 'i', remove: 'd', splash: 'p', suggest: 's' },
} as const

type Defaults = typeof DEFAULT_KEYBINDINGS

export type Keybindings = { [Table in keyof Defaults]: Record<keyof Defaults[Table], string> }

/** Tables whose keys are active at the same time, so a key may appear only once among them. */
const ACTIVE_TOGETHER: readonly (keyof Defaults)[][] = [
  ['global', 'repos'],
  ['global', 'identities'],
  ['global', 'settings'],
  ['diagnostics'],
  ['ssh_keys'],
]

/** Keys with a fixed meaning: moving, switching views, confirming and cancelling. */
const RESERVED = new Set([
  '1',
  '2',
  '3',
  'backspace',
  'down',
  'escape',
  'h',
  'j',
  'k',
  'l',
  'left',
  'return',
  'right',
  'tab',
  'up',
])

const NAMED_KEYS = new Set([
  'delete',
  'end',
  'home',
  'insert',
  'pagedown',
  'pageup',
  'space',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
])

interface Binding {
  alt: boolean
  ctrl: boolean
  name: string
  shift: boolean
}

function parseBinding(binding: string): Binding | null {
  const modifiers = /^((?:(?:ctrl|alt|shift)\+)*)(.+)$/.exec(binding)

  if (modifiers === null) return null

  const [, prefix = '', name = ''] = modifiers
  const has = (modifier: string) => prefix.includes(`${modifier}+`)
  const single = [...name].length === 1 && /^\S$/u.test(name)

  if (!single && !NAMED_KEYS.has(name)) return null
  // An uppercase letter already means Shift.
  if (single && has('shift')) return null

  return { name, ctrl: has('ctrl'), alt: has('alt'), shift: has('shift') }
}

export function matchesKey(key: KeyEvent, binding: string): boolean {
  const parsed = parseBinding(binding)

  if (parsed === null) return false
  if (key.ctrl !== parsed.ctrl || (key.meta || key.option) !== parsed.alt) return false

  if (parsed.ctrl || parsed.alt) {
    return (
      key.name === parsed.name.toLowerCase() &&
      key.shift === (parsed.shift || parsed.name !== parsed.name.toLowerCase())
    )
  }

  if (NAMED_KEYS.has(parsed.name)) return key.name === parsed.name && key.shift === parsed.shift

  return key.sequence === parsed.name || (key.name === parsed.name && !key.shift)
}

/** The bindings with the overrides of `keybindings.toml` applied; throws a ConfigError naming the first mistake. */
export function resolveKeybindings(document: Record<string, unknown>): Keybindings {
  const tables = Object.keys(DEFAULT_KEYBINDINGS) as (keyof Defaults)[]
  const resolved = structuredClone(DEFAULT_KEYBINDINGS) as Keybindings

  for (const [table, overrides] of Object.entries(document)) {
    if (!(tables as string[]).includes(table)) {
      throw new ConfigError(
        `keybindings.toml: unknown table [${table}]. Valid tables: ${tables.join(', ')}`,
      )
    }

    const actions = resolved[table as keyof Defaults] as Record<string, string>

    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
      throw new ConfigError(`keybindings.toml: [${table}] must be a table`)
    }

    for (const [action, binding] of Object.entries(overrides)) {
      if (!(action in actions)) {
        throw new ConfigError(
          `keybindings.toml: unknown action "${action}" in [${table}]. Valid actions: ${Object.keys(actions).join(', ')}`,
        )
      }

      const parsed = typeof binding === 'string' ? parseBinding(binding) : null

      if (parsed === null) {
        throw new ConfigError(
          `keybindings.toml: [${table}] ${action} = ${JSON.stringify(binding)} is not a key; use a character like "x" or "X", or a name like "f2", with optional "ctrl+", "alt+" or "shift+"`,
        )
      }

      if (!parsed.ctrl && !parsed.alt && RESERVED.has(parsed.name)) {
        throw new ConfigError(
          `keybindings.toml: [${table}] ${action} cannot use "${binding as string}", which is reserved for moving and switching views`,
        )
      }

      actions[action] = binding as string
    }
  }

  for (const group of ACTIVE_TOGETHER) {
    const seen = new Map<string, string>()

    for (const table of group) {
      for (const [action, binding] of Object.entries(resolved[table])) {
        const owner = seen.get(binding)

        if (owner !== undefined) {
          throw new ConfigError(
            `keybindings.toml: "${binding}" is bound to both ${owner} and ${table}.${action}`,
          )
        }

        seen.set(binding, `${table}.${action}`)
      }
    }
  }

  return resolved
}

const KeybindingsContext = createContext<Keybindings>(DEFAULT_KEYBINDINGS)

export const KeybindingsProvider = KeybindingsContext.Provider

export function useKeybindings(): Keybindings {
  return useContext(KeybindingsContext)
}
