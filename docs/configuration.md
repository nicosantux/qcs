# Configuration

Files live under `$XDG_CONFIG_HOME/qcs` (defaults to `~/.config/qcs`). The TUI and CLI write them for you, but they are plain TOML and can be edited by hand (comments and formatting are lost the next time qcs saves the file).

| Path               | Contents                                                                           | Shared across machines        |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------- |
| `identities.toml`  | Identities, the Default Identity and Remote Scopes                                 | yes, keep it in your dotfiles |
| `machine.toml`     | Scan Roots, Folder and Repo Scopes, splash setting                                 | no                            |
| `keybindings.toml` | optional TUI key overrides, never written by the app                               | yes                           |
| `generated/`       | git config files owned by the app, included from `~/.gitconfig` with a single line | no, regenerated               |
| `backups/`         | backups of files the app modifies, such as `~/.gitconfig`                          | no                            |

## identities.toml

```toml
default = "personal"

[identities.personal]
label = "Personal"
name = "Jane Doe"
email = "jane@example.com"
color = 39
ssh_key = "~/.ssh/id_ed25519_personal"
signing_key = "ssh_key"

[identities.work]
label = "Work"
name = "Jane Doe"
email = "jane@company.com"
color = 208
ssh_key = "~/.ssh/id_ed25519_work"
signing_key = "~/.ssh/id_ed25519_work_signing"

[[remote_scopes]]
pattern = "git@github.com:company/**"
identity = "work"
```

- The table key (`personal`, `work`) is the identity id used by `qcs use`. It may only contain letters, digits, `_` and `-`.
- `name` and `email` are required. `label` defaults to the id, `color` (a 0-255 terminal color) is picked automatically.
- `ssh_key` and `signing_key` are optional. `signing_key = "ssh_key"` signs with the SSH key, any other value is the path of a dedicated key.

## machine.toml

```toml
[[scan_roots]]
path = "~/dev"
max_depth = 4

[[folder_scopes]]
path = "~/dev/company"
identity = "work"

[[repo_scopes]]
path = "~/dev/oss/some-repo"
identity = "personal"
```

`max_depth` is optional (default `4`). `splash = false` makes the TUI skip the splash screen (`p` in the Settings view toggles it).

## keybindings.toml

```toml
[global]
quit = "ctrl+q"

[identities]
delete = "x"
```

A key is a character (`x`, `X`, `/`) or a name (`f2`, `space`, `delete`), optionally with `ctrl+`, `alt+` or `shift+`. Moving, view switching, `Enter` and `Esc` keep their keys. On a mistake the TUI says why and uses the default keys.

| Table         | Action         | Default |
| ------------- | -------------- | ------- |
| `global`      | `help`         | `?`     |
|               | `quit`         | `q`     |
| `repos`       | `assign`       | `a`     |
|               | `unassign`     | `x`     |
|               | `remote`       | `m`     |
|               | `top`          | `g`     |
|               | `bottom`       | `G`     |
|               | `rescan`       | `r`     |
|               | `alerts_only`  | `f`     |
|               | `search`       | `/`     |
|               | `diagnostics`  | `d`     |
| `diagnostics` | `repoint`      | `p`     |
|               | `remove`       | `x`     |
|               | `close`        | `d`     |
| `identities`  | `new`          | `n`     |
|               | `edit`         | `e`     |
|               | `delete`       | `d`     |
|               | `make_default` | `m`     |
|               | `generate_key` | `g`     |
|               | `copy_key`     | `c`     |
|               | `ssh_keys`     | `s`     |
| `ssh_keys`    | `copy`         | `c`     |
|               | `delete`       | `d`     |
| `settings`    | `add`          | `n`     |
|               | `remove`       | `d`     |
|               | `suggest`      | `s`     |
|               | `import`       | `i`     |
|               | `splash`       | `p`     |
