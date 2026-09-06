# Debian packaging

`scripts/package-deb.sh` builds the package with `dpkg-deb` directly. It is the
only builder — there is no `debian/rules` and no debhelper run.

A `debian/rules` + `debian/control` pair used to sit here alongside it. Both
were dead: nothing invoked `dh`, so `override_dh_installsystemd`'s
`--no-start --no-enable` never ran, and `rules` wrote `DEBIAN/conffiles` into a
directory `dh_installdeb` had not created yet. Two packaging mechanisms where
only one runs is how a fix lands in the half that is never executed — so the
unused half is gone rather than kept "for later". If a full debhelper build is
ever wanted, add it *instead of* `package-deb.sh`, not beside it.

The package supports **Debian-compatible `amd64` and `arm64`**. There is no
macOS package, Homebrew formula, or Windows package in this plan.

Files here that ARE used:

| File | Installed as | Purpose |
|---|---|---|
| `switchboard.service` | `/lib/systemd/system/switchboard.service` | Base unit. `ExecStart` runs `switchboard service --no-open`; the `EnvironmentFile` exports `SWITCHBOARD_*` values that the service subcommand reads as `legacy-env` fallbacks. An `ExecStartPre` refuses to start unconfigured. |
| `switchboard.env` | `/etc/switchboard/switchboard.env` (conffile) | Workspace, port, serve mode, user, extra PATH. Read by the unit's `EnvironmentFile` as a tagged fallback; the durable `~/.switchboard/host-settings.json` wins when present. |
| `postinst` / `prerm` / `postrm` | `DEBIAN/` | Install disabled; stop and disable on remove; drop `/etc/switchboard` on purge. Never touch board databases. |

`switchboard setup host` writes the drop-in
`/etc/systemd/system/switchboard.service.d/10-setup.conf`, which carries the
settings systemd will **not** expand `${VAR}` in — `User=`,
`WorkingDirectory=`, `Environment=HOME=`, `Environment=PATH=`. Interpolation
works in command lines only; putting `${SWITCHBOARD_USER}` in `User=` yields a
unit that fails to start with a username spelled `${SWITCHBOARD_USER}`.

## Building a package

Build on a **native** host of the target architecture. Native modules
(`better-sqlite3`, `node-pty`, the Go PTY host, the Go launcher) cannot be
cross-compiled reliably, so `package-deb.sh` detects the architecture from
`dpkg --print-architecture` and `process.arch`, requires them to agree, and
stamps `Architecture:` from the detected value. An optional
`--expect-arch` argument is an assertion that fails on mismatch — it never
supplies package metadata.

```sh
# On an amd64 host (the x86 tower):
scripts/package-deb.sh --expect-arch=amd64

# On an arm64 host (a Pi 4/5):
scripts/package-deb.sh --expect-arch=arm64
```

Output lands at `releases/deb/<version>/<arch>/switchboard_<version>_<arch>.deb`
with a sidecar `*.manifest.json` recording version, detected architecture,
Node version, source revision, and the final SHA-256. The repository builder
consumes both to reject a mixed-version or mixed-revision release set.

## Node prerequisite

The package declares `Depends: nodejs (>= 22)`. Stock Debian 13 (trixie) /
Raspberry Pi OS ships **Node 20.19.2**, which does **not** satisfy this
dependency. Install Node 22 from the NodeSource apt repository on **both**
architectures before installing Switchboard.

> Do **not** use `nvm` to satisfy the apt dependency. `nvm` installs into a
> shell startup file that `apt` and `systemd` cannot see; `apt install
> switchboard` will still fail with an unmet `nodejs` dependency even if
> `node --version` reports 22 in your shell. The NodeSource package installs
> an apt-visible `nodejs` that satisfies the dependency.

### Install Node 22 from NodeSource (amd64 and arm64)

NodeSource's setup script explicitly supports `amd64` and `arm64`, emits a
deb822 `nodistro` source, and installs an apt-visible `nodejs` package.

```sh
# 1. Download the NodeSource setup script and inspect it before running.
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh

# 2. Run it. It adds the NodeSource apt source and signing key.
sudo bash /tmp/nodesource_setup.sh

# 3. Verify the apt-visible nodejs version BEFORE installing Switchboard,
#    so a failure names the missing prerequisite instead of ending as a bare
#    dependency-resolution error.
apt-cache policy nodejs          # should show a 22.x candidate
node --version                   # should print v22.x (apt-visible, not nvm)
```

If `apt-cache policy nodejs` does not show a 22.x candidate, the NodeSource
source was not added — re-run the setup script and check for errors. Do **not**
proceed to install Switchboard until `apt` can see Node 22.

## Repository installation

The signed apt repository is published through GitHub Pages under an `apt/`
prefix. The exact origin is resolved by the publisher through the GitHub API
and recorded in the release manifest; the steps below use a placeholder
`<REPO_ORIGIN>` that you replace with the origin printed on the release page.

