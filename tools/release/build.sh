#!/usr/bin/env bash
set -euo pipefail

# Build local artifacts only. This script never uploads or publishes anything.
version=${VERSION:?Set VERSION to vMAJOR.MINOR.PATCH (optionally -prerelease)}
if [[ ! $version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[a-zA-Z0-9]+([.-][a-zA-Z0-9]+)*)?$ ]]; then
  printf 'Invalid VERSION: use vMAJOR.MINOR.PATCH, optionally -prerelease.\n' >&2
  exit 1
fi
if [[ ${DISTRIBUTION:-0} != 0 && ${DISTRIBUTION:-0} != 1 ]]; then
  printf 'DISTRIBUTION must be 0 (review) or 1 (license-gated distribution build).\n' >&2
  exit 1
fi
if [[ ${DISTRIBUTION:-0} == 1 && ! -s LICENSE ]]; then
  printf 'Distribution blocked: the owner must choose and commit a project LICENSE first.\n' >&2
  exit 1
fi
output=${OUTPUT:?Set OUTPUT to a new artifact directory outside tracked source}
# Refuse reuse so stale binaries cannot enter a checksum manifest.
mkdir "$output"
output=$(cd "$output" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
commit=$(git rev-parse --verify HEAD)
if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
  commit="$commit-dirty"
fi
for arch in amd64 arm64; do
  name="keelbox_${version}_linux_${arch}"
  mkdir "$stage/$name"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" GOAMD64=v1 GOARM64=v8.0 "${GO:-go}" build -trimpath -buildvcs=false \
    -ldflags="-X github.com/Astatide1337/keelbox/internal/keelbox.buildVersion=$version -X github.com/Astatide1337/keelbox/internal/keelbox.buildCommit=$commit" \
    -o "$stage/$name/keelbox" ./cmd/keelbox
  cp tools/release/LICENSE-* tools/release/NOTICE-* tools/release/THIRD-PARTY-NOTICES tools/release/INSTALL.md "$stage/$name/"
  if [[ -s LICENSE ]]; then
    cp LICENSE "$stage/$name/LICENSE"
  else
    printf 'Review artifact only. Keelbox has no owner-selected project license. Distribution and release publication remain blocked.\n' > "$stage/$name/LICENSE-STATUS.txt"
  fi
  if [[ -s NOTICE ]]; then
    cp NOTICE "$stage/$name/NOTICE"
  fi
  tar -C "$stage" -czf "$output/$name.tar.gz" "$name"
done
(cd "$output" && sha256sum ./*.tar.gz > checksums.txt && sha256sum --check checksums.txt)
printf 'Built %s at %s. No release was published.\n' "$version" "$output"
