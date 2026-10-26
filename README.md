# quien-chota-sos

A terminal tool to assign and inspect which git identity (author, SSH key and signing key) is used in each folder or repository on a machine.

Identities are applied through native git `includeIf` rules, so the right identity is used from any client (terminal, editor, lazygit) even when the app is not running.

![qcs demo: importing identities from ~/.gitconfig, creating an Identity with its own SSH key, assigning it to a folder and checking it from the CLI](docs/demo.gif)

## Install

With Homebrew (macOS, Linux):

```sh
brew install nicosantux/tap/qcs
```

With mise:

```sh
mise use -g github:nicosantux/qcs
```

With the install script, to `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/nicosantux/qcs/main/install.sh | sh
```

Or download `qcs-<os>-<arch>.tar.gz` (macOS or Linux, x64 or arm64) from the GitHub Releases page and put `qcs` on your `PATH`. The binary is self-contained and only needs git (2.36 or newer for Remote Scopes).

## Quick start

```sh
qcs                    # open the TUI
qcs add ~/dev          # register a Scan Root so its repositories show up
qcs use work           # assign the "work" Identity to the current repository
qcs status             # show the Effective Identity here and where it comes from
```

On first run the TUI offers to import the identities already set in your `~/.gitconfig` (the global `[user]` and `includeIf` folders), or suggests Scan Roots from your home directory.

## How it works

You create Identities (name, email, SSH key, signing key) and assign them to a folder, a remote URL pattern or a single repository. qcs writes the matching git config under `~/.config/qcs/generated/` and adds one include line to `~/.gitconfig`. The most specific Assignment wins: repository, then remote, then folder, then the Default Identity.

## Documentation

- [Concepts](docs/concepts.md): Identities, Scopes and Assignments
- [Usage](docs/usage.md): the CLI and each TUI view
- [Configuration](docs/configuration.md): config files and keybindings
- [Development](docs/development.md): running from source, tests and project layout
- [Releasing](docs/releasing.md): pull requests, release-please and Homebrew
