#!/bin/sh
# Download the pinned PocketBase release into ./bin (or $PB_BIN_DIR) and verify its checksum.
# No-op when the pinned version is already installed.
set -eu

PB_VERSION="0.40.4"

cd "$(dirname "$0")/.."
BIN_DIR="${PB_BIN_DIR:-bin}"
PB="$BIN_DIR/pocketbase"

if [ -x "$PB" ] && "$PB" --version 2>/dev/null | grep -q "$PB_VERSION"; then
  echo "pocketbase $PB_VERSION already installed"
  exit 0
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

# From https://github.com/pocketbase/pocketbase/releases/download/v$PB_VERSION/checksums.txt
case "${os}_${arch}" in
  linux_amd64) sha=9042ec818570e79c3628dadcd0a756c1496d9e1173918ec409d133c02f82e5fa ;;
  linux_arm64) sha=86095bf8ed9345954f0d2bf0a5fb9b57584ae60b77ebf3b6cd23a8003a3fd418 ;;
  darwin_amd64) sha=052906521f09f6f23405cd804c930d2b7a1f8eee06d39b85723b5054b2acb4e4 ;;
  darwin_arm64) sha=eeb619ea4f8a06421daedb946d133bed269fea334a760941d147f76befc25ebc ;;
esac

zip="pocketbase_${PB_VERSION}_${os}_${arch}.zip"
url="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/${zip}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading $url"
curl -fsSL "$url" -o "$tmp/$zip"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$zip" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$zip" | cut -d' ' -f1)"
fi
if [ "$actual" != "$sha" ]; then
  echo "checksum mismatch for $zip: expected $sha, got $actual" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
if command -v unzip >/dev/null 2>&1; then
  unzip -oq "$tmp/$zip" pocketbase -d "$tmp/out"
else
  mkdir -p "$tmp/out" && bsdtar -xf "$tmp/$zip" -C "$tmp/out" pocketbase
fi
mv "$tmp/out/pocketbase" "$PB"
chmod +x "$PB"
"$PB" --version
