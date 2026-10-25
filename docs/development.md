# Development

Requires [Bun](https://bun.sh) and git.

```sh
bun install
bun run start          # open the TUI
bun run start status   # any CLI command
```

`bun run start` runs against your real home and adds the include line to your real `~/.gitconfig`. Use the sandbox to try changes safely.

## Sandbox

```sh
bun run dev        # open a shell inside an isolated sandbox home
bun run dev:reset  # delete the sandbox
```

The sandbox lives in `.dev-home/` and has its own `HOME`, so your real `~/.gitconfig` is never touched. Inside it you start in a demo git repository with `qcs` on the `PATH` running the source, so every [CLI command](usage.md#cli) works as installed. `git config user.email` shows what git reports.

## Checks

```sh
bun run test         # run tests
bun run typecheck    # tsc --noEmit
bun run lint         # eslint (lint:fix to fix)
bun run format       # prettier --check (format:fix to fix)
bun scripts/build.ts # standalone binaries (see Releasing for cross-compiling)
```

The same checks run on every pull request (see [Releasing](releasing.md)).

Commits follow [Conventional Commits](https://www.conventionalcommits.org) and are checked by commitlint through a Husky hook.

## Demo GIF

`docs/demo.gif` is recorded with [VHS](https://github.com/charmbracelet/vhs) (`brew install vhs`) in a throwaway home with a fake user, so re-record it after visible TUI or CLI changes:

```sh
vhs scripts/demo/demo.tape
```

## Project layout

- `src/core`: identity config, Scope resolution, repository scanning and git config generation
- `src/cli`: command entry point (`qcs`) and `status` output
- `src/tui`: terminal UI built with OpenTUI and React
- `scripts`: sandbox (`dev.ts`), binary build (`build.ts`) and demo recording (`demo/`)
- `packaging/homebrew`: Homebrew formula template
- `test`: core, CLI, TUI and compiled binary tests
