# Releasing

## Pull requests

Every change reaches `main` through a squash-merged PR.

- `.github/workflows/pr-title.yml` checks the PR title against Conventional Commits, because it becomes the squash commit that release-please reads.
- `.github/workflows/pull-request.yml` runs format, typecheck, lint, tests and the binary build.

Dependabot opens monthly `chore(deps)` PRs for Bun packages and `ci` PRs for GitHub Actions. Retitle one to `fix(deps)` when the bumped dependency ships in the binary and should trigger a release.

## Releases

Releases are driven by [release-please](https://github.com/googleapis/release-please):

1. Merging to `main` keeps a release PR up to date (version bump and changelog from Conventional Commits).
2. Merging that PR creates the tag and the GitHub Release.
3. `.github/workflows/release.yml` builds the four binaries and uploads `qcs-<os>-<arch>.tar.gz` and `SHA256SUMS` to the release.
4. The same workflow fills the hashes into `packaging/homebrew/qcs.rb` (its version is bumped by the release PR) and pushes it to `Formula/` in the tap repository `nicosantux/homebrew-tap`.

Both release-please and the tap push use a `RELEASE_TOKEN` secret: a fine-grained personal access token with `Contents: write` and `Pull requests: write` on this repository and `Contents: write` on the tap. It must not be `GITHUB_TOKEN`, because PRs opened with that token do not trigger CI, so the release PR could never pass the required check.

## Building locally

```sh
bun install --os '*' --cpu '*'  # cross-compiling needs every platform package
bun scripts/build.ts            # dist/<os>-<arch>/qcs for every target
bun scripts/build.ts linux-x64  # or only the given targets
```
