# A 32-Bit OS Fails Late and Blames the Wrong Thing

## Goal

A 32-bit ARM host is told, once and early, that Switchboard needs a 64-bit OS and how to get one.
No 20-minute native compile that ends in a compiler error, no board that boots and then cannot
open a terminal, and no `Exec format error` with nothing of ours attached to it.

### The problem, and the root cause

**We ship no 32-bit target and never say so.** `client-artifacts.json` and
`pty-host-artifacts.json` both carry exactly four Linux/macOS targets — `linux-arm64`,
`linux-amd64`, `darwin-arm64`, `darwin-amd64` (plus `windows-amd64` for the client). There is no
`armhf`/`armv7` entry anywhere in the repo, and the Go launcher feature states outright that it
produces none. `package.json` declares no `cpu` and no `os` field, so npm will happily begin an
install on a platform nothing was built for.

**This matters because the claim invites it.** The board-only configuration is being positioned as
running on a 1 GB Pi, and the cheapest 1 GB Pi in a drawer is a Pi 3. A Pi 3 is ARMv8 and runs
64-bit Raspberry Pi OS fine — but Raspberry Pi OS has long defaulted to 32-bit, and plenty of
existing cards are flashed that way. The person most likely to test the claim is the person most
likely to be on the wrong OS.

**A 32-bit user hits three separate walls, in this order, and none names the cause.**

1. **`npm install` / `npx switchboard`.** `better-sqlite3` installs via
   `prebuild-install || node-gyp rebuild --release`. With no armv7 prebuild the fallback compiles
   the SQLite amalgamation on the device — slow on a Pi 3, and a hard failure when python3, make
   or g++ are absent. What the user sees is a node-gyp stack trace about a missing toolchain,
   which reads as "my Pi is missing build tools", not "this platform is unsupported".

2. **Boot, then terminals.** If Node and `better-sqlite3` do get through, the board starts.
   `targetKey()` (`src/services/ptyHostSupervisor.ts:41`) maps `process.arch` — `arm` on 32-bit —
   to `linux-arm`, the manifest has no such key, and `resolvePtyHostExecutable` throws
   `PTY host unsupported on linux-arm; manifest has no target mapping (source: manifest)`. That
   message is correct, tagged with its source, and fires at the point terminals are first needed
   rather than at boot. It is a good developer message arriving late, to a user who is not a
   developer, about a manifest they have never heard of.

3. **The Go client, if installed from a package rather than npx.**
   `resolveGoClientPath()` (`src/utils/cliPathToken.ts:101`) uses the same arch mapping, finds no
   target, and `formatCliInvocation` silently falls back to `node "<cliPath>"`. That degradation
   is correct and needs no change. But a user who reaches into `dist/linux-arm64/` and runs the
   binary directly gets `Exec format error` from their shell, with nothing of ours in the output
   at all.

### Root cause

The platform guard exists and is well built — it just lives at the **last** seam that needs it, and
speaks to the wrong audience. `resolvePtyHostExecutable` already refuses rather than substituting,
and already tags `source: 'manifest'`, which is exactly what `CLAUDE.md` asks of a routing read.
Nothing about it is wrong. What is missing is a check at the **first** seam — before npm compiles
anything, before the board binds a port — and a message written for someone holding a Raspberry Pi
rather than someone reading `pty-host-artifacts.json`.

## Non-goals

- **Building a 32-bit target.** Node stopped shipping 32-bit ARM binaries at v24 and downgraded
  armv7 to experimental; the last LTS carrying `linux-armv7l` is v22, EOL May 2027. Adding armhf
  would pin a shipped target to a runtime with under two years of life and no upgrade path, plus a
  per-Node-major `better-sqlite3` prebuild job. That is a separate decision, and this plan assumes
  the answer is no.
- **Changing `resolvePtyHostExecutable`.** It refuses correctly and tags its source. Rewriting a
  correct refusal to carry nicer prose would move user-facing copy into a resolver.
- **Changing the Go-client fallback.** Falling back to the Node invocation on an unmapped arch is
  right.
- **Supporting 32-bit at all.** The outcome here is a clear refusal, not a degraded mode.

## Metadata

**Tags:** operability, packaging, raspberry-pi, docs
**Complexity:** 2

## Scope: standalone only

`package.json`, `src/standalone/cli.ts` (boot preflight), and the install-time guard. The VS Code
extension host is out of scope — it is the legacy host being removed by the cutover, and this seam
is new, so it lands in the standalone root only. No shared service changes, so there is no
composition-root divergence to audit.

## Proposed changes

### 1. Refuse at install time, before anything compiles

Add a `cpu` field to `package.json` naming the architectures we actually ship:

```json
"cpu": ["arm64", "x64"]
```

