import type { Environment } from './paths.ts'

import { join } from 'node:path'

import { readTomlFile } from './config-store.ts'
import { configDirectory } from './paths.ts'

export function keybindingsFilePath(environment: Environment): string {
  return join(configDirectory(environment), 'keybindings.toml')
}

/** The parsed `keybindings.toml`, written only by the user; empty when the file does not exist. */
export function loadKeybindingsFile(environment: Environment): Record<string, unknown> {
  return readTomlFile(keybindingsFilePath(environment)) ?? {}
}
