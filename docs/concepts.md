# Concepts

## Identities

An **Identity** is a named git persona: author name, author email, an optional SSH key used to push, and an optional signing key used to sign commits and tags (the same SSH key or a dedicated one).

- **Default Identity**: the Identity in effect wherever no Assignment applies.
- **Effective Identity**: the Identity git actually uses in a repository once every Assignment is resolved.
- **Unknown Identity**: an author found in effect for a repository that matches no registered Identity.

## Scopes and Assignments

An **Assignment** links one Scope to one Identity. There are three kinds of Scope, from most to least specific:

| Scope            | Applies to                                                             | Git rule                                             |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| **Repo Scope**   | a single repository                                                    | `includeIf "gitdir:..."`                             |
| **Remote Scope** | every repository whose remote matches a URL pattern, wherever it lives | `includeIf "hasconfig:remote.*.url:..."` (git 2.36+) |
| **Folder Scope** | every repository nested in a directory                                 | `includeIf "gitdir:.../"`                            |

When several apply, the most specific wins: Repo Scope, then Remote Scope, then Folder Scope (the deepest folder first), then the Default Identity.

- **Orphaned Assignment**: a Folder or Repo Scope Assignment whose path no longer exists on this machine.
- **External Rule**: a git identity setting qcs does not manage, such as a hand-written `includeIf` or a repository-local `user.email`.

## Scan Roots

A **Scan Root** is a directory you register so the repositories under it are discovered and shown in the TUI. Scanning goes 4 levels deep by default (`max_depth` in [`machine.toml`](configuration.md#machinetoml)).

## Shared and per-machine settings

Identities and Remote Scope Assignments are shared across machines: they live in `identities.toml`, which you can keep in your dotfiles. Folder and Repo Scope Assignments and Scan Roots depend on local paths, so they live in `machine.toml` and belong to one machine. See [Configuration](configuration.md).
