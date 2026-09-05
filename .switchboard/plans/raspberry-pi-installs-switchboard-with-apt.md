# A Raspberry Pi Installs Switchboard With `apt`, Not Six Manual Steps and a Template to Hand-Edit

kanbanColumn: CREATED

## Goal

`sudo apt install switchboard` on Raspberry Pi OS leaves a running, boot-surviving board on
an arm64 Pi with no Node install, no compiler, no `npm`, and no file to hand-edit. The board
comes back after a power cut, and `apt remove` takes it away again without touching the
operator's data.

### Problem analysis

Standing this up by hand on a Pi 400 (2026-09-05/06) took Node via nvm, a native-module
rebuild, a manual `dist` copy, a board-database transfer and a hand-started process. It
works — 13 hours uptime, two agent seats, 964 MB of 3.8 GB, CPU 95% idle, 45°C, no swap and
no throttling — so the hardware case is settled. What is missing is a way for anyone,
including this operator on the next Pi, to arrive at that state without repeating the whole
sequence from memory.

**The lifecycle work is already done and is not this plan.** `standalone-daemon-lifecycle.md`
shipped `start --detach`, `stop`, `status` and logging, and its non-goals section is explicit:
supervision is delegated to systemd, and the repo ships the unit. That decision stands. This
plan does not re-open it.

**What ships today is a template, not an installer.** `docs/autostart/switchboard.systemd.service`
is a good unit — `Type=simple` with a comment explaining why `--detach` must not be passed to
systemd, `Restart=on-failure`, journald for output. But three of its lines read
`/home/YOUR_USERNAME/path/to/workspace`, and `ExecStart=/usr/bin/npx switchboard start`
assumes an `npx` on the system path. On a Pi where Node arrived through nvm, that path does
not exist, and a unit with a wrong `ExecStart` fails at boot with nothing on screen — the
operator finds out when the board is not there.

Four things then have to be true on the target Pi and none of them are guaranteed:

1. **Node ≥ 22 on a path systemd can see.** nvm installs to `~/.nvm/versions/node/<v>/bin`,
   which is added by an interactive shell profile. A systemd unit and a non-interactive `ssh`
   both get a PATH without it. This bit during setup: `ssh pi 'node -v'` failed while an
   interactive session on the same box worked.
2. **`better-sqlite3` built for arm64.** It is the only database driver now that sql.js is
   gone from production, so a missing build is a board that cannot start.
3. **`node-pty` built for arm64.** It sits in `optionalDependencies`, so npm **succeeds** when
   its build fails. The install looks clean, the board starts, and every terminal is dead.
   This is the single worst failure available on this platform and nothing currently catches it.
4. **A workspace to serve**, which is operator data and cannot be guessed.

**Why a Debian package rather than a shell installer.** Raspberry Pi OS is Debian. `apt` already
solves what a `curl | bash` script re-implements badly: declared dependencies, an upgrade path,
a clean removal, a package manager that knows what it put where, and no piping the network to a
root shell. `debhelper` installs and enables the systemd unit as part of the package, which is
the step operators most often get wrong by hand. The package vendors `node_modules` built for
arm64 at **package-build** time, so no target Pi ever needs a compiler.

## Metadata

- **Complexity:** 7
- **Tags:** standalone, packaging, raspberry-pi, devops, infrastructure

## User Review Required

None. Three decisions are made here rather than deferred: the format is a `.deb`, the native
modules are vendored at build time rather than compiled on the Pi, and the package depends on
distro Node rather than bundling a runtime.

## Proposed Changes

### 1. An arm64 `.deb` that carries its own dependencies

Add a `packaging/debian/` tree and a `npm run package:deb` target producing
`switchboard_<version>_arm64.deb`.

- **Contents:** the built `dist/`, the `bin` entry, and a vendored `node_modules` with
  `better-sqlite3` and `node-pty` compiled for `linux/arm64`. Installed under
  `/usr/lib/switchboard`, with `/usr/bin/switchboard` as the entry point.
- **`Depends: nodejs (>= 22)`.** Do not bundle a Node runtime — that is a second runtime to
  patch, and Raspberry Pi OS packages a current one. Declaring it means `apt` refuses an
  install that cannot work, instead of installing something that fails at first boot.
- **`Architecture: arm64`.** The Pi 400 and every Pi 4/5 run arm64. Do not claim `all`.
- **Build on arm64.** Native modules cannot be cross-compiled reliably; build the package on a
  Pi or an arm64 runner.

### 2. Fail the package build when a native module is missing

