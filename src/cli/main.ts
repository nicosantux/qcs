#!/usr/bin/env bun
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import packageJson from '../../package.json' with { type: 'json' }
import { ConfigError, createCore } from '../core/index.ts'

import { formatStatus, NOT_A_REPOSITORY_MESSAGE } from './status.ts'

const HELP = `Usage: qcs [command]

Assign and inspect which git identity is used in each folder or repository.

Commands:
  (none)              open the TUI
  status              show the Effective Identity of the current repository and where it comes from
                      (exit 1 on an Unknown Identity, 2 outside a repository)
  use <identity-id>   assign an Identity to the current repository (Repo Scope)
  add [path]          register a directory as a Scan Root (default: the current directory)
  help, --help, -h    show this help
  --version, -v       show the version

The identity id is the key under [identities] in identities.toml, e.g. "work" for [identities.work].`

async function main(args: string[]): Promise<number> {
  const [command] = args

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP)

    return 0
  }

  if (command === '--version' || command === '-v') {
    console.log(packageJson.version)

    return 0
  }

  const core = createCore({ home: homedir(), env: process.env })

  if (command === undefined) {
    const { runTui } = await import('../tui/run.tsx')

    await runTui(core)

    return 0
  }

  if (command === 'status') {
    const report = formatStatus(await core.resolve(process.cwd()))

    console.log(report.lines.join('\n'))

    return report.exitCode
  }

  if (command === 'use') {
    const [, identityId] = args

    if (identityId === undefined) {
      console.error('Usage: qcs use <identity-id>')

      return 64
    }

    const resolution = await core.resolve(process.cwd())

    if (resolution.status === 'not-a-repository') {
      console.error(NOT_A_REPOSITORY_MESSAGE)

      return 2
    }

    const { repository } = resolution

    await core.assignRepository(repository, identityId)

    const report = formatStatus(await core.resolve(repository))

    console.log(report.lines.join('\n'))

    return report.exitCode
  }

  if (command === 'add') {
    const [, path] = args

    // Empty (a cancelled fzf) and quoted "~/..." paths go through as typed, for addScanRoot to reject or expand.
    const target = path === undefined ? process.cwd() : /^\s*$|^~/.test(path) ? path : resolve(path)

    await core.addScanRoot(target)
    console.log(`Added Scan Root ${core.loadScanRoots().at(-1)!.displayPath}`)

    return 0
  }

  console.error(`qcs: unknown command "${command}". Run "qcs --help" for usage.`)

  return 64
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`qcs: ${error.message}`)
    process.exitCode = 78
  } else {
    throw error
  }
}
