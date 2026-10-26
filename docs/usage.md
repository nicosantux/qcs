# Usage

## CLI

```sh
qcs                       # open the TUI
qcs status                # Effective Identity of the current repository and where it comes from
qcs use <identity-id>     # assign an Identity to the current repository (Repo Scope)
qcs add [path]            # register a Scan Root (default: the current directory)
qcs add "$(fd -t d . ~ | fzf)"  # pick it with fzf
qcs update                # update to the latest release (script and manual installs)
qcs --help
qcs --version
```

The identity id is the key under `[identities]` in [`identities.toml`](configuration.md#identitiestoml), e.g. `work` for `[identities.work]`.

`qcs status` exits with `1` on an Unknown Identity and `2` outside a repository, so it can guard scripts and hooks.

`qcs update` replaces the binary in place after checking it against the release's `SHA256SUMS`. Installs owned by Homebrew, mise or a system package manager are left to them, and `qcs update` says which command to run instead. Run it with `sudo` when the binary is in a directory you can't write to.

The TUI checks GitHub for a newer release on start and shows it in the footer. Set `QCS_NO_UPDATE_CHECK=1` to turn the check off.

## TUI

Switch views with `1` `2` `3` or `Tab` (`Shift+Tab` back). `?` shows every key of the current view, `q` quits. All the keys below are defaults and can be changed in [`keybindings.toml`](configuration.md#keybindingstoml).

The TUI applies the configuration on start, so the generated git config and the include line in `~/.gitconfig` are always up to date.

### Repos (`1`)

A tree of the repositories under each Scan Root, with the Effective Identity of each one and where it comes from.

| Key               | Action                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `j` `k` / `↑` `↓` | move                                                                                                                           |
| `h` `l` / `←` `→` | collapse / expand (`h` on a repository jumps to its folder)                                                                    |
| `g` `G`           | top / bottom                                                                                                                   |
| `Enter`           | expand or collapse a folder, assign a repository                                                                               |
| `a` / `x`         | assign / unassign an Identity to the selected folder or repository                                                             |
| `m`               | assign an Identity to the remote pattern of the selected repository (`Ctrl+D` in the pattern prompt removes that Remote Scope) |
| `f`               | show only repositories with alerts (Unknown Identity, External Rule, missing key)                                              |
| `/`               | search by name or path                                                                                                         |
| `d`               | diagnostics                                                                                                                    |
| `r`               | rescan                                                                                                                         |

Assigning a folder previews which repositories change author before you confirm. A repository is assigned right away. The remote pattern is pre-filled to cover every repository of the same owner or organization.

Diagnostics (`d`) list:

- Orphaned Assignments: `p` re-points one to a new path, `x` removes it.
- A global git config that sets the identity after the qcs include line, which would override qcs: `Enter` moves the include to the end, after a backup.

### Identities (`2`)

| Key       | Action                                                                                      |
| --------- | ------------------------------------------------------------------------------------------- |
| `n` / `e` | new / edit Identity                                                                         |
| `d`       | delete Identity                                                                             |
| `m`       | make it the Default Identity                                                                |
| `g`       | generate an ed25519 SSH key (asks for its file name, empty for `id_ed25519_<identity>`)     |
| `c`       | copy the public key to the clipboard                                                        |
| `s`       | list the keys in `~/.ssh` and which Identity uses each (`c` copy, `d` delete an unused one) |

Each Identity shows the repositories that resolve to it. In the form, `Tab` / `↑` `↓` move between fields and `←` `→` choose the SSH key or signing key. `+ new key` generates one after saving.

#### Commit signing

The form's `Signing` field makes git sign that Identity's commits and tags over SSH: `same as SSH key` reuses the push key, `+ new key` generates a dedicated one. Add the `.pub` to your Git host as a signing key so commits show as verified (GitHub needs the same key uploaded again with the Signing type). qcs also writes `generated/allowed_signers`, so `git log --show-signature` verifies your own commits locally.

#### Setting up a new machine

When an Identity's key file is missing, as after restoring `identities.toml` from your dotfiles, the TUI opens on this view and offers to generate new keys with the same file names (`y`), one after another. Restore a backup of the keys instead if you have one, because a new key has to be added to your Git host again.

### Settings (`3`)

| Key       | Action                                                                                  |
| --------- | --------------------------------------------------------------------------------------- |
| `n` / `d` | add / remove a Scan Root                                                                |
| `s`       | add the suggested Scan Roots (folders in your home directory that contain repositories) |
| `i`       | import existing git identity settings                                                   |
| `p`       | show / hide the splash screen on start                                                  |

Import reads the global `[user]` block (it becomes the Default Identity) and the `includeIf` folders of `~/.gitconfig`, turns them into Identities and Folder Scopes, and removes the imported blocks after a backup. Anything that would change a repository's author, or clash with what qcs already has, is left out. The TUI offers the same import on first run, while there are no Identities yet.
