#!/usr/bin/env bash
# Builds a throwaway home with a fake user for recording docs/demo.gif (see demo.tape).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
demo_home="${QCS_DEMO_HOME:-/tmp/qcs-demo}"

rm -rf "$demo_home"
mkdir -p "$demo_home/bin" "$demo_home/.ssh"
chmod 700 "$demo_home/.ssh"

printf '#!/bin/sh\nexec bun %s "$@"\n' "$repo_root/src/cli/main.ts" >"$demo_home/bin/qcs"
chmod 755 "$demo_home/bin/qcs"

cat >"$demo_home/.gitconfig" <<'EOF'
[user]
	name = Nicolás Santuccio
	email = nicolas@personal.dev
[includeIf "gitdir:~/work/acme/"]
	path = ~/.gitconfig-acme
EOF

cat >"$demo_home/.gitconfig-acme" <<'EOF'
[user]
	email = nicolas@acme.io
EOF

repo() {
  git init -q "$demo_home/$1"
  git -C "$demo_home/$1" remote add origin "$2"
}

repo work/acme/api git@github.com:acme/api.git
repo work/acme/web git@github.com:acme/web.git
repo personal/dotfiles git@github.com:nicolas/dotfiles.git
repo personal/blog git@github.com:nicolas/blog.git
repo oss/terminal-kit git@github.com:open-terminal/terminal-kit.git

highlighting="$(brew --prefix 2>/dev/null)/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"

cat >"$demo_home/env.zsh" <<EOF
export HOME='$demo_home'
export PATH='$demo_home/bin':"\$PATH"
export GIT_CEILING_DIRECTORIES='$demo_home'
unset XDG_CONFIG_HOME GIT_CONFIG_GLOBAL
PROMPT='%F{blue}%~%f %F{magenta}❯%f '
[ -f '$highlighting' ] && source '$highlighting'
cd ~
EOF
