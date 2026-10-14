#!/usr/bin/env bash
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for invalid in 'v1.2.3 -X attacker=value' '../v1.2.3' 'v01.2.3' 'v1.2'; do
  if VERSION="$invalid" OUTPUT="$work/invalid" bash tools/release/build.sh > "$work/invalid.log" 2>&1; then
    printf 'Invalid version unexpectedly accepted: %s\n' "$invalid" >&2
    exit 1
  fi
  test ! -e "$work/invalid"
done
# Exercise the missing-license guard even once the real owner later adds LICENSE.
mkdir "$work/unlicensed"
cp tools/release/build.sh "$work/unlicensed/build.sh"
if (cd "$work/unlicensed" && VERSION=v0.0.0-test DISTRIBUTION=1 OUTPUT="$work/blocked" bash build.sh > "$work/license.log" 2>&1); then
  printf 'Distribution without LICENSE unexpectedly succeeded.\n' >&2
  exit 1
fi
grep -q 'owner must choose' "$work/license.log"
test ! -e "$work/blocked"
VERSION=v0.0.0-test DISTRIBUTION=1 OUTPUT="$work/artifacts" bash tools/release/build.sh
if VERSION=v0.0.0-test OUTPUT="$work/artifacts" bash tools/release/build.sh > "$work/reuse.log" 2>&1; then
  printf 'Reusing an artifact directory unexpectedly succeeded.\n' >&2
  exit 1
fi
(cd "$work/artifacts" && sha256sum --check checksums.txt)
for arch in amd64 arm64; do
  name="keelbox_v0.0.0-test_linux_${arch}"
  tar -xzf "$work/artifacts/$name.tar.gz" -C "$work"
  for file in keelbox INSTALL.md LICENSE NOTICE THIRD-PARTY-NOTICES LICENSE-Go LICENSE-patternmatcher LICENSE-yaml NOTICE-patternmatcher; do
    test -s "$work/$name/$file"
  done
  cmp LICENSE "$work/$name/LICENSE"
  cmp NOTICE "$work/$name/NOTICE"
  test ! -e "$work/$name/LICENSE-STATUS.txt"
  test -x "$work/$name/keelbox"
done
case $(uname -m) in
  x86_64) native=amd64 ;;
  aarch64) native=arm64 ;;
  *) printf 'No native package smoke test for this machine.\n' >&2; exit 1 ;;
esac
binary="$work/keelbox_v0.0.0-test_linux_${native}/keelbox"
mkdir "$work/home" "$work/project" "$work/no-tools"
printf 'FROM scratch\n' > "$work/project/Dockerfile"
cat > "$work/project/keelbox.yaml" <<'YAML'
version: 1
name: smoke
namespace: smoke
project: .
helm: {chart: chart}
build: [{name: api, context: ., dockerfile: Dockerfile, image: local/api}]
workloads: {api: deployment/api}
endpoint: {service: api, port: 80, localPort: 8080}
YAML
(cd "$work/project" && env -i HOME="$work/home" PATH="$work/no-tools" "$binary" --help) > "$work/help.log"
grep -q 'Usage: keelbox' "$work/help.log"
(cd "$work/project" && env -i HOME="$work/home" PATH="$work/no-tools" "$binary" --version) > "$work/version.log"
grep -q '^keelbox v0.0.0-test (commit ' "$work/version.log"
if (cd "$work/project" && env -i HOME="$work/home" PATH="$work/no-tools" "$binary" doctor) > "$work/doctor.log" 2>&1; then
  printf 'Doctor unexpectedly succeeded without Docker.\n' >&2
  exit 1
fi
grep -q 'Docker.*https://docs.docker.com/engine/install/' "$work/doctor.log"
printf '\nObserved packaged executable diagnostics:\n'
cat "$work/version.log" "$work/doctor.log"
printf 'corruption' >> "$work/artifacts/keelbox_v0.0.0-test_linux_amd64.tar.gz"
if (cd "$work/artifacts" && sha256sum --check checksums.txt) > "$work/corrupt.log" 2>&1; then
  printf 'Checksum verification accepted a corrupted archive.\n' >&2
  exit 1
fi
printf 'Release archive regressions passed; foreign architecture was not executed.\n'