The build must `require()` both `better-sqlite3` and `node-pty` out of the vendored tree and
abort if either throws. `node-pty` being optional means its absence is otherwise silent all
the way to a user whose terminals do not work, with a board that starts perfectly and reports
nothing wrong.

This is the fallback rule applied to packaging: an optional dependency that silently resolves
to "absent" is a default that behaves like a configured value. Make it loud at build time,
where it costs a rebuild, rather than at run time, where it costs a debugging session.

### 3. A resolved unit, not a template

`debhelper` installs a real unit file at package build time — no placeholders reach the Pi.
Everything operator-specific moves to `/etc/switchboard/switchboard.env`, marked `conffile` so
`apt` preserves operator edits across upgrades:

```
SWITCHBOARD_WORKSPACE=
SWITCHBOARD_PORT=7777
SWITCHBOARD_SERVE_MODE=tailnet      # local | tailnet — selects the subcommand, not a flag
SWITCHBOARD_EXTRA_PATH=
```

**`SWITCHBOARD_SERVE_MODE` names a subcommand, and the unit must treat it as one.** There is no
bind flag: `cli.ts` chooses the serve mode from `process.argv[2]` — `switchboard local` serves
loopback, `switchboard tailnet` serves loopback plus the Tailscale interface — and strips the
subcommand before parsing options. So `ExecStart` interpolates the value as the first argument.
Validate it at setup against exactly those two words; anything else must fail loudly there rather
than produce a unit that exits on every start.

The unit keeps every decision the existing template documents — `Type=simple`, no `--detach`,
`Restart=on-failure`, journald — and adds two the Pi needs:

- **`EnvironmentFile=/etc/switchboard/switchboard.env`** and an `ExecStart` reading from it —
  `/usr/bin/switchboard $SWITCHBOARD_SERVE_MODE --port $SWITCHBOARD_PORT --no-open --workspace
  $SWITCHBOARD_WORKSPACE`. **It must not say `start`.** That subcommand was removed: `cli.ts:2616`
  prints *"'start' has been replaced"* and exits 1. With `Restart=on-failure` a unit built around
  it never serves and eventually lands in `failed`. The template shipped in `docs/autostart/`
  still uses it — filed separately; this package must not copy it.
- **`User=` and `Environment=HOME=`** set to the resolved service user. The board writes to
  `~/.switchboard/boards/`, so a unit without `HOME` resolves that to the wrong tree and creates a
  second, empty board — the same class of silent wrong answer as a stale path, and just as hard to
  see from the UI.
- **`TimeoutStopSec=15` with the default `KillMode=control-group`,** so systemd escalates to
  `SIGKILL`. `switchboard stop` is known to free the port and log "Server stopped" while the
  process never exits; without a stop timeout, a restart hangs and the reboot the operator is
  counting on does not complete.

`SWITCHBOARD_EXTRA_PATH` is prepended to the unit's `PATH` and exists for the agent CLIs, which
live in per-user directories the package cannot know.

### 4. `switchboard setup host` — one interactive command, run once

The package installs disabled. Enabling it needs a workspace, and a workspace is operator data.

**It is `setup host`, not `setup`, because `setup` is already taken.** `cli.ts:2897` makes `setup`
a namespace that delegates to `init`, `scaffold` and `control-plane` by rewriting `process.argv`.
Adding a bare `switchboard setup` would collide with a shipped command; `host` is a fourth member
of a namespace that already exists, which is cheaper than a new top-level verb and reads correctly
next to its siblings.

`switchboard setup host` collects the following and writes the env file:

- Prompt for the workspace root; verify it exists and is a directory. Do not create it, and do
  not default to the current directory — a board pointed at the wrong tree is silent and wrong.
- Resolve the **service user** from who invoked the command (`SUDO_USER`, else the current
  user). Never assume `pi`; a modern Raspberry Pi OS image has no such account.
- Resolve Node: prefer the packaged dependency, and if the operator's Node came from nvm,
  record its **absolute** path in the env file rather than relying on PATH.
- Report each resolved value and where it came from before writing, so a wrong guess is visible
  at setup rather than at boot.
- Then `systemctl enable --now switchboard`, and print the tailnet URL.

Re-running it is a reconfigure, not an error.

### 5. Importing an existing board must stop the service first

`switchboard setup host --import <path>` moves an existing board database onto the Pi. It **must**
stop the service before touching the file and start it afterwards.

This is not hypothetical. Copying a board database over a path whose board was running
orphaned that board onto an unlinked inode: the process kept writing to a file with no name,
the on-disk copy silently diverged, and every board read stayed correct right up until a
restart would have discarded the lot. The failure is completely invisible while the process
lives. A rename over a live database is the mechanism, so the import path must refuse to run
against a live service rather than trusting itself to be careful.

