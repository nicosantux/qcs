#!/bin/sh
# Installs the latest qcs release:
#   curl -fsSL https://raw.githubusercontent.com/nicosantux/qcs/main/install.sh | sh
# QCS_INSTALL_DIR changes where the binary goes (default: ~/.local/bin). Run it again to update.
set -eu

releases=https://github.com/nicosantux/qcs/releases
install_dir=${QCS_INSTALL_DIR:-$HOME/.local/bin}

fail() {
  echo "qcs install: $*" >&2
  exit 1
}

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s), see $releases" ;;
esac

case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported architecture $(uname -m), see $releases" ;;
esac

# Pinning the tag keeps the archive and SHA256SUMS from two different releases.
tag=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$releases/latest")
tag=${tag##*/}
asset=qcs-$os-$arch.tar.gz
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading qcs $tag for $os-$arch"
curl -fsSL -o "$tmp/$asset" "$releases/download/$tag/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$releases/download/$tag/SHA256SUMS"

expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)

if command -v sha256sum > /dev/null; then
  actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
fi

[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "the checksum of $asset does not match SHA256SUMS"

tar --no-same-owner -xzf "$tmp/$asset" -C "$tmp"
chmod 755 "$tmp/qcs"
mkdir -p "$install_dir"
mv "$tmp/qcs" "$install_dir/qcs"
echo "Installed qcs $tag to $install_dir/qcs"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to your PATH to run qcs" ;;
esac