npm then refuses with `EBADPLATFORM` naming the wanted and actual architecture, before
`better-sqlite3` starts a build that cannot succeed. This is declarative, costs nothing at runtime,
and turns the longest failure into the fastest one.

**Decide deliberately, and record the decision:** a `cpu` field gates *every* consumer of this
package, including CI runners and the extension packaging path. Confirm no build job runs on an
architecture outside the list before landing, and state in the PR which jobs were checked. A gate
that turns out to block our own release pipeline is worse than the bug it fixes.

`EBADPLATFORM` is terse, so it is a backstop for the message in change 2, not a replacement for it.

### 2. One architecture preflight at boot, with a remedy in it

At the top of the standalone entry, before any workspace resolution, port bind or database open,
check `process.arch` against the set the artifact manifests actually carry — read from the
manifests, never a second hardcoded list, so adding a target later cannot leave this check stale.

On an unsupported architecture, print one message and exit non-zero:

```
[switchboard] Unsupported architecture: linux-arm (32-bit).
Switchboard ships 64-bit builds only. On a Raspberry Pi, reflash with
Raspberry Pi OS (64-bit) — Pi 3 and newer are 64-bit capable hardware.
Detected: node 22.x, process.arch=arm, os.arch()=arm
```

Three properties that matter:

- **Name the remedy, not the mechanism.** "reflash with Raspberry Pi OS (64-bit)" is actionable;
  "manifest has no target mapping" is not.
- **Print what was detected**, so a bug report carries the facts and so a user on 64-bit hardware
  running a 32-bit userland can see which of the two is wrong.
- **Exit, do not degrade.** A board that boots without terminals is the quiet-wrong-answer shape:
  it looks like it works until the first seat.

### 3. Say it in the supported-platforms documentation

Wherever the 1 GB board-only configuration is stated, the OS requirement rides with it —
**"1 GB Pi, 64-bit OS"** — not in a footnote. The claim and its precondition are one sentence or
the claim generates the bug reports this plan exists to prevent.

## Complexity Audit

### Routine

- The `cpu` field (change 1).
- The boot preflight and its message (change 2).
- The documentation line (change 3).

### Complex / Risky

- **`cpu` gates our own pipeline too.** The only real risk here. It must be verified against every
  CI job and the extension packaging path before landing, not after.
- **Reading the supported set from the manifests** rather than hardcoding it is what keeps the
  check honest when a target is added or removed. Hardcoding a second list is the failure mode to
  avoid, and it is the easy thing to do.

## Edge-Case & Dependency Audit

- **64-bit hardware, 32-bit userland.** The common Pi case. `process.arch` reports `arm`, which is
  what we gate on and what we must print — the hardware being capable is exactly why the remedy is
  "reflash", not "buy a different Pi".
- **A future 32-bit target.** If armhf is ever added to the manifests, the preflight stops firing
  on its own, because it reads the manifests. No second edit, no stale guard left behind.
- **Explicit `artifactPath`.** `resolvePtyHostExecutable` honours an explicit path before the
  manifest lookup. A developer pointing at a hand-built binary must not be blocked by the boot
  preflight; the preflight gates the default resolution path, and an explicit override is a
  deliberate act that keeps working.
- **Non-Pi 32-bit hosts** (armv7 boards, old 32-bit x86) get the same refusal. The message names
  Raspberry Pi because that is the documented deployment, but the first line states the general
  fact before the Pi-specific remedy.
- **Security/side effects:** none. No new network, filesystem or credential surface; the preflight
  reads two manifests already read at boot.

## Dependencies

None. Independent of the remote-seat and CLI-parity work.

## Verification Plan

### Automated Tests

- **Unit** — the preflight accepts each architecture present in the manifests and refuses one that
  is absent, asserting the exit is non-zero and the message contains both the detected arch and the
  word `64-bit`.
- **Unit** — adding a synthetic target to a fixture manifest makes the preflight accept that
  architecture, proving the supported set is read and not hardcoded.
- **Unit** — an explicit `artifactPath` is not blocked by the preflight.
- **Contract** — `package.json` `cpu` lists exactly the architectures present in
  `client-artifacts.json` and `pty-host-artifacts.json`, so the three cannot drift apart.

Run `npm run compile-tests` before any `test:contract:*` script.

### Manual Verification

- On a 32-bit Raspberry Pi OS install, `npx switchboard` fails with `EBADPLATFORM` rather than a
  node-gyp toolchain error.
- With the package installed anyway (e.g. `--force`), `switchboard tailnet` prints the preflight
  message and exits non-zero without binding a port or opening the database.

### Goal Invariants

1. An unsupported architecture is refused before any native build begins.
2. The refusal names a remedy the user can act on and the architecture that was detected.
3. No board ever boots into a state where it is running but cannot open a terminal because of
   architecture.
4. The supported-architecture set has exactly one source of truth: the artifact manifests.