### 6. `apt remove` leaves the data; `apt purge` asks

Removal stops and disables the service and deletes `/usr/lib/switchboard`. It must not touch
`~/.switchboard/`, the board databases, or the workspace. `purge` additionally removes
`/etc/switchboard/`. Nothing removes a board database — that is the operator's, and a package
manager is the last thing that should decide otherwise.

## Edge-Case & Dependency Audit

1. **This provisions the standalone host, and that is the whole of it.** There is no extension
   composition root on a Pi — the VSIX is not installed there. The parity obligation still
   applies to what the *installed board* wires: the package must serve the standalone
   entry point, and any seam it configures has to match what `src/standalone/bootstrap.ts`
   wires, not what `src/extension.ts` does. If a future subtask adds a seam here, it lands in
   both roots or it is a divergence.
2. **This is the tier-3 artifact of the paired-app feature's distribution rule.** That plan
   forbids anything persistent from leaking into `npx`, permits a unit file behind a typed
   `switchboard remote install`, and allows a real package-manager artifact to persist everything
   "because the operator downloaded an application". A `.deb` is that third tier. It must be
   offered, never installed as a side effect of a first run.
3. **Relationship to B4 (`9329d926`, npx distribution).** B4 publishes the CLI to npm and owns
   the package-name decision. The `.deb` should carry the same name once B4 settles it, but
   does not depend on B4 landing — it packages from the repo. Do not block on it, and do not
   pre-empt the naming decision.
4. **Node from the distro can lag.** If Raspberry Pi OS ships Node < 22, `Depends` blocks the
   install with a clear message — correct behaviour, but the docs need to name NodeSource as
   the way out.
5. **arm64 only.** A Pi Zero 2 W or a 32-bit OS image is `armhf` and will refuse to install.
   That is the right answer for now; say so in the description rather than shipping a build
   that fails at first start.
6. **The SD-card write load is real but out of scope.** 17.5 GB written in 13 hours on this
   Pi, from WAL, logs and plan churn. The package should not try to solve it; a note in the
   docs recommending USB/SSD root is enough, and the unit's journald output is already
   log-rotated by systemd.
7. **A second board on the same workspace.** Single-writer-per-workspace is enforced by
   `findRunningInstance` and stays enforced. `setup` must surface that refusal rather than
   installing a service that will fail on every start.
8. **A second `switchboard` on PATH.** An operator who already installed the CLI through npm or
   nvm — as this Pi did — ends up with `/usr/bin/switchboard` from the package and another on the
   shell's PATH, and which one answers depends on PATH order. `setup host` must report the
   absolute path it resolved and warn when a second one exists. The unit always uses the absolute
   `/usr/bin/switchboard`, never a PATH lookup.
9. **debhelper starts services by default.** `dh_installsystemd` enables and starts a unit on
   install unless told otherwise. The package must pass `--no-start --no-enable`, or the "installs
   disabled" contract in change 4 is not what actually ships.
10. **Tailnet binding assumes Tailscale is up.** The unit needs `After=network-online.target`
   and, when `SWITCHBOARD_BIND=tailnet`, `After=tailscaled.service` — otherwise the board
   starts before the tailnet address exists and binds to nothing reachable.

## Verification Plan

1. On a fresh Raspberry Pi OS arm64 image with no Node, no compiler and no repo:
   `sudo apt install ./switchboard_<v>_arm64.deb` succeeds, and the service is installed and
   **not** running.
2. `switchboard setup host` prompts for a workspace, reports each resolved value with its source,
   writes `/etc/switchboard/switchboard.env`, enables the service, and prints a URL that loads
   the board from another machine on the tailnet.
3. `sudo reboot` — the board is serving again with no login and no manual step.
4. Terminals work: a seat spawns a PTY and an agent CLI runs in it. This is the `node-pty`
   check and it must be done on the target Pi, not on the build host.
5. A package built with `node-pty` deliberately removed **fails the build**, and the failure
   names the module.
6. `switchboard setup host --import <db>` against a running service stops it, imports, restarts,
   and the imported cards are served. Attempting the same import with the stop step removed
   leaves the service on a deleted inode — assert the guard by checking
   `/proc/<pid>/fd` reports no `(deleted)` database handle after an import.
7. `systemctl stop switchboard` returns within `TimeoutStopSec`, and no `switchboard` process
   survives it.
8. `apt remove` stops the service and leaves `~/.switchboard/` and the workspace intact;
   `apt purge` additionally removes `/etc/switchboard/` and still leaves the board databases.
9. `apt install` of a newer version over a configured install preserves the env file and the
   board data, and the service comes back on the new version.
