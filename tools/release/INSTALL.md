# Installing a Keelbox binary

Keelbox is licensed under Apache License 2.0; see LICENSE and NOTICE.
Building archives does not publish a release. There is currently no published
release promised by this document.

Build targets: Linux amd64 (x86-64 baseline) and Linux arm64 (ARMv8 baseline),
CGO disabled. Native workflow validation currently covers amd64 only; arm64
is cross-built, not yet validated against Docker/kind. macOS, Windows, 32-bit
systems and other architectures are unsupported. Docker Engine must use a local
Unix socket. Go is not required on the user's machine.

Obtain the chosen version's archive and checksums from the same trusted source.
Checksums detect corruption, not a malicious distributor; verify provenance
before execution. In their download directory, verify all downloaded archives
against their respective entries in checksums.txt (or download both targets):

```sh
sha256sum --check --ignore-missing checksums.txt
version=v0.1.0 # substitute the downloaded version
arch=amd64 # arm64 on a compatible machine
tar -xzf "keelbox_${version}_linux_${arch}.tar.gz"
mkdir -p "$HOME/.local/bin"
install -m 0755 "keelbox_${version}_linux_${arch}/keelbox" "$HOME/.local/bin/keelbox"
export PATH="$HOME/.local/bin:$PATH"
keelbox --version
keelbox --help
```

Keep the archive's license and notice files with any redistributed binary.
Install Docker Engine, kind, kubectl and Helm 3 separately; Keelbox does not
install them or change permissions. With a configured project, run:

```sh
keelbox doctor --config /path/to/keelbox.yaml
keelbox up -d --config /path/to/keelbox.yaml
```

`doctor` checks prerequisites without creating a cluster. A missing prerequisite
is a diagnostic failure, not a successful application test. Check README.md for
configuration and lifecycle semantics. `up` runs trusted project build inputs.
