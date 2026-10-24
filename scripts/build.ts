import { join } from 'node:path'
import { parseArgs } from 'node:util'

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const

type Target = (typeof TARGETS)[number]

const repoRoot = join(import.meta.dir, '..')

/**
 * Compiles standalone binaries to `<out-dir>/<os>-<arch>/qcs`.
 * Usage: bun scripts/build.ts [--out-dir dist] [target...]; builds every target by default.
 * Cross-compiling needs every platform package of @opentui/core, so install with `--os '*' --cpu '*'`.
 */
async function build(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'out-dir': { type: 'string', default: join(repoRoot, 'dist') } },
  })

  const isTarget = (value: string): value is Target =>
    (TARGETS as readonly string[]).includes(value)

  const requested = positionals.length > 0 ? positionals : [...TARGETS]
  const unknown = requested.filter((value) => !isTarget(value))

  if (unknown.length > 0) {
    console.error(`Unknown target: ${unknown.join(', ')}. Available: ${TARGETS.join(', ')}`)

    return 64
  }

  const targets = requested.filter(isTarget)

  const results = await Promise.all(
    targets.map(async (target) => {
      const result = await Bun.build({
        entrypoints: [join(repoRoot, 'src/cli/main.ts')],
        compile: { target: `bun-${target}`, outfile: join(values['out-dir'], target, 'qcs') },
      })

      return { target, result }
    }),
  )

  for (const { target, result } of results) {
    if (!result.success) {
      console.error(
        `Build failed for ${target}:\n${result.logs.map((log) => log.message).join('\n')}`,
      )

      return 1
    }

    console.log(`Built ${target}`)
  }

  return 0
}

process.exitCode = await build()
