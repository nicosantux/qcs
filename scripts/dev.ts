import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const sandbox = join(repoRoot, '.dev-home')
const demoRepo = join(sandbox, 'code', 'demo')
const binDirectory = join(sandbox, 'bin')

function writeOnce(path: string, content: string) {
  if (!existsSync(path)) writeFileSync(path, content)
}

function prepareSandbox() {
  mkdirSync(binDirectory, { recursive: true })

  const qcs = join(binDirectory, 'qcs')

  writeFileSync(qcs, `#!/bin/sh\nexec bun ${join(repoRoot, 'src/cli/main.ts')} "$@"\n`)
  chmodSync(qcs, 0o755)

  writeOnce(join(sandbox, '.zshrc'), "PROMPT='(qcs sandbox) %~ %# '\n")
  writeOnce(join(sandbox, '.bashrc'), "PS1='(qcs sandbox) \\w \\$ '\n")

  if (!existsSync(demoRepo)) {
    mkdirSync(demoRepo, { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', demoRepo])
  }
}

async function openShell(): Promise<number> {
  prepareSandbox()

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sandbox,
    PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
    QCS_SANDBOX: '1',
    // The sandbox lives inside this repository, so without a ceiling git finds it from any sandbox folder.
    GIT_CEILING_DIRECTORIES: repoRoot,
  }

  delete env.XDG_CONFIG_HOME
  delete env.GIT_CONFIG_GLOBAL

  console.log(`Sandbox shell (HOME=${sandbox}). Run "qcs" for the TUI, "exit" to leave.`)

  const shell = Bun.spawn([process.env.SHELL ?? '/bin/sh'], {
    cwd: demoRepo,
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  return shell.exited
}

const [command] = process.argv.slice(2)

if (command === 'reset') {
  rmSync(sandbox, { recursive: true, force: true })
  console.log('Removed .dev-home')
} else if (command === undefined) {
  process.exitCode = await openShell()
} else {
  console.error(`dev: unknown command "${command}". Available commands: reset`)
  process.exitCode = 64
}