### 1. Install the public key

Put the ASCII-armored public key at
`/etc/apt/keyrings/switchboard-archive-keyring.asc`. This directory is for
operator-managed keys; `/usr/share/keyrings` is reserved for a future
package-managed keyring. The `.asc` extension matches the armored encoding.

```sh
sudo mkdir -p /etc/apt/keyrings
sudo curl -fsSL <REPO_ORIGIN>/switchboard-archive-keyring.asc \
  -o /etc/apt/keyrings/switchboard-archive-keyring.asc
sudo chmod 0644 /etc/apt/keyrings/switchboard-archive-keyring.asc
```

> Do **not** use `apt-key`. It is deprecated and installs keys into the global
> trust store. The deb822 `Signed-By` field below scopes trust to this
> repository only.

### 2. Verify the key fingerprint

The release page prints the full 40-character OpenPGP fingerprint. Verify the
downloaded key matches it **before** adding the source:

```sh
FINGERPRINT="<40-character-fingerprint-from-the-release-page>"
gpg --show-keys /etc/apt/keyrings/switchboard-archive-keyring.asc
# Compare the printed fingerprint to $FINGERPRINT. They must match exactly.
```

### 3. Add the deb822 source

Create `/etc/apt/sources.list.d/switchboard.sources` (deb822 format). Trixie's
apt supports deb822 `.sources`. Use `Signed-By` pointing only at the
Switchboard keyring.

```sh
sudo tee /etc/apt/sources.list.d/switchboard.sources >/dev/null <<'EOF'
Types: deb
URIs: <REPO_ORIGIN>
Suites: stable
Components: main
Architectures: amd64 arm64
Signed-By: /etc/apt/keyrings/switchboard-archive-keyring.asc
EOF
```

> Replace `<REPO_ORIGIN>` with the origin printed on the release page (e.g.
> `https://<owner>.github.io/switchboard/apt`). Do **not** ship a literal
> placeholder as runnable guidance — fill in the real origin.

### 4. Install

```sh
sudo apt update
sudo apt install switchboard
```

`apt` selects the matching architecture automatically. After install:

```sh
switchboard setup host   # collect workspace, port, serve mode; enable the unit
```

## Direct `.deb` installation (no repository)

`apt install ./file.deb` works without a signature or a repository. Use this
when you do not want to add the repository.

```sh
sudo apt install ./switchboard_<version>_<arch>.deb
switchboard setup host
```

> `apt install ./file.deb` resolves local dependencies from configured
> sources, so the NodeSource prerequisite above is still required.

## Upgrades

If you installed from the repository:

```sh
sudo apt update
sudo apt upgrade switchboard
```

`apt upgrade` preserves service configuration (`/etc/switchboard/switchboard.env`
is a conffile) and board data (`~/.switchboard/`, workspace board databases).
The repository retains older package payloads long enough for clients that
have not yet refreshed; garbage collection is a separate explicit release
operation, not an incidental rebuild.

If you installed directly from a `.deb`, download the newer `.deb` and
`apt install ./switchboard_<new-version>_<arch>.deb` — `apt` upgrades in place.

## CPU architecture vs `uname -m` naming

Debian and `uname -m` use different names for the same architecture:

| Debian (`dpkg --print-architecture`) | `uname -m` |
|---|---|
| `amd64` | `x86_64` |
| `arm64` | `aarch64` |

Pick the `.deb` whose filename ends in your **Debian** architecture
(`_amd64.deb` or `_arm64.deb`). If you are unsure:

```sh
dpkg --print-architecture
```

## Recovery

### Missing Node

`apt install switchboard` fails with `Depends: nodejs (>= 22)`:

- Install Node 22 from NodeSource (above). Do not use `nvm`.
- Verify with `apt-cache policy nodejs` and `node --version` **before**
  retrying.

### Signature failure

`apt update` reports a signature verification error:

- Re-download the public key and re-verify the fingerprint (steps 1–2 above).
- Confirm `/etc/apt/sources.list.d/switchboard.sources` points `Signed-By` at
  the correct keyring path.
- Confirm the fingerprint in the key matches the release page. If the signing
  key was rotated, the release page prints the new fingerprint.

### Wrong architecture

`apt install` reports `package architecture (amd64) does not match system
(arm64)` (or the reverse):

- You are on the wrong machine or downloaded the wrong `.deb`. Check
  `dpkg --print-architecture` and pick the matching file. The repository
  installs the correct architecture automatically; this only happens with
  direct `.deb` installation.

### Repository unavailable

`apt update` cannot reach the repository:

- The GitHub Pages deployment may be down or the origin may have moved. The
  release page prints the current origin. Direct `.deb` installation from the
  GitHub Release assets always works without the repository.
